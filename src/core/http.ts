/**
 * 唯一的 HTTP 出口。
 *
 * 所有源都必须经过这里，原因不是「代码整洁」，而是几个真实踩过的坑：
 *   1. **无超时 = 工具卡死**。国内站点偶发挂起，模型会干等；
 *   2. **无 UA = 被拒**。部分站点的 WAF 直接掐掉空 UA / curl UA；
 *   3. **重试不分类 = 越重试越糟**。4xx 重试只会重复挨骂，只有网络错误 / 5xx / 429 值得退避重试；
 *   4. **无视 Retry-After = 把限流打成更重的限流**。Strawberry 的文档明确写了
 *      「HTTP 429 includes Retry-After: 60」，按自己的节奏重试等于继续挨打；
 *   5. **重试无总上限 = 单次调用能拖到一分多钟**，客户端早就超时了，我们还在这儿退避。
 *
 * 代理：本文件**不内置代理实现**。Node ≥ 24 支持 `NODE_USE_ENV_PROXY=1`
 * 走系统 HTTPS_PROXY，够用，不为此引依赖。见 README「代理」一节。
 */

import { UpstreamError } from './errors.js';
import { utf8Bytes } from './format.js';
import type { Fetcher, HttpOptions, HttpResult } from './types.js';

/** 唯一 UA。带上工具名，出问题时对方站点日志里能看出是我们。 */
export const USER_AGENT = 'plant-omics-mcp/0.1 (research aggregation; see README)';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
/**
 * 确定性退避：`BACKOFF_MS[0]` 是**第 1 次重试前**等多久，不是第 1 次请求前。
 * （原先写成 [0,400,1200] 再按 attempt-1 取，导致首重试不等待、1200 档永不生效。）
 */
const BACKOFF_MS = [400, 1_200];
/** 单次调用（含所有重试与退避）的总时长上限。超过就放弃，把决定权交回调用方。 */
const MAX_TOTAL_MS = 45_000;
/** 服务端说的 Retry-After 再长，我们也不等超过这么久——否则一次工具调用能挂死整个会话。 */
const MAX_RETRY_AFTER_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Combined {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

/**
 * 把「调用方的取消信号」与「本次请求的超时」合成一个。
 *
 * 不用 AbortSignal.any：它的类型在纯 ES lib 下不保证可见，
 * 且这里还需要知道「到底是超时还是调用方取消」，否则报错话说不到点上。
 */
function combineSignals(external: AbortSignal | undefined, timeoutMs: number): Combined {
  const controller = new AbortController();
  let timeoutHit = false;

  const onExternalAbort = () => controller.abort();

  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timeoutHit = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timeoutHit,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * 这次重试前该等多久。
 *
 * 单独导出是为了**可测**：用墙钟时间断言延迟既慢又不稳，
 * 而这段逻辑一旦算错（比如把 Retry-After 的秒当成毫秒），表现是"越限流越猛"。
 */
export function retryDelayMs(retryIndex: number, status?: number, retryAfter?: string | null): number {
  const index = Math.max(0, retryIndex - 1);
  const base = BACKOFF_MS[Math.min(index, BACKOFF_MS.length - 1)] ?? 0;
  if (status === 429 || status === 503) {
    const seconds = Number(String(retryAfter ?? '').trim());
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }
  }
  return base;
}

/**
 * 502/503/504 与 4xx 的语义分开报：这类状态说明**上游或代理层面返回了 5xx**，不是"记录不存在"。
 * 依据是 2026-10-27 实测：WheatOmics 静态首页 200、而 `/api/*` 全部 503（Apache 返回）。
 *
 * **但原因不许替上游断言**：重启、过载、链路、本机出口都可能，观测不到就不能写。
 * 文案只写「状态 + 已重试仍失败 + 原因未验证 + 可稍后重试」（AGENTS §十一）。
 */
function httpMessage(status: number): string {
  if (status === 502 || status === 503 || status === 504) {
    return `上游后端暂时不可用（HTTP ${status}，来自上游或反向代理层面）；已按退避重试仍失败，上游与本机链路的原因均未验证，可稍后重试`;
  }
  if (status === 429) return '上游限流（HTTP 429），本工具会按 Retry-After 退避重试，仍失败请降低调用频率';
  if (status === 404) return '上游 404：端点或记录不存在（源改版时也会这样）';
  if (status === 403) return '上游 403：被 WAF/Cloudflare 拦截，或需要鉴权';
  return `上游返回 HTTP ${status}`;
}

/** 上游正文可能很长，错误信息里只留开头，避免把 HTML 整页塞进上下文。 */
function snippet(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * 上游响应原体的保留上限（**UTF-8 字节**，与输出预算同一把尺子）。
 *
 * 为什么不能只用 `snippet()`：它会把空白压平成一行，上游若在 JSON 字符串里塞了
 * 非法换行，压平后反而变成合法 JSON，进而被错判成「查无」（审查 ENSP-02 反例）。
 * 源层要做严格结构判定，就必须拿到**未经处理**的正文，所以原体原样保留。
 *
 * 为什么还要设上限：上游正文实测可达 1.9 MB（Ensembl Plants `feature=variation`
 * 50 kb 区间），整段留在错误对象里既占内存、又给"顺手打印一下"留下口子。超出即截断，
 * 并置 `rawBodyTruncated`。**截断即不可判定**：源层见到该标记必须放弃结构判定、
 * 按未知抛错，不许靠"截断后恰好解析失败"侥幸兜住。
 */
export const RAW_BODY_LIMIT_BYTES = 4096;

/** 原样保留正文（不压平、不裁剪空白）；超上限才截断，且按字符边界截，不乱码。 */
function captureRawBody(text: string): { rawBody: string; rawBodyTruncated?: boolean } {
  if (utf8Bytes(text) <= RAW_BODY_LIMIT_BYTES) return { rawBody: text };
  // 先按字符数粗裁（UTF-8 最长 4 字节/字符），再回退进字节上限：
  // 直接对 1 MB 级正文逐字符试探会白烧 CPU。
  let cut = Math.min(text.length, RAW_BODY_LIMIT_BYTES);
  while (cut > 0 && utf8Bytes(text.slice(0, cut)) > RAW_BODY_LIMIT_BYTES) cut -= 1;
  return { rawBody: text.slice(0, cut), rawBodyTruncated: true };
}

export interface FetchJsonConfig {
  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
  /** 单次调用（含重试与退避）的总时长上限 */
  maxTotalMs?: number;
}

/**
 * 造一个 fetcher。允许注入 `fetch` 是为了测试：单元测试用 mock，
 * 不必联网、也不会因为上游改版而红。
 */
export function createFetcher(
  config: FetchJsonConfig = {},
  // 惰性转发，不在模块初始化时把 globalThis.fetch 拷走：
  // 拷走之后测试再怎么替换 globalThis.fetch 都无效（这里踩过一次），
  // 而且宿主若在运行期注入自己的 fetch，拷走的版本会一直是旧的。
  fetchImpl: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): Fetcher {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = config.retries ?? DEFAULT_RETRIES;
  const maxTotalMs = config.maxTotalMs ?? MAX_TOTAL_MS;
  const userAgent = config.userAgent ?? USER_AGENT;

  return async function fetchJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<HttpResult<T>> {
    const attemptsAllowed = (opts.retries ?? retries) + 1;
    const started = Date.now();
    let lastError: UpstreamError | undefined;

    for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
      if (opts.signal?.aborted) {
        throw new UpstreamError('调用方已取消本次请求', { url, attempts: attempt - 1 });
      }

      // 退避放在"决定要不要再来一次"之后，这样第一次请求不用等。
      if (attempt > 1 && lastError) {
        const delay = retryDelayMs(attempt - 1, lastError.meta.status, lastError.meta.retryAfter);
        const elapsed = Date.now() - started;
        if (elapsed + delay > maxTotalMs) {
          throw new UpstreamError(
            `${lastError.message}（已重试 ${attempt - 1} 次，累计 ${elapsed} ms，达单次调用上限 ${maxTotalMs} ms）`,
            {
              url,
              status: lastError.meta.status,
              attempts: attempt - 1,
              bodySnippet: lastError.meta.bodySnippet,
              retryAfter: lastError.meta.retryAfter,
              // 原体随最后一次尝试一起交出去：源层的结构判定不该因为"再试了一次"而拿不到原体。
              rawBody: lastError.meta.rawBody,
              rawBodyTruncated: lastError.meta.rawBodyTruncated,
            },
          );
        }
        await sleep(delay);
      }

      // 单次请求的超时必须**服从剩余预算**：否则 3 次 × 20 s 的超时叠起来
      // 就是 60 s，文件头承诺的 45 s 上限根本没生效（审查 P1）。
      const remaining = maxTotalMs - (Date.now() - started);
      if (remaining <= 0) {
        throw new UpstreamError(`单次调用已达 ${maxTotalMs} ms 上限，放弃本次请求`, {
          url,
          status: lastError?.meta.status,
          attempts: attempt - 1,
        });
      }
      const attemptTimeout = Math.max(500, Math.min(opts.timeoutMs ?? timeoutMs, remaining));

      const combined = combineSignals(opts.signal, attemptTimeout);
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'follow',
          signal: combined.signal,
          headers: {
            accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
            'user-agent': userAgent,
            ...opts.headers,
          },
        });

        const body = await response.text();
        const durationMs = Date.now() - started;
        const contentType = response.headers.get('content-type') ?? '';

        if (!response.ok) {
          const message = response.status === 404 && contentType.toLowerCase().includes('text/html')
            ? '上游404 HTML兜底：未找到或路径不支持，无法据此判断基因是否存在'
            : httpMessage(response.status);
          // 错误文案**只由本文件的分类函数生成**，不带任何上游可控文本。
          // 2026-10-30 止血：此前 `400 + application/json + 正文含 message` 会把上游 `message`
          // 截 180 字符拼进错误文本，理由是「参数哪里不对只有对面知道」。该例外已去掉——
          // 上游可控文本一旦进模型上下文就是注入面，对面可以往 `message` 里塞指令；
          // 换来的只是「参数哪里不对」这一句提示，不值得。
          // 上游原文没有丢：它仍在 `meta.bodySnippet`（只给程序和日志看，不进模型可见文本）。
          // 日后若确实需要「参数怎么改」的提示，按固定顺序接：先本地校验早知道 → 再考虑
          // **允许清单**清洗（长度上限、仅可打印字符、剥离换行与控制字符、不含 URL 与命令形态），
          // 不许写成「去掉几个坏字符」的黑名单。
          const error = new UpstreamError(message, {
            url,
            status: response.status,
            attempts: attempt,
            bodySnippet: snippet(body),
            // 原体给源层做严格结构判定用（合法查无 vs 参数错误 vs 畸形响应）。
            // 它**不进模型可见文本**：唯一出口 describeError() 只拼 message 与元数据，
            // 不拼 rawBody（test/http.test.ts 的哨兵组就是钉这条的）。
            ...captureRawBody(body),
            retryAfter: response.headers.get('retry-after'),
            contentType,
          });
          if (isRetryableStatus(response.status) && attempt < attemptsAllowed) {
            lastError = error;
            continue;
          }
          throw error;
        }

        let parsed: T;
        try {
          parsed = (body.length ? JSON.parse(body) : {}) as T;
        } catch {
          throw new UpstreamError('上游返回的不是合法 JSON', {
            url,
            status: response.status,
            attempts: attempt,
            bodySnippet: snippet(body),
            ...captureRawBody(body),
            contentType,
          });
        }

        return { data: parsed, url, status: response.status, durationMs, attempts: attempt, contentType,
          bodyKind: body.length === 0 ? 'empty' : 'json' };
      } catch (error) {
        if (error instanceof UpstreamError) throw error;

        // 分清「调用方取消」「超时」「连不上」——三种情况该采取的动作完全不同
        const cancelled = opts.signal?.aborted === true;
        const wrapped = new UpstreamError(
          cancelled ? '调用方已取消本次请求' : combined.timedOut() ? '上游请求超时' : '无法连接上游',
          {
            url,
            attempts: attempt,
            bodySnippet: error instanceof Error ? error.message : String(error),
          },
        );

        if (!cancelled && attempt < attemptsAllowed) {
          lastError = wrapped;
          continue;
        }
        throw wrapped;
      } finally {
        combined.cleanup();
      }
    }

    throw lastError ?? new UpstreamError('上游请求失败', { url, attempts: attemptsAllowed });
  };
}

/** 生产环境用的默认 fetcher。 */
export const fetchJson: Fetcher = createFetcher();

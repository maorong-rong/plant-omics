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
 * 502/503/504 一律是**对面后端**的问题，不是本工具的配置问题。
 * 这条区分是实测逼出来的：2026-10-27 WheatOmics 的静态首页 200、
 * 而 `/api/*` 全部 503（Apache 返的），此时报「HTTP 503」用户会去查自己的网。
 */
function httpMessage(status: number): string {
  if (status === 502 || status === 503 || status === 504) {
    return `上游后端暂时不可用（HTTP ${status}，反向代理层面返回）——通常是对面接口服务在重启或过载，不是本工具配置问题，稍后重试`;
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
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
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

        if (!response.ok) {
          const error = new UpstreamError(httpMessage(response.status), {
            url,
            status: response.status,
            attempts: attempt,
            bodySnippet: snippet(body),
            retryAfter: response.headers.get('retry-after'),
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
          });
        }

        return { data: parsed, url, status: response.status, durationMs, attempts: attempt };
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

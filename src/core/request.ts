import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from './errors.js';
import { DEFAULT_MAX_BYTES, provenance, truncateToBytes, utf8Bytes } from './format.js';
import type { HttpResult, ToolContext, ToolResult } from './types.js';

export const MAX_REQUEST_BYTES = 1536;
export const MAX_TAIL_BYTES = 2560;
export const MAX_BODY_BYTES = 1408;
const MARKER = '\n…（正文已按 4 KB 上限截断；请缩小查询范围或分批查询）';

export interface PreparedRequest {
  readonly url: string;
  readonly sourceName: string;
  /** 完整实际请求，含所有上游参数与本地呈现选项。 */
  readonly request: string;
}

/** 必须在任何网络调用之前执行。禁止截断/哈希代替关键参数。 */
export function prepareRequest(input: {
  url: string;
  sourceName: string;
  presentation?: Record<string, unknown>;
}): PreparedRequest {
  const url = new URL(input.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new InvalidArgumentError('请求URL必须是无凭据、无片段的HTTP(S)地址');
  }
  const local = input.presentation ? `；呈现参数=${JSON.stringify(input.presentation)}` : '';
  const request = `GET ${url.href}${local}`;
  const bytes = utf8Bytes(request);
  if (bytes > MAX_REQUEST_BYTES) {
    throw new InvalidArgumentError(`完整请求证据 ${bytes} UTF-8字节，超过 ${MAX_REQUEST_BYTES} 字节上限；请缩短筛选或拆分查询（尚未联网，未省略参数）`);
  }
  // 为响应自身版本等额外元数据留足768字节；状态/耗时使用安全上界。
  const reserved = provenance({ sourceName: input.sourceName, request, status: 999,
    durationMs: Number.MAX_SAFE_INTEGER, at: '9999-12-31T23:59:59.999Z', extra: 'x'.repeat(768) });
  if (utf8Bytes(reserved) > MAX_TAIL_BYTES) {
    throw new InvalidArgumentError('完整出处预留超出2560字节，请缩短请求或源名（尚未联网）');
  }
  return Object.freeze({ url: url.href, sourceName: input.sourceName, request });
}

// 仅按单次执行上下文关联预检证据；不用全局“最近请求”变量。
const executionRequests = new WeakMap<ToolContext, PreparedRequest>();

/** 包住取数后的解析/字段校验；保留错误实例及子类型，只补同URL的完整证据。 */
export async function withRequestEvidence<T>(ctx: ToolContext, run: (scoped: ToolContext) => Promise<T>): Promise<T> {
  const scoped = { ...ctx };
  try {
    return await run(scoped);
  } catch (error) {
    const prepared = executionRequests.get(scoped);
    if (prepared && error instanceof UpstreamError && error.meta.url === prepared.url) {
      error.meta.request = prepared.request;
    }
    throw error;
  } finally {
    executionRequests.delete(scoped);
  }
}

/** 两出口看到的HTTP错误同样携带完整请求（含本地选项），不透传响应正文。 */
export async function fetchPrepared(ctx: ToolContext, prepared: PreparedRequest): Promise<HttpResult> {
  executionRequests.set(ctx, prepared);
  try {
    return await ctx.http(prepared.url, { signal: ctx.signal });
  } catch (error) {
    if (error instanceof UpstreamError) {
      throw new UpstreamError(error.message, { ...error.meta, url: prepared.url, request: prepared.request });
    }
    throw error;
  }
}

export function finishResult(input: {
  body: string;
  res: HttpResult;
  raw?: unknown;
  prepared: PreparedRequest;
  sourceId: string;
  extra?: string;
}): ToolResult {
  const { res, prepared } = input;
  if (res.url !== prepared.url) {
    throw new UpstreamShapeError('响应请求URL与预检证据不一致', { url: prepared.url, request: prepared.request });
  }
  const at = new Date().toISOString();
  const tail = provenance({ sourceName: prepared.sourceName, request: prepared.request,
    status: res.status, durationMs: res.durationMs, at, extra: input.extra });
  if (utf8Bytes(tail) > MAX_TAIL_BYTES) {
    throw new UpstreamShapeError('响应版本/元数据使完整出处超过2560字节，拒绝返回不完整成功结果', {
      url: prepared.url, status: res.status, request: prepared.request,
    });
  }
  const budget = Math.min(MAX_BODY_BYTES, DEFAULT_MAX_BYTES - utf8Bytes(tail) - utf8Bytes(MARKER));
  const clipped = truncateToBytes(input.body, budget);
  const text = `${clipped.text}${clipped.truncated ? MARKER : ''}${tail}`;
  if (utf8Bytes(text) > DEFAULT_MAX_BYTES) throw new Error('输出预算不变量被破坏');
  return { text, raw: input.raw, meta: { sourceId: input.sourceId, request: prepared.request,
    url: prepared.url, status: res.status, durationMs: res.durationMs, at } };
}

/** 本仓库自己的错误类型。上游的失败必须**带出处**地抛，否则无法复现。 */

export class PlantOmicsError extends Error {
  constructor(
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 上游 HTTP / 报文层面的失败。`retryAfter` 只在 429/503 时可能有值。 */
export class UpstreamError extends PlantOmicsError {
  constructor(
    message: string,
    readonly meta: {
      url: string;
      status?: number;
      attempts?: number;
      bodySnippet?: string;
      retryAfter?: string | null;
    },
  ) {
    super(message, meta as unknown as Record<string, unknown>);
  }
}

/**
 * 上游**结构**不符合约定（关键字段缺失、类型变了、信封缺 data）。
 *
 * 与普通 UpstreamError 分开，因为两者含义完全不同：
 *   UpstreamError      = "对方现在不可用"（网络/5xx/限流）
 *   UpstreamShapeError = "对方还活着，但说话变了"
 *
 * 后者最危险——它会被 `data.records ?? []` 之类写法悄悄变成"查无结果"，
 * 让用户以为数据库里没有这条记录。所以必须有独立类型，且**不许落到空数组分支**。
 */
export class UpstreamShapeError extends UpstreamError {}

export class InvalidArgumentError extends PlantOmicsError {}

/** 把任意异常压成一行给人看的话，避免把栈糊进工具输出。 */
export function describeError(error: unknown): string {
  if (error instanceof UpstreamError) {
    const bits = [error.message, `url=${error.meta.url}`];
    if (error.meta.status !== undefined) bits.push(`status=${error.meta.status}`);
    if (error.meta.attempts !== undefined) bits.push(`attempts=${error.meta.attempts}`);
    return bits.join(' | ');
  }
  if (error instanceof PlantOmicsError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

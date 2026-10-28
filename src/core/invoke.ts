/**
 * 工具调用的**唯一入口**。
 *
 * 两个出口（MCP / DSH）都必须过这里，原因是审查里暴露的三个不一致：
 *   1. 入参从不校验 `additionalProperties`——老调用方传 `since_days`（已改名 `sinceDays`）
 *      会被静默忽略，用户以为筛了时间窗，其实没筛；
 *   2. MCP 出口没把客户端的取消信号传进去，用户点了停止，请求还跑到超时；
 *   3. 同一个上游 503，MCP 用户看到的是人话，DSH 用户看到的是裸异常。
 *
 * 把这三件事收在一处，比在两个出口各写一遍可靠。
 */

import { InvalidArgumentError } from './errors.js';
import { fetchJson } from './http.js';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';

/**
 * 按工具自己的 schema 做最小运行时校验。
 *
 * 只做两件 MCP/DSH 都不会替我们做的事：
 *   - 必填参数存在性（两个宿主都不保证校验）
 *   - 未知参数（`additionalProperties: false` 时）
 * 值的类型校验由各工具用 `shape.ts` 的 helper 自己做，因为那需要源级语义。
 */
export function validateArgs(tool: ToolDefinition, args: Record<string, unknown>): void {
  const schema = tool.parameters;
  const known = new Set(Object.keys(schema.properties ?? {}));

  for (const key of schema.required ?? []) {
    if (!(key in args) || args[key] === undefined || args[key] === null || args[key] === '') {
      throw new InvalidArgumentError(`缺少必填参数 ${key}`);
    }
  }

  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      // 这条专门为了抓"参数改名后旧调用方还在传旧名"：静默忽略比报错危险得多
      throw new InvalidArgumentError(
        `未知参数：${unknown.join(', ')}。本工具接受的参数：${[...known].join(', ') || '(无)'}`,
      );
    }
  }
}

export interface InvokeOptions {
  signal?: AbortSignal;
  /** 测试里换成回放 fixture 的 fetcher */
  http?: ToolContext['http'];
}

/** 校验参数后执行工具。失败一律抛，由出口决定怎么呈现（MCP → isError，DSH → 抛）。 */
export async function invokeTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  options: InvokeOptions = {},
): Promise<ToolResult> {
  validateArgs(tool, args);
  return tool.run(args, { http: options.http ?? fetchJson, signal: options.signal });
}

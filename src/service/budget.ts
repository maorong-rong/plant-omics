/**
 * 启动期预算门禁。
 *
 * 为什么要在服务启动时拦、而不是继续只靠构建期 `npm run stats`：
 * 这个进程随时可能被单独重启以"上线新源"，重启前没人保证跑过 stats。
 * 一旦超过规则阈值（20 源 / 40 工具）或工具名会被宿主静默截断，
 * 正确的行为是**拒绝接客**，让旧进程继续服务，而不是带着不可预测的工具名上线。
 *
 * 注意：这里只做"能不能开"的判断，不做运行中热替换。
 */

import type { ToolRegistry } from '../core/registry.js';

export const MAX_SOURCES = 20;
export const MAX_TOOLS = 40;
/**
 * 工具名长度检查是**针对当前连接名**的兼容限制，不是所有源工具的通用命名规则。
 *
 * 原因：模型看到的公开名是 `mcp__<serverName>__<tool.name>`。宿主（DSH）对函数名有
 * 64 字符上限，超出会静默截断并附加 12 位哈希 —— 名字一变，已发布契约就作废。
 * 当前连接名 `plantomics-hub` 的实测前缀是 **21** 字符
 * （`mcp__` 5 + `plantomics-hub` 14 + `__` 2）⇒ 本连接下 tool.name 预算 = 64 − 21 = **43**。
 * 换连接名时这个数会跟着变，所以由 serverName 计算，不写死。
 */
export const HOST_MAX_PUBLIC_NAME = 64;
const PUBLIC_PREFIX_BYTES = (serverName: string): number => `mcp__${serverName}__`.length;

export class BudgetError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`预算门禁未通过，服务拒绝启动：\n- ${problems.join('\n- ')}`);
    this.name = 'BudgetError';
    this.problems = problems;
  }
}

export interface BudgetReport {
  readonly sources: number;
  readonly tools: number;
  /** 其中的元工具数（如检索层入口）；metaTools ⊆ tools，预算按 tools 计 */
  readonly metaTools: number;
  /** 每个工具名在规则前缀下的可用字符预算 */
  readonly nameBudget: number;
}

/**
 * 校验注册表是否可以对外服务。任何一条不满足就整体拒绝，不做"先起来再说"。
 */
export function assertBudget(registry: ToolRegistry, serverName: string): BudgetReport {
  const sources = registry.listSources().length;
  const tools = registry.listTools();
  const problems: string[] = [];

  if (sources > MAX_SOURCES) {
    problems.push(`源 ${sources} 个，超过上限 ${MAX_SOURCES}`);
  }
  if (tools.length > MAX_TOOLS) {
    problems.push(`工具 ${tools.length} 个，超过上限 ${MAX_TOOLS}`);
  }

  const nameBudget = HOST_MAX_PUBLIC_NAME - PUBLIC_PREFIX_BYTES(serverName);
  for (const tool of tools) {
    // 宿主会静默截断+哈希：名字一旦不可预测，就已发布契约就作废了。
    if (tool.name.length > nameBudget) {
      problems.push(
        `工具名 ${tool.name}（${tool.name.length} 字符）超过预算 ${nameBudget}；` +
          `公开名 mcp__${serverName}__${tool.name} 会被宿主截断并加哈希，工具名不可预测`,
      );
    }
  }

  if (problems.length > 0) throw new BudgetError(problems);
  return { sources, tools: tools.length, metaTools: registry.listMetaTools().length, nameBudget };
}

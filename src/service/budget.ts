/**
 * 启动期预算门禁（**AGENTS.md v2.3「源市场制」口径，2026-10-31**）。
 *
 * 口径变了，语义也跟着变——不是"把 40 改成 80"：
 *
 * - **全库不设上限**：源数、工具总数只统计、**不拦截**。库房可以一直加源。
 * - **唯一硬阈值是单次订阅集：≤ 80 工具**（约 2.2 万 token，128K 上下文的 17%）。
 *   它只对**指定了订阅集**（`x-plantomics-sources` / `PLANTOMICS_SOURCES`）的请求生效；
 *   默认集不触发硬上限。
 * - **默认推荐集 ≤ 40 是软建议**：超了**只警示、不拒绝**。
 * - 工具名长度仍是**硬约束**：宿主对 `mcp__<server>__<tool>` 有 64 字符上限，
 *   超出会被静默截断加哈希、已发布契约作废。这是宿主约束，不是我们的预算。
 *
 * 旧口径（源 ≤ 20、工具 ≤ 40、超了拒绝启动）已废止；`src/service/budget.ts` 的
 * 20/40 硬拦曾与规则不同步——规则、`stats`、启动门禁三处必须同源（v2.3 §10.3）。
 */

import type { ToolRegistry } from '../core/registry.js';
import { PlantOmicsError } from '../core/errors.js';

/** 单次订阅集的工具数硬上限（v2.3 唯一硬阈值）。 */
export const SUBSET_TOOLS_HARD_MAX = 80;
/** 默认推荐集的工具数软建议（超过只警示）。 */
export const DEFAULT_SET_TOOLS_SOFT_MAX = 40;

/**
 * **默认推荐集的源清单**（2026-11-03 后端负责人定）。
 *
 * 为什么不再"默认集 = 全库"：全库已经 41 个工具、越过软建议 40，而且随接源只会继续涨——
 * 那样软建议就永远在报警，等于没有。所以默认集是**显式列出的源**：新接一个源不会自动进默认集，
 * 要进就得改这张表，改动可被审阅、可被 diff。
 *
 * 取舍口径：T1 主源 + 元工具；`scod`（单一作物甘蔗）、`string`（蛋白互作）、
 * `uniprot`（蛋白条目）留给用户在市场上自行订阅。
 */
export const DEFAULT_SET_SOURCES: readonly string[] = [
  'wheatomics', 'gramene', 'ensemblplants', 'ic4r', 'strawberry', 'gwh', 'icg',
];

/** 默认推荐集的工具数 = 清单内各源的工具 + 元工具（元工具不属于任何源，随默认集一起下发）。 */
export function defaultSetToolCount(registry: ToolRegistry): number {
  const wanted = new Set(DEFAULT_SET_SOURCES);
  const sourceTools = registry.listSources()
    .filter((bundle) => wanted.has(bundle.manifest.id))
    .reduce((sum, bundle) => sum + bundle.tools.length, 0);
  return sourceTools + registry.listMetaTools().length;
}
/** 历史值：v2.3 起**不再作为拦截条件**，仅保留导出供统计/展示对照。 */
export const HISTORICAL_SOURCE_LIMIT = 20;
export const HISTORICAL_TOOL_LIMIT = 40;

/**
 * 兼容别名：**只供既有展示代码（如 `src/retrieval/status.ts`）与
 * `scripts/counts.mjs` 的三处常量一致性检查编译，不参与任何拦截**。
 *
 * v2.3 已废止"全库 20/40"这套阈值；这两个名字若被当成门禁用，就是规则回潮。
 * 真正的阈值只有两个，见上方 `SUBSET_TOOLS_HARD_MAX`（硬）与 `DEFAULT_SET_TOOLS_SOFT_MAX`（软）。
 */
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
    super(`预算门禁未通过：\n- ${problems.join('\n- ')}`);
    this.name = 'BudgetError';
    this.problems = problems;
  }
}

export interface BudgetReport {
  readonly sources: number;
  readonly tools: number;
  /** 其中的元工具数（如检索层入口）；metaTools ⊆ tools */
  readonly metaTools: number;
  /** 默认推荐集（按 `DEFAULT_SET_SOURCES` 清单算）的工具数；**不等于全库** */
  readonly defaultSetTools: number;
  /** 每个工具名在规则前缀下的可用字符预算 */
  readonly nameBudget: number;
  /** 默认推荐集是否超过软建议（只警示，不影响启动） */
  readonly warnings: readonly string[];
  readonly subsetToolsHardMax: number;
  readonly defaultSetToolsSoftMax: number;
}

/**
 * 启动期校验：**只拦宿主硬约束**（工具名长度），全库数量一律不拦。
 *
 * 默认集超 40 记一条 warning，交给调用方展示（`/healthz`、日志），**不抛错**。
 */
export function assertBudget(registry: ToolRegistry, serverName: string): BudgetReport {
  const sources = registry.listSources().length;
  const tools = registry.listTools();
  const problems: string[] = [];

  // 宿主前缀截断是硬约束：名字不可预测就等于契约作废，这个仍然拒绝启动。
  const nameBudget = HOST_MAX_PUBLIC_NAME - PUBLIC_PREFIX_BYTES(serverName);
  for (const tool of tools) {
    if (tool.name.length > nameBudget) {
      problems.push(
        `工具名 ${tool.name}（${tool.name.length} 字符）超过预算 ${nameBudget}；`
          + `公开名 mcp__${serverName}__${tool.name} 会被宿主截断并加哈希，工具名不可预测`,
      );
    }
  }
  if (problems.length > 0) throw new BudgetError(problems);

  const warnings: string[] = [];
  const defaultSetTools = defaultSetToolCount(registry);
  if (defaultSetTools > DEFAULT_SET_TOOLS_SOFT_MAX) {
    warnings.push(
      `默认推荐集 ${defaultSetTools} 个工具，超过软建议 ${DEFAULT_SET_TOOLS_SOFT_MAX}（不拒绝启动）；`
      + '32K 级上下文会明显拥挤，建议用户按需订阅，或按默认集取舍（v2.3 §10.2）',
    );
  }

  return {
    sources,
    tools: tools.length,
    metaTools: registry.listMetaTools().length,
    defaultSetTools,
    nameBudget,
    warnings,
    subsetToolsHardMax: SUBSET_TOOLS_HARD_MAX,
    defaultSetToolsSoftMax: DEFAULT_SET_TOOLS_SOFT_MAX,
  };
}

/**
 * 单次订阅集的**唯一硬阈值**校验：> 80 拒绝。
 *
 * 只对"指定了订阅集"的请求调用；默认集（未指定）不经过这里。
 * 抛 `PlantOmicsError`（服务层映射为 400），因为这是**请求参数**超限，不是服务配置坏了。
 */
export function assertSubsetBudget(toolCount: number): void {
  if (toolCount > SUBSET_TOOLS_HARD_MAX) {
    throw new PlantOmicsError(
      `订阅集 ${toolCount} 个工具，超过硬上限 ${SUBSET_TOOLS_HARD_MAX}。`
      + `按实测折算约 ${Math.round((toolCount * 10_274) / 37 / 100) * 100} token，`
      + '会把 32K 级上下文挤爆；请减少订阅的源，或改用默认集只取常用的几个',
    );
  }
}

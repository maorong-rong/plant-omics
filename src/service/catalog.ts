/**
 * `GET /catalog` 的响应构造（契约见 `docs/catalog契约.md`，2026-11-01 v1）。
 *
 * 定位：**市场首屏与订阅集计数的唯一运行时数据源**。只读、免鉴权、不含凭据。
 * 为什么不能读 `site/data/catalog.json` 快照：那是构建期产物，源一改就得手动重建，
 * 市场页拿它算「选中的源 → 工具总数」会算错——而算错就是给用户装一个调不动的集合。
 *
 * 两条实现纪律（契约 §四）：
 * 1. **工具集合逐一相等**：`union(sources[].tools) ∪ metaTools` 必须等于 `tools/list` 全集。
 *    元工具只计入 `totals.metaTools`，不塞进任何 `sources[]` 里凑数。
 * 2. **阈值只有一个来源**：直接取 `budget.ts` 的常量，**这里不许出现字面量 80 / 40**。
 *    否则下一次改规则又要改两处，而两处必然漂。
 */

import type { SourceBundle, ToolDefinition } from '../core/types.js';
import type { ToolRegistry } from '../core/registry.js';
import { DEFAULT_SET_TOOLS_SOFT_MAX, SUBSET_TOOLS_HARD_MAX } from './budget.js';

/** 实测折算：37 工具 ≈ 10,274 token，约 280 token/工具（契约 §三 固定口径）。 */
export const EST_TOKENS_PER_TOOL = 280;

/** 每源最多下发的盲区条数；总数另外用 `blindSpotsTotal` 报出，页面才能说「另有 N 条」。 */
export const MAX_BLIND_SPOTS = 5;

export interface CatalogSource {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly toolCount: number;
  /**
   * 覆盖范围：**按物种拆成数组**，不是一个拼好的整串。
   *
   * 2026-11-02 前端实测：整串 `覆盖物种：A、B` 到了页面上只能整体当一块文本，
   * 「按作物画标签筛选」的意图落不了（第一个标签会带着「覆盖物种：」前缀）。
   * 取不到物种时返回 `['未登记覆盖范围']`——不编造、也不留空数组。
   */
  readonly coverage: string[];
  /** 盲区原文，最多 `MAX_BLIND_SPOTS` 条（manifest.caveats 的裁剪版，不改写）。 */
  readonly blindSpots: string[];
  /** 盲区原文总条数；页面对比 `blindSpots.length` 就能说清「另有几条」。 */
  readonly blindSpotsTotal: number;
  readonly tools: string[];
  readonly homepage: string;
  // status 缺省 = 未记录（ProbeRecord.status 是可选的）；缺失就不写，不编一个 0。
  readonly lastProbe?: { date: string; ok: boolean; status?: number; ms?: number };
}

export interface CatalogResponse {
  readonly version: string;
  readonly generatedAt: string;
  readonly totals: { sources: number; tools: number; metaTools: number };
  readonly budget: {
    defaultSetTools: number;
    defaultSetSoftMax: number;
    defaultSetOverSoftMax: boolean;
    subsetToolsHardMax: number;
    estTokensPerTool: number;
    subsetToolsHardMaxTokens: number;
  };
  readonly sources: CatalogSource[];
}

/**
 * 覆盖范围：按物种拆成标签数组。
 *
 * **不许为了"字段齐"编造**（契约 §五）：取不到就写「未登记覆盖范围」，返回单元素数组，
 * 既不编物种、也不返回空数组让页面自己猜。
 */
function coverageOf(bundle: SourceBundle): string[] {
  const species = bundle.manifest.species ?? [];
  if (species.length === 0) return ['未登记覆盖范围'];
  return [...species];
}

/**
 * 盲区：manifest.caveats 的裁剪版。
 *
 * 只裁剪、不改写、不合并（原文口径由源侧负责）；总数单独给，页面才能显示截断。
 */
function blindSpotsOf(bundle: SourceBundle): { blindSpots: string[]; blindSpotsTotal: number } {
  const caveats = bundle.manifest.caveats ?? [];
  return { blindSpots: caveats.slice(0, MAX_BLIND_SPOTS), blindSpotsTotal: caveats.length };
}

function probeOf(bundle: SourceBundle): CatalogSource['lastProbe'] {
  const probe = bundle.manifest.lastProbe;
  if (!probe) return undefined;
  return {
    date: probe.date,
    ok: probe.ok,
    ...(typeof probe.status === 'number' ? { status: probe.status } : {}),
    ...(typeof probe.ms === 'number' ? { ms: probe.ms } : {}),
  };
}

/**
 * 由**运行中注册表**生成 catalog。
 *
 * @param registry 服务端注册表（环境变量限定后的全集，不是本次请求的子集）
 * @param version  服务端版本，必须与 `/healthz` 的 `version` 同一个来源
 */
export function buildCatalog(registry: ToolRegistry, options: { version: string; now?: Date }): CatalogResponse {
  const bundles = registry.listSources();
  const tools: ToolDefinition[] = registry.listTools();
  const metaTools: ToolDefinition[] = registry.listMetaTools();

  const sources: CatalogSource[] = bundles.map((bundle) => {
    const blind = blindSpotsOf(bundle);
    return {
      id: bundle.manifest.id,
      name: bundle.manifest.displayName,
      tier: bundle.manifest.tier,
      toolCount: bundle.tools.length,
      coverage: coverageOf(bundle),
      blindSpots: blind.blindSpots,
      blindSpotsTotal: blind.blindSpotsTotal,
      // 只放**源工具**；元工具由 totals.metaTools 单独报（契约 §三 / §四.1）。
      tools: bundle.tools.map((tool) => tool.name),
      homepage: bundle.manifest.homepage,
      ...(probeOf(bundle) ? { lastProbe: probeOf(bundle) } : {}),
    };
  });

  // 默认集 = 不带订阅头时实际下发的工具数（含元工具：它们真的会进模型上下文）
  const defaultSetTools = tools.length;

  return {
    version: options.version,
    generatedAt: (options.now ?? new Date()).toISOString(),
    totals: { sources: bundles.length, tools: tools.length, metaTools: metaTools.length },
    budget: {
      defaultSetTools,
      defaultSetSoftMax: DEFAULT_SET_TOOLS_SOFT_MAX,
      defaultSetOverSoftMax: defaultSetTools > DEFAULT_SET_TOOLS_SOFT_MAX,
      subsetToolsHardMax: SUBSET_TOOLS_HARD_MAX,
      estTokensPerTool: EST_TOKENS_PER_TOOL,
      subsetToolsHardMaxTokens: SUBSET_TOOLS_HARD_MAX * EST_TOKENS_PER_TOOL,
    },
    sources,
  };
}

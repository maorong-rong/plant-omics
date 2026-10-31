/**
 * 侧边栏面板的**构建期**数据清单。
 *
 * 为什么不在运行时问宿主：首版刻意把「客户端 ↔ 宿主」这条通道留空——
 * 面板只显示**构建时**从注册表读出来的静态事实（有哪些源、哪些工具、盲区是什么），
 * 不显示探活结果、不冒充运行状态。实时数据要另加宿主路由，属第二版。
 *
 * 因此本文件是纯函数：给一个 ToolRegistry，产出可 JSON 序列化的对象。
 * 构建脚本（scripts/build-client.mjs）把它注入浏览器 bundle；
 * 测试直接调它，断言「面板上的清单 == 注册表」，防止面板与真实工具表漂移。
 */

import type { ToolRegistry } from '../core/registry.js';
import type { SourceManifest } from '../core/types.js';
import { applyPinnedOrder, loadPinnedSources, type PinnedSources } from '../core/pinned.js';
import { createRegistry } from '../sources/index.js';

/**
 * 预算上限。与 `scripts/counts.mjs` 是同一口径，但这里是**客户端展示**用的副本：
 * 客户端 bundle 拿不到 scripts/，也不能在浏览器里跑 registry。
 * `npm run check:counts` 与 `test/client.test.ts` 都会核这几处常量——漂移即测试红。
 */
export const MAX_SOURCES = 20;
export const MAX_TOOLS = 40;

/** 清单结构版本。改变字段形状时 +1，面板据此决定怎么渲染。v2：加 `pinned` / 置顶排序。 */
export const CLIENT_SCHEMA_VERSION = 2;

/** 单条描述在面板上的最大长度（字符）。上游描述可能很长，页面只要「何时用」。 */
const MAX_DESCRIPTION_CHARS = 320;

export interface ClientCatalogSource {
  id: string;
  displayName: string;
  tier: SourceManifest['tier'];
  homepage: string;
  species: string[];
  /** 覆盖盲区：直接取 manifest.caveats，面板如实转述，不加工 */
  blindSpots: string[];
  /** 版本口径；未知就照抄「未知」的说法，不按 ID 外观推测 */
  versionNote: string;
  toolCount: number;
  /** 是否在置顶清单里（顺序由 `src/core/pinned-sources.json` 决定，不在各处再排一次） */
  pinned: boolean;
}

export interface ClientCatalogTool {
  name: string;
  sourceId: string;
  /** 首次使用该工具时该知道的一句话（描述截断后） */
  whenToUse: string;
  /** 必填参数名；空数组表示无必填参数 */
  required: string[];
}

export interface ClientCatalog {
  schemaVersion: number;
  budget: { sources: number; maxSources: number; tools: number; maxTools: number };
  /** 置顶清单原样带出，面板与站点据此加标记；顺序已在 sources 里体现 */
  pinned: readonly string[];
  sources: ClientCatalogSource[];
  tools: ClientCatalogTool[];
}

function clip(text: string, max = MAX_DESCRIPTION_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * 从注册表生成清单。
 *
 * 顺序：`src/core/pinned-sources.json` 里的源按清单顺序靠前，其余保持注册表原序（工具顺序不动）。
 * 置顶清单缺失/形状不对/出现注册表里没有的 id 时**抛错**，不回退成原序——置顶悄悄失效比报错更难查。
 */
export function buildCatalog(registry: ToolRegistry = createRegistry(), pinnedSources: PinnedSources = loadPinnedSources()): ClientCatalog {
  const bundles = registry.listSources();
  const tools: ClientCatalogTool[] = [];

  const built = bundles.map((bundle) => {
    const manifest = bundle.manifest;
    for (const tool of bundle.tools) {
      tools.push({
        name: tool.name,
        sourceId: manifest.id,
        whenToUse: clip(tool.description),
        required: [...(tool.parameters.required ?? [])],
      });
    }
    return {
      id: manifest.id,
      displayName: manifest.displayName,
      tier: manifest.tier,
      homepage: manifest.homepage,
      species: [...manifest.species],
      blindSpots: [...(manifest.caveats ?? [])],
      versionNote: manifest.versionNote ?? '未知（上游未提供版本口径，本仓不推测）',
      toolCount: bundle.tools.length,
      pinned: pinnedSources.pinned.includes(manifest.id),
    } satisfies ClientCatalogSource;
  });

  const known = new Set(built.map((source) => source.id));
  const unknown = pinnedSources.pinned.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `置顶清单里有注册表中不存在的源：${unknown.join(', ')}。已登记的源：${[...known].join(', ')}；`
        + '改 src/core/pinned-sources.json 或补上该源，别留着让它静默失效。',
    );
  }

  const sources = applyPinnedOrder(built, pinnedSources.pinned);

  // 元工具（检索层入口）不属于任何源：单独列出，sourceId 显示「元工具」
  for (const tool of registry.listMetaTools()) {
    tools.push({
      name: tool.name,
      sourceId: '元工具',
      whenToUse: clip(tool.description),
      required: [...(tool.parameters.required ?? [])],
    });
  }

  return {
    schemaVersion: CLIENT_SCHEMA_VERSION,
    budget: {
      sources: sources.length,
      maxSources: MAX_SOURCES,
      tools: tools.length,
      maxTools: MAX_TOOLS,
    },
    pinned: [...pinnedSources.pinned],
    sources,
    tools,
  };
}

/**
 * 元工具装配：把检索层的工具（`hub_*`）从注册表快照构造出来。
 *
 * 为什么不写进 `src/sources/index.ts`：那个文件是"有哪些**源**"的唯一清单，
 * 元工具不属于源。这里单独一个装配点，`createRegistry()` 末尾调一次即可
 * （由代码改动者接线，避免两边同时改同一个文件）。
 *
 * 快照来源：**只读 `registry.listSources()`**，不探测上游、不读 dist。
 */

import type { ToolRegistry } from '../core/registry.js';
import type { ToolDefinition } from '../core/types.js';
import { PACKAGE_VERSION } from '../core/package-version.js';
import { SERVICE_REVISION } from '../service/version.js';
import { createFindSourcesTool, type CatalogSnapshot } from './find-sources.js';
import { createStatusTool, type StatusSnapshot, type StatusSourceView } from './status.js';

/**
 * 从注册表抽出 `hub_find_sources` 需要的目录快照（版本 + 规模）。
 *
 * **用 getter 而不是一次性取值**：元工具在 `createHubTools` 构造时还没注册进
 * `createRegistry`，此刻 `listTools()` 只有 30 个业务工具；若快照在构造期定死，
 * 尾注会永远写"工具 30"，与 `/healthz`、`tools/list` 的 32 对不上（实测踩到）。
 * 改成运行时读，数字始终等于调用时刻真实注册表。
 */
export function catalogSnapshotOf(registry: ToolRegistry, version?: string): CatalogSnapshot {
  return {
    get version() {
      return version ?? `${PACKAGE_VERSION}+svc.${SERVICE_REVISION}`;
    },
    get sourceCount() {
      return registry.listSources().length;
    },
    get toolCount() {
      return registry.listTools().length;
    },
    // 子集启用时能力目录仍是全局的；必须给真实注册的工具名，否则会推荐不存在的工具（RETR-12）
    get enabledTools() {
      return registry.listSources().flatMap((bundle) => bundle.tools.map((tool) => tool.name));
    },
  };
}

/**
 * 从注册表抽出 `hub_status` 需要的状态快照。
 *
 * 只搬 manifest 已声明的字段（species/versionNote/tier），**不做任何推断**：
 * 版本口径未知就照抄 manifest 里"未知"的说法，不按 ID 外观猜。
 */
export function statusSnapshotOf(registry: ToolRegistry, version?: string): StatusSnapshot {
  const sources: StatusSourceView[] = registry.listSources().map((bundle) => ({
    id: bundle.manifest.id,
    displayName: bundle.manifest.displayName,
    tier: bundle.manifest.tier,
    toolCount: bundle.tools.length,
    species: [...bundle.manifest.species],
    versionNote: bundle.manifest.versionNote ?? '未知（上游未提供版本口径，本仓不推测）',
  }));
  return {
    version: version ?? `${PACKAGE_VERSION}+svc.${SERVICE_REVISION}`,
    sources,
    // 业务工具名（不含元工具）：hub_status 用它把全局能力目录收敛成"实际启用集"（RETR-10）
    enabledTools: registry.listSources().flatMap((bundle) => bundle.tools.map((tool) => tool.name)),
    // 元工具同样要**运行时读**：构造元工具的时刻，它们还没注册进注册表（实测 0 vs 2）
    get metaToolNames() {
      return registry.listMetaTools().map((tool) => tool.name);
    },
  };
}

/**
 * 构造全部元工具（顺序即 `tools/list` 顺序，`hub_find_sources` 在前）。
 *
 * `version` 可注入：服务端装配时传真实的 `servedVersion`，
 * 测试里传固定串以保证输出可逐字节对比。
 */
export function createHubTools(registry: ToolRegistry, version?: string): ToolDefinition[] {
  return [
    createFindSourcesTool(catalogSnapshotOf(registry, version)),
    createStatusTool(statusSnapshotOf(registry, version)),
  ];
}

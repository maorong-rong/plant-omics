/**
 * 默认注册表 —— 新源在这里登记一行。
 *
 * 保持「一个文件说清现在有哪些源」，是刻意的：源清单必须能一眼看完，
 * 散在各处的 import 会让「到底支持了什么」变成考古。
 *
 * 支持**只启用一部分源**，便于按需加载：
 * 别人 fork 这个仓库时，通常只想装自己关心的那几个库，不该被迫全量加载。
 */

import { PlantOmicsError } from '../core/errors.js';
import { ToolRegistry } from '../core/registry.js';
import type { SourceBundle } from '../core/types.js';
import { manifest as wheatomicsManifest } from './wheatomics/manifest.js';
import { tools as wheatomicsTools } from './wheatomics/tools.js';

const bundles: SourceBundle[] = [
  { manifest: wheatomicsManifest, tools: wheatomicsTools },
];

export interface RegistryOptions {
  /**
   * 只启用这些源 id（不传 = 全部启用）。
   * 传了未知 id 直接抛错——不然拼错一个字母会静默得到零工具，
   * 这种「装上了但什么都没有」是最难查的失效。
   */
  enabled?: readonly string[];
}

export function createRegistry(options: RegistryOptions = {}): ToolRegistry {
  const wanted = (options.enabled ?? []).map((id) => id.trim()).filter(Boolean);
  const known = bundles.map((bundle) => bundle.manifest.id);

  if (wanted.length > 0) {
    const unknown = wanted.filter((id) => !known.includes(id));
    if (unknown.length > 0) {
      throw new PlantOmicsError(
        `未知的源 id：${unknown.join(', ')}。已登记的源：${known.join(', ')}`,
      );
    }
  }

  const enabled = wanted.length > 0 ? new Set(wanted) : null;
  const registry = new ToolRegistry();
  for (const bundle of bundles) {
    if (enabled && !enabled.has(bundle.manifest.id)) continue;
    registry.register(bundle);
  }
  return registry;
}

/** 从环境变量读启用清单（逗号/分号/空白分隔）。MCP 与 dsh 两条出口都用它。 */
export function enabledSourcesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env.PLANTOMICS_SOURCES?.trim();
  if (!raw) return undefined;
  const ids = raw.split(/[,;\s]+/).map((id) => id.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

export const registry = createRegistry({ enabled: enabledSourcesFromEnv() });
export default registry;

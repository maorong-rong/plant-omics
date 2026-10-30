/**
 * 目录 ↔ 注册表**双向一致**测试（契约 §五）。
 *
 * 为什么必须单独一个文件、且失败信息要点名：
 *   加了源却忘了登记能力目录 → 检索静默漏掉整个源（用户以为"没有覆盖"，
 *   其实是"忘了登记"）。这种失效**不会报错**，只会让 _find_sources 少召回。
 *   所以这里两个方向都查：目录缺、目录多，各自点名到具体工具。
 */

import { describe, expect, it } from 'vitest';

import { createRegistry } from '../src/sources/index.js';
import {
  INTENTS,
  SOURCE_SEMANTICS,
  SPECIES_ALIASES,
  SPECIES_WITHOUT_COVERAGE,
  TOOL_CAPABILITIES,
  speciesSatisfies,
} from '../src/retrieval/capability-catalog.js';
import { createHubTools } from '../src/retrieval/index.js';

const registry = createRegistry();
// 只比**源工具**：元工具（hub_*）不是"某个源的能力"，由 registerMetaTool 单独登记，
// 放进这里比较会永远报"目录缺"——那不是漏登记，是口径错。
const registryToolNames = new Set(
  registry.listTools().map((tool) => tool.name).filter((name) => !name.startsWith('hub_')),
);
const catalogToolNames = new Set(TOOL_CAPABILITIES.map((capability) => capability.tool));
const registrySourceIds = new Set(registry.listSources().map((bundle) => bundle.manifest.id));

/** 元工具不属于源，但要单独在册；在这里显式列出，防止"以为有其实没有"。 */
const META_TOOL_NAMES = createHubTools(registry, 'test').map((tool) => tool.name);

describe('能力目录 ↔ 注册表双向一致', () => {
  it('目录缺（注册表有、目录没登记）→ 失败并点名', () => {
    const missing = [...registryToolNames].filter((name) => !catalogToolNames.has(name));
    expect(
      missing,
      `以下工具在注册表里但未登记到 src/retrieval/capability-catalog.ts 的 TOOL_CAPABILITIES：${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('目录多（目录登记了、注册表没有）→ 失败并点名', () => {
    const extra = [...catalogToolNames].filter((name) => !registryToolNames.has(name));
    expect(
      extra,
      `以下工具登记在能力目录里但注册表中不存在（源被移除或改名了？）：${extra.join(', ')}`,
    ).toEqual([]);
  });

  it('每条 sourceId 都在册，且源级语义已登记', () => {
    const bad = TOOL_CAPABILITIES
      .filter((capability) => !registrySourceIds.has(capability.sourceId))
      .map((capability) => `${capability.tool}→${capability.sourceId}`);
    expect(bad, `目录里的 sourceId 不在注册表中：${bad.join(', ')}`).toEqual([]);

    const noSemantics = [...registrySourceIds].filter((id) => !(id in SOURCE_SEMANTICS));
    expect(
      noSemantics,
      `以下源没有在 SOURCE_SEMANTICS 里登记语义（会导致排序与"示例非承诺"标注失效）：${noSemantics.join(', ')}`,
    ).toEqual([]);
  });

  it('目录里的 sourceId 与该工具真实归属的源一致（防挂错源）', () => {
    const misplaced: string[] = [];
    for (const capability of TOOL_CAPABILITIES) {
      const bundle = registry.listSources().find((item) => item.tools.some((tool) => tool.name === capability.tool));
      if (!bundle) continue; // 上一条断言已经会报
      if (bundle.manifest.id !== capability.sourceId) {
        misplaced.push(`${capability.tool}：目录写 ${capability.sourceId}，实际属 ${bundle.manifest.id}`);
      }
    }
    expect(misplaced, misplaced.join('；')).toEqual([]);
  });

  it('意图闭合：每个 intent 都在 INTENTS 枚举里，且每个工具至少一个意图', () => {
    const ids = new Set(INTENTS.map((intent) => intent.id));
    const bad: string[] = [];
    for (const capability of TOOL_CAPABILITIES) {
      if (capability.intents.length === 0) bad.push(`${capability.tool}：没有任何意图`);
      for (const intent of capability.intents) {
        if (!ids.has(intent)) bad.push(`${capability.tool}：意图 ${intent} 不在枚举里`);
      }
    }
    expect(bad, bad.join('；')).toEqual([]);
  });

  it('物种别名表里的每个规范名都能被某个 speciesScope 承接（防"表里有、目录查不到"）', () => {
    const scopes = new Set<string>();
    for (const capability of TOOL_CAPABILITIES) {
      for (const scope of [...(capability.speciesScope.query ?? []), ...(capability.speciesScope.target ?? [])]) {
        scopes.add(scope);
      }
    }
    // 刻意保留：已知但**不覆盖**的物种（油菜/大豆/番茄/人类…）。
    // 它们进别名表的目的是"能识别、从而能精确拒答"，不是"有源承接"。
    // 名单只从目录取，测试不另写一份，否则两边会分叉。
    const intentionallyUncovered = new Set<string>(SPECIES_WITHOUT_COVERAGE);
    const orphans = Object.keys(SPECIES_ALIASES).filter((species) => {
      if (intentionallyUncovered.has(species)) return false;
      // 用目录自己的判定函数，不另写一套子串匹配（否则断言口径与检索口径会分叉）
      return ![...scopes].some((scope) => speciesSatisfies(species, scope));
    });
    expect(orphans, `以下物种在别名表里但没有任何 speciesScope 承接：${orphans.join(', ')}`).toEqual([]);
  });

  it('不覆盖名单里的物种确实没有任何源按物种承接（否则"拒答"会误杀真能查的物种）', () => {
    const falsePositives = SPECIES_WITHOUT_COVERAGE.filter((species) => {
      return TOOL_CAPABILITIES.some((capability) =>
        (capability.speciesScope.query ?? []).some(
          (scope) => scope !== '不限物种（按精确 ID）' && speciesSatisfies(species, scope),
        ));
    });
    expect(
      falsePositives,
      `以下物种被列进 SPECIES_WITHOUT_COVERAGE，但目录里其实有源按物种承接它：${falsePositives.join(', ')}`,
    ).toEqual([]);
  });

  it('元工具（hub_*）不在能力目录里，也不占用源', () => {
    for (const name of META_TOOL_NAMES) {
      expect(catalogToolNames.has(name), `${name} 是元工具，不该登记为源工具能力`).toBe(false);
      expect(registrySourceIds.has(name)).toBe(false);
    }
    expect(META_TOOL_NAMES).toContain('hub_status');
    expect(META_TOOL_NAMES.length).toBeGreaterThanOrEqual(2);
  });

  it('元工具名符合 hub_ 前缀与长度预算（≤43）', () => {
    for (const name of META_TOOL_NAMES) {
      expect(name.startsWith('hub_')).toBe(true);
      expect(name.length).toBeLessThanOrEqual(43);
    }
  });
});

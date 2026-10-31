import { describe, expect, it } from 'vitest';

import { SPECIES_ALIASES, TOOL_CAPABILITIES, speciesSatisfies } from '../src/retrieval/capability-catalog.js';
import { createRegistry } from '../src/sources/index.js';

/**
 * 物种口径一致性（2026-10-31，负责人指定）。
 *
 * `hub_status` 读的是各源 `manifest.species`，`hub_find_sources` 读的是能力目录的
 * `speciesScope`——两处漂移就会出现"status 说有这个源，find 说没覆盖"的自相矛盾。
 * 这条断言**只读** `src/sources/` 与能力目录，不改任何源文件。
 *
 * 判据（任一成立即记一条差异）：
 *   正向：manifest 声明的每个物种，都应有该源的某个 `speciesScope` 能承接；
 *   反向：目录里写成**单物种名**的 scope，manifest 里必须有对应物种（族级/复合 scope 不判，
 *         例如「小麦族」「草莓及相关病原」这类本来就无法反推单个物种）。
 *
 * 物种名对照走 `SPECIES_ALIASES`：manifest 用拉丁名，目录用中文规范名。
 */

/**
 * 拉丁名（或中文名）→ 目录里的规范名；对照不上返回 undefined。
 *
 * 用**子串**语义而不是全等：`find_sources` 的 `detectSpecies` 就是在归一化文本里
 * `indexOf` 别名，所以 "Fragaria vesca" 能被 `fragaria` 认成「草莓」、"Saccharum spontaneum"
 * 能被 `saccharum` 认成「甘蔗」。断言若按全等判，会把"其实认得出"误报成漂移。
 */
function canonicalOf(name: string): string | undefined {
  const haystack = name.trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(SPECIES_ALIASES)) {
    if (aliases.some((alias) => alias.length >= 3 && haystack.includes(alias.toLowerCase()))) return canonical;
  }
  return undefined;
}

/** 反向：该规范名是否有别名出现在某个 manifest 物种名里。 */
function declaredCovers(declared: string[], canonical: string): boolean {
  const aliases = SPECIES_ALIASES[canonical] ?? [];
  return declared.some((species) => {
    const haystack = species.trim().toLowerCase();
    return aliases.some((alias) => alias.length >= 3 && haystack.includes(alias.toLowerCase()));
  });
}

describe('物种口径一致：manifest.species ↔ 能力目录 speciesScope', () => {
  it('两处集合不一致即红，并列出差异的源与物种', () => {
    const diffs: string[] = [];

    for (const { manifest } of createRegistry().listSources()) {
      const capabilities = TOOL_CAPABILITIES.filter((cap) => cap.sourceId === manifest.id);
      const scopes = [...new Set(capabilities.flatMap((cap) => cap.speciesScope.query ?? []))];
      const declared = (manifest.species ?? []).map((sp) => sp.trim()).filter(Boolean);

      // 正向：manifest 有的物种，目录必须接得住
      for (const species of declared) {
        const canonical = canonicalOf(species);
        if (!canonical) {
          diffs.push(`${manifest.id}：「${species}」不在别名表，find_sources 无法识别该物种（status 声称覆盖）`);
          continue;
        }
        if (!scopes.some((scope) => speciesSatisfies(canonical, scope))) {
          diffs.push(`${manifest.id}：manifest 有「${species}」（${canonical}），但目录 scope [${scopes.join('、') || '空'}] 未承接`);
        }
      }

      // 反向：目录里按"单物种名"写的 scope，manifest 必须真的有这个物种
      for (const scope of scopes) {
        if (!Object.keys(SPECIES_ALIASES).includes(scope)) continue; // 族级/复合 scope 跳过
        if (!declaredCovers(declared, scope)) {
          diffs.push(`${manifest.id}：目录 scope「${scope}」声称承接该物种，但 manifest.species [${declared.join('、') || '空'}] 里没有`);
        }
      }
    }

    expect(diffs, `物种口径漂移（${diffs.length} 条）：\n${diffs.join('\n')}`).toEqual([]);
  });
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { applyPinnedOrder, loadPinnedSources, parsePinnedSources } from '../src/core/pinned.js';
import { buildCatalog } from '../src/client/catalog.js';
import { createRegistry } from '../src/sources/index.js';
import { checkPinnedSources } from '../scripts/counts.mjs';

/**
 * 置顶顺序：唯一来源 `src/core/pinned-sources.json`。
 *
 * 这里锁三件事：
 * 1. 形状校验会真的拒绝坏数据（不是静默回退成注册表原序）；
 * 2. 排序 = 置顶项按清单顺序靠前、其余保持原序；
 * 3. `check:counts` 的置顶断言能抓到「dist 不是副本」「清单与注册表不符」「顺序被覆盖」。
 */

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempTree(pinned: unknown, distText?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pinned-sources-'));
  tmpDirs.push(root);
  mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
  const text = typeof pinned === 'string' ? pinned : JSON.stringify(pinned, null, 2);
  writeFileSync(path.join(root, 'src', 'core', 'pinned-sources.json'), text);
  if (distText !== undefined) {
    mkdirSync(path.join(root, 'dist', 'core'), { recursive: true });
    writeFileSync(path.join(root, 'dist', 'core', 'pinned-sources.json'), distText);
  }
  return root;
}

describe('置顶数据的形状校验', () => {
  it('合法数据原样通过', () => {
    expect(parsePinnedSources({ schemaVersion: 1, pinned: ['strawberry'] })).toEqual({
      schemaVersion: 1,
      pinned: ['strawberry'],
    });
  });

  it('schemaVersion 不对、pinned 不是数组、重复 id、空值，都点名拒绝', () => {
    expect(() => parsePinnedSources({ schemaVersion: 2, pinned: [] })).toThrow(/schemaVersion/);
    expect(() => parsePinnedSources({ schemaVersion: 1, pinned: 'strawberry' })).toThrow(/字符串数组/);
    expect(() => parsePinnedSources({ schemaVersion: 1, pinned: ['a', 'a'] })).toThrow(/重复/);
    expect(() => parsePinnedSources({ schemaVersion: 1, pinned: [' '] })).toThrow(/空值/);
  });

  it('文件不存在时抛错并指路，不返回空清单', () => {
    const url = new URL('file:///definitely/missing/pinned-sources.json');
    expect(() => loadPinnedSources(url as unknown as URL)).toThrow(/pinned-sources\.json/);
  });
});

describe('排序', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('置顶项按清单顺序靠前，其余保持原序', () => {
    expect(applyPinnedOrder(items, ['c', 'a']).map((item) => item.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('空置顶清单等于原序', () => {
    expect(applyPinnedOrder(items, []).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('真实清单把 strawberry 排到第一，且只标它 pinned', () => {
    const catalog = buildCatalog(createRegistry());
    expect(catalog.schemaVersion).toBe(2);
    expect(catalog.pinned).toEqual(['strawberry']);
    expect(catalog.sources[0]?.id).toBe('strawberry');
    expect(catalog.sources.filter((source) => source.pinned).map((source) => source.id)).toEqual(['strawberry']);
  });

  it('置顶清单出现注册表没有的 id → 抛错，不静默失效', () => {
    expect(() => buildCatalog(createRegistry(), { schemaVersion: 1, pinned: ['nope'] })).toThrow(/不存在的源：nope/);
  });
});

describe('check:counts 的置顶断言', () => {
  const registry = createRegistry();
  const counts = { perSource: registry.listSources().map((bundle) => ({ id: bundle.manifest.id })) };
  const catalog = buildCatalog(registry);

  it('src 与 dist 一致、顺序正确 → 无问题', () => {
    const root = tempTree({ schemaVersion: 1, pinned: ['strawberry'] }, JSON.stringify({ schemaVersion: 1, pinned: ['strawberry'] }, null, 2));
    expect(checkPinnedSources({ counts, root, catalog })).toEqual([]);
  });

  it('dist 不是副本 → 点名重跑构建', () => {
    const root = tempTree(
      { schemaVersion: 1, pinned: ['strawberry'] },
      JSON.stringify({ schemaVersion: 1, pinned: [] }, null, 2),
    );
    expect(checkPinnedSources({ counts, root, catalog }).join('\n')).toMatch(/与 src 不一致/);
  });

  it('dist 缺文件 → 点名先构建', () => {
    const root = tempTree({ schemaVersion: 1, pinned: ['strawberry'] });
    expect(checkPinnedSources({ counts, root, catalog }).join('\n')).toMatch(/缺失/);
  });

  it('置顶 id 不在注册表 → 点名', () => {
    const root = tempTree({ schemaVersion: 1, pinned: ['nope'] }, JSON.stringify({ schemaVersion: 1, pinned: ['nope'] }, null, 2));
    expect(checkPinnedSources({ counts, root, catalog }).join('\n')).toMatch(/不在注册表里/);
  });

  it('客户端清单顺序被覆盖 → 点名顺序不一致', () => {
    const root = tempTree({ schemaVersion: 1, pinned: ['strawberry'] }, JSON.stringify({ schemaVersion: 1, pinned: ['strawberry'] }, null, 2));
    const scrambled = { ...catalog, pinned: [], sources: [...catalog.sources].reverse() };
    const problems = checkPinnedSources({ counts, root, catalog: scrambled }).join('\n');
    expect(problems).toMatch(/pinned 是 \[\]/);
    expect(problems).toMatch(/应等于置顶清单/);
  });

  it('没拿到清单 → 报缺失，不算通过', () => {
    const root = tempTree({ schemaVersion: 1, pinned: ['strawberry'] }, JSON.stringify({ schemaVersion: 1, pinned: ['strawberry'] }, null, 2));
    expect(checkPinnedSources({ counts, root }).join('\n')).toMatch(/没拿到客户端清单/);
  });
});

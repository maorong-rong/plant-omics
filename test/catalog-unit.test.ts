import { describe, expect, it, vi } from 'vitest';

/**
 * `catalog` 的**负控**：把 `budget.ts` 的常量换掉，`/catalog` 的 budget 段必须跟着变。
 *
 * 这条断言防的是"在 catalog 里又写了一份 80 / 40"——如果写了字面量，
 * 改 budget.ts 就不会反映到 catalog，这条会红。契约 §六 第 4 条。
 * 用 mock 替换常量而不是真改源码再编译：结果等价，且不会在共享工作区里制造一次危险的手改。
 */

vi.mock('../src/service/budget.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/service/budget.js')>();
  return {
    ...actual,
    SUBSET_TOOLS_HARD_MAX: 81,
    DEFAULT_SET_TOOLS_SOFT_MAX: 41,
  };
});

describe('catalog 的阈值只来自 budget.ts', () => {
  it('改 budget 常量 → catalog 的 subsetToolsHardMax / defaultSetSoftMax / 折算 token 全部跟着变', async () => {
    const { buildCatalog, EST_TOKENS_PER_TOOL } = await import('../src/service/catalog.js');
    const { registry } = await import('../src/sources/index.js');

    const catalog = buildCatalog(registry, { version: 'test' });
    expect(catalog.budget.subsetToolsHardMax).toBe(81);
    expect(catalog.budget.defaultSetSoftMax).toBe(41);
    expect(catalog.budget.subsetToolsHardMaxTokens).toBe(81 * EST_TOKENS_PER_TOOL);
    // 软建议判定也必须跟着新值算，而不是写死
    expect(catalog.budget.defaultSetOverSoftMax).toBe(catalog.budget.defaultSetTools > 41);
  });

  it('totals 与注册表逐一相等（sources / tools / metaTools 三个数都要对得上）', async () => {
    const { buildCatalog } = await import('../src/service/catalog.js');
    const { registry } = await import('../src/sources/index.js');

    const catalog = buildCatalog(registry, { version: 'test' });
    expect(catalog.totals.sources).toBe(registry.listSources().length);
    expect(catalog.totals.tools).toBe(registry.listTools().length);
    expect(catalog.totals.metaTools).toBe(registry.listMetaTools().length);
    // metaTools ⊆ tools
    expect(catalog.totals.metaTools).toBeLessThanOrEqual(catalog.totals.tools);
  });
});

/**
 * 2026-11-02 前端实测暴露的两处契约不一致（按契约改实现，不降契约）：
 *   - `coverage` 之前是拼好的整串（`覆盖物种：A、B`），页面按作物画标签落不了；
 *   - `blindSpots` / `blindSpotsTotal` 之前根本没有，市场页「盲区」在线上看不见。
 */
describe('catalog 的 coverage 与盲区字段（按契约输出）', () => {
  it('coverage 是按物种拆开的数组，且不编造覆盖范围', async () => {
    const { buildCatalog } = await import('../src/service/catalog.js');
    const { registry } = await import('../src/sources/index.js');
    const catalog = buildCatalog(registry, { version: 'test' });

    for (const source of catalog.sources) {
      expect(Array.isArray(source.coverage)).toBe(true);
      expect(source.coverage.length).toBeGreaterThan(0);
      for (const label of source.coverage) {
        expect(typeof label).toBe('string');
        expect(label).not.toContain('覆盖物种：'); // 前缀属于旧实现，不能残留
        expect(label).not.toContain('支持全部物种'); // 契约 §五：不编造
      }
    }
  });

  it('盲区：最多 5 条、总数如实、截断看得出来', async () => {
    const { buildCatalog, MAX_BLIND_SPOTS } = await import('../src/service/catalog.js');
    const { registry } = await import('../src/sources/index.js');
    const catalog = buildCatalog(registry, { version: 'test' });

    let truncated = 0;
    for (const bundle of registry.listSources()) {
      const source = catalog.sources.find((item) => item.id === bundle.manifest.id);
      expect(source).toBeDefined();
      const caveats = bundle.manifest.caveats ?? [];
      expect(source!.blindSpotsTotal).toBe(caveats.length);
      expect(source!.blindSpots.length).toBe(Math.min(caveats.length, MAX_BLIND_SPOTS));
      // 裁剪的是原文，不是改写：每条都必须原样出现在 manifest.caveats 里
      for (const line of source!.blindSpots) expect(caveats).toContain(line);
      if (caveats.length > MAX_BLIND_SPOTS) truncated += 1;
    }
    // 至少有一个源真的被截断，否则这条断言等于没测到裁剪
    expect(truncated).toBeGreaterThan(0);
  });

  it('没有登记物种时写「未登记覆盖范围」，不返回空数组也不编物种', async () => {
    const { ToolRegistry } = await import('../src/core/registry.js');
    const { buildCatalog } = await import('../src/service/catalog.js');
    const registry = new ToolRegistry();
    registry.register({
      manifest: {
        id: 'nospecies',
        displayName: 'NoSpecies',
        homepage: 'https://example.invalid',
        apiBase: 'https://example.invalid',
        tier: 'T2',
        auth: 'none',
        species: [],
        network: 'direct',
        probe: { path: '/x', expect: 'json' },
      },
      tools: [{
        name: 'nospecies_probe',
        description: '测试用工具：说明长度足够通过注册表的硬校验，覆盖范围与盲区都未登记。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async run() {
          return {
            text: 'ok',
            meta: {
              sourceId: 'nospecies', request: 'GET https://example.invalid', url: 'https://example.invalid',
              status: 200, durationMs: 1, at: new Date().toISOString(),
            },
          };
        },
      }],
    });

    const catalog = buildCatalog(registry, { version: 'test', pinnedSources: { schemaVersion: 1, pinned: [] } });
    expect(catalog.sources[0]?.coverage).toEqual(['未登记覆盖范围']);
    expect(catalog.sources[0]?.blindSpots).toEqual([]);
    expect(catalog.sources[0]?.blindSpotsTotal).toBe(0);
  });
});

/**
 * 2026-11-03 审查发现：`/catalog` 的 `sources` 是注册表原序（wheatomics 第一），
 * 而落地页按 `src/core/pinned-sources.json` 把 strawberry 置顶——同一份数据两种顺序。
 * 修法是让 `/catalog` 也读那一份，而不是在市场页里再排一次。
 */
describe('catalog 的 sources 顺序与 site/ 同源（pinned-sources.json）', () => {
  it('第一个源是置顶源，且未列出的源保持注册表原序', async () => {
    const { buildCatalog } = await import('../src/service/catalog.js');
    const { registry } = await import('../src/sources/index.js');
    const { loadPinnedSources, applyPinnedOrder } = await import('../src/core/pinned.js');

    const pinned = loadPinnedSources();
    const expected = applyPinnedOrder(
      registry.listSources().map((bundle) => ({ id: bundle.manifest.id })),
      pinned.pinned,
    ).map((item) => item.id);
    const catalog = buildCatalog(registry, { version: 'test' });
    expect(catalog.sources.map((source) => source.id)).toEqual(expected);
    expect(catalog.sources[0]?.id).toBe(pinned.pinned[0]);
  });

  it('置顶清单里出现注册表没有的 id → 抛错，不回退注册表顺序', async () => {
    const { buildCatalog } = await import('../src/service/catalog.js');
    const { registry } = await import('../src/sources/index.js');
    expect(() => buildCatalog(registry, {
      version: 'test',
      pinnedSources: { schemaVersion: 1, pinned: ['not-a-source'] },
    })).toThrow(/不存在的源/);
  });

  it('换一份置顶清单，顺序跟着变（证明不是写死的 strawberry）', async () => {
    const { buildCatalog } = await import('../src/service/catalog.js');
    const { registry } = await import('../src/sources/index.js');
    const catalog = buildCatalog(registry, {
      version: 'test',
      pinnedSources: { schemaVersion: 1, pinned: ['icg'] },
    });
    expect(catalog.sources[0]?.id).toBe('icg');
    expect(catalog.sources.map((source) => source.id).filter((id) => id === 'icg')).toHaveLength(1);
  });
});

import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CATALOG_SERVICE_KEYS, SERVICES_CATALOG } from '../src/core/catalog-services.js';
import { SPECIES_NAMES_ZH, speciesNameZh } from '../src/service/species-names.js';
import { buildCatalog } from '../src/service/catalog.js';
import { createRegistry, registry as defaultRegistry } from '../src/sources/index.js';

/**
 * CATALOG-02（契约 v1.2 §三.1）的字段与两条硬规则，以及 site 渲染路径的防回退闸门。
 *
 * 这一组专测存在的理由：`/catalog` 的字段齐不齐，用肉眼看永远是“看起来挺全”；
 * 而被删掉一个 key、把中文物种名回落成拉丁名、把源 id 写到页面上当标签，这三种事
 * **都不会让任何现有断言红**——页面只是悄悄变得没法读。
 */

const catalogOf = (registry = defaultRegistry) => buildCatalog(registry, { version: '0.1.1+svc.8.test' });

describe('servicesCatalog：字典只有一份，且覆盖全部 key', () => {
  it('顶层字典的 key 集合与封闭词表逐项相等（多加/少加都红）', () => {
    const catalog = catalogOf();
    expect(catalog.servicesCatalog.map((entry) => entry.key).sort())
      .toEqual([...CATALOG_SERVICE_KEYS].sort());
    expect(catalog.servicesCatalog).toHaveLength(SERVICES_CATALOG.length);
  });

  it('字典每一项都有非空 label 与 hint（页面直接渲染，空串等于没写）', () => {
    for (const entry of catalogOf().servicesCatalog) {
      expect(entry.label.trim().length, `${entry.key} 缺 label`).toBeGreaterThan(0);
      expect(entry.hint.trim().length, `${entry.key} 缺 hint`).toBeGreaterThan(0);
    }
  });
});

describe('每源 services：非空、key 在字典内、由 manifest 显式声明', () => {
  it('全部 10 个源都有非空 services，且每个 key 都在字典里', () => {
    const catalog = catalogOf();
    const keys = new Set(catalog.servicesCatalog.map((entry) => entry.key));
    expect(catalog.sources.length).toBeGreaterThanOrEqual(10);
    for (const source of catalog.sources) {
      expect(source.services.length, `${source.id} 的 services 为空`).toBeGreaterThan(0);
      for (const key of source.services) {
        expect(keys.has(key), `${source.id} 声明了字典外的 key：${key}`).toBe(true);
      }
    }
  });

  it('services 来自 manifest 声明本身（不是从工具名推断）', () => {
    const catalog = catalogOf();
    for (const bundle of defaultRegistry.listSources()) {
      const entry = catalog.sources.find((source) => source.id === bundle.manifest.id);
      expect(entry?.services).toEqual([...bundle.manifest.services]);
    }
  });

  it('负控：manifest 声明空 services → 组装时抛错（不许悄悄放过）', () => {
    const registry = createRegistry();
    // 直接构造一个空 services 的源：走 register 会被 types 挡住，这里用 cast 模拟“漏写”
    const broken = { ...registry.listSources()[0]!.manifest, id: 'broken', displayName: '坏源（Broken）', services: [] };
    expect(() => buildCatalog(
      { listSources: () => [{ ...registry.listSources()[0]!, manifest: broken }], listTools: () => [], listMetaTools: () => [] } as never,
      { version: 't' },
    )).toThrow(/没有声明 services/);
  });
});

describe('species：中文映射，缺一条不许回落拉丁名', () => {
  it('每源 species 都是中文，且不含拉丁字母', () => {
    for (const source of catalogOf().sources) {
      expect(source.species.length, `${source.id} 没有物种`).toBeGreaterThan(0);
      for (const name of source.species) {
        expect(name, `${source.id} 的物种「${name}」是拉丁名，说明映射漏了`).not.toMatch(/[A-Za-z]/);
      }
    }
  });

  it('映射表覆盖注册表里出现的全部拉丁名（新增源漏映射即红）', () => {
    const latins = new Set<string>();
    for (const bundle of defaultRegistry.listSources()) for (const latin of bundle.manifest.species) latins.add(latin);
    const missing = [...latins].filter((latin) => !(latin in SPECIES_NAMES_ZH));
    expect(missing, `这些物种没有中文映射：${missing.join(', ')}`).toEqual([]);
  });

  it('负控：未知拉丁名必须抛，不许回落', () => {
    expect(() => speciesNameZh('Unknownus plantus')).toThrow(/没有中文映射/);
  });
});

describe('generatedAt：注册表快照时刻（创建后不可变）', () => {
  it('同一实例两次生成：generatedAt 与内容哈希全等', () => {
    const a = catalogOf();
    const b = catalogOf();
    expect(b.generatedAt).toBe(a.generatedAt);
    const digestOf = (c: ReturnType<typeof catalogOf>) => JSON.stringify({ ...c, generatedAt: '' });
    expect(digestOf(b)).toBe(digestOf(a));
  });

  it('新建实例：时间可不同，但内容哈希必须相同（ETag 按内容算，不按时间）', () => {
    const a = catalogOf();
    const b = catalogOf(createRegistry());
    const digestOf = (c: ReturnType<typeof catalogOf>) => JSON.stringify({ ...c, generatedAt: '' });
    expect(digestOf(b)).toBe(digestOf(a));
  });

  it('seal 之后再加源必须抛错（这是 generatedAt 不需要失效机制的前提）', () => {
    const registry = createRegistry();
    expect(() => registry.register({ ...registry.listSources()[0]!, manifest: { ...registry.listSources()[0]!.manifest, id: 'late' } }))
      .toThrow(/已 seal/);
  });
});

/**
 * site 渲染路径防回退（负责人 2026-11-03 裁定）。
 *
 * 要防的是「把内部代号当用户看的标签」；`PLANTOMICS_SOURCES=wheatomics` 这类命令行示例
 * 属于另一类文本，允许存在——但它必须待在 `<code>` / `<pre>` / 命令行上下文里，
 * 一旦写进普通段落或标题就红。
 */
describe('site 渲染路径：源 id 只许待在代码/命令上下文里', () => {
  const readRendering = (): { file: string; line: string; index: number }[] => {
    const out: { file: string; line: string; index: number }[] = [];
    // `source-icons.js` 是生成的数据表（源 id → 图标与主色），源 id 是它的键，
    // 从 `src/core/source-icons.json` 经 build-data 生成，不是渲染文案。算进来这道闸
    // 就天生是红的——第一次运行即误报的检查，下一个人会直接关掉。
    const GENERATED_DATA = new Set(['site/assets/source-icons.js']);
    const files = ['site/index.html', ...readdirSync('site/assets')
      .filter((name) => name.endsWith('.js'))
      .map((name) => `site/assets/${name}`)
      .filter((file) => !GENERATED_DATA.has(file))];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => out.push({ file, line, index: index + 1 }));
    }
    return out;
  };

  it('源 id 出现在普通段落/标题里就红（代码、命令示例、注释不算）', () => {
    // 去掉与编程语言/通用英文词同形的源 id：string 在 JS 里到处都是，
    // 按整词扫会把 	ypeof x === 'string' 判成泄漏源 id——那是误报，不是缺陷。
    const ID_LOOKALIKES = new Set(['string']);
    const ids = defaultRegistry.listSources().map((bundle) => bundle.manifest.id)
      .filter((id) => id.length >= 4 && !ID_LOOKALIKES.has(id));
    const offenders: string[] = [];
    for (const { file, line, index } of readRendering()) {
      const inCode = /<code>|<pre>|PLANTOMICS_SOURCES|--transport|npm run|npx /i.test(line);
      if (inCode) continue;
      for (const id of ids) {
        // 只认「整词出现」，避免把 `string` 之类英文词误判
        if (new RegExp(`\\b${id}\\b`).test(line)) offenders.push(`${file}:${index} 出现源 id「${id}」`);
      }
    }
    expect(offenders, `渲染路径把内部源 id 当用户可见文本：\n${offenders.join('\n')}`).toEqual([]);
  });
});

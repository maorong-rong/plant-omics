import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import { invokeTool } from '../src/core/invoke.js';
import type { Fetcher } from '../src/core/types.js';
import { manifest } from '../src/sources/strawberry/manifest.js';
import { tools } from '../src/sources/strawberry/tools.js';

type Obj = Record<string, unknown>;
interface Capture { url: string; at: string; status: number; contentType: string; originalBytes: number; originalSampleCount?: number; originalAssemblyCount?: number }
function fixture(name: string): { capture: Capture; payload: Obj } {
  return JSON.parse(readFileSync(new URL(`../src/sources/strawberry/fixtures/${name}.json`, import.meta.url), 'utf8'));
}
function def(name: string) {
  const tool = tools.find((t) => t.name === `strawberry_${name}`);
  if (!tool) throw new Error(`Missing ${name}`);
  return tool;
}
function replay(name: string, mutate?: (data: Obj) => void) {
  const { capture, payload } = fixture(name);
  mutate?.(payload);
  const urls: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const http: Fetcher = async <T>(url: string, opts?: { signal?: AbortSignal }) => {
    urls.push(url);
    signals.push(opts?.signal);
    return { data: payload as T, url, status: capture.status, contentType: capture.contentType, durationMs: 7, attempts: 1 };
  };
  return { ctx: { http }, urls, signals, payload, capture };
}
const argsFor: Record<string, Obj> = {
  catalog: {},
  gene_lookup: { geneId: 'BCIN_01g00010' },
  expression: { geneId: 'FvesChr1G00279070.1' },
  synteny: { geneId: 'Fxa1Ag00001', sourceAssembly: 'fxa_benihoppe', targetAssembly: 'fxa_camarosa' },
  tf_members: { family: 'ERF', pageSize: 2 },
};
const fixtureFor: Record<string, string> = { catalog: 'catalog', gene_lookup: 'gene-lookup', expression: 'expression', synteny: 'synteny', tf_members: 'tf-matches' };
function dataRows(text: string): number {
  return text.split('\n').filter((line) => line.startsWith('|')).length - 2;
}

describe('Strawberry five GET tools (offline replay only)', () => {
  it('has exactly the approved contracts and T1 status probe manifest', () => {
    expect(tools.map((t) => t.name)).toEqual(['strawberry_catalog', 'strawberry_gene_lookup', 'strawberry_expression', 'strawberry_synteny', 'strawberry_tf_members']);
    for (const tool of tools) {
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(50);
    }
    expect(manifest.tier).toBe('T1');
    expect(manifest.probe.path).toBe('/genes/status');
    expect(manifest.docs).toMatch(/openapi.json$/);
    expect(manifest.lastProbe?.date).toBe('2026-10-28');
    expect(manifest.displayName).toContain('相关病原');
  });

  it.each(Object.keys(argsFor))('%s returns bounded formatted text and complete provenance; raw stays separate', async (name) => {
    const r = replay(fixtureFor[name]!);
    const result = await invokeTool(def(name), argsFor[name]!, { http: r.ctx.http });
    expect(r.urls).toHaveLength(1);
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
    expect(result.text).toContain(`GET ${r.urls[0]}`);
    expect(result.text).toContain('HTTP 200');
    expect(result.text).toContain('7 ms');
    expect(result.meta.sourceId).toBe('strawberry');
    expect(result.text).toContain(result.meta.at);
    expect(result.meta.at).toMatch(/^202\d-\d\d-\d\dT/);
    expect(result.raw).toBe(r.payload);
    expect(result.text).not.toContain('"proteinSequence":');
    expect(result.text).not.toContain('"matches":');
    expect(result.text).not.toContain('"samples":');
  });

  it('catalog filters locally, displays a real assembly example and distinguishes generatedAt', async () => {
    const r = replay('catalog');
    const result = await def('catalog').run({ module: 'GENOME' }, r.ctx);
    expect(new URL(r.urls[0]!).search).toBe('');
    expect(result.meta.request).toContain('"module":"GENOME"');
    // GENOME also matches Registered genome files and pangenome: real substring semantics.
    expect(result.text).toContain('目录模块15个；匹配3个；实际展示3个');
    expect(result.text).toContain('Botrytis cinerea');
    expect(result.text).toContain('120请求/分钟');
    expect(result.text).toContain('目录生成时间=');
    expect(result.text).toContain('不是数据版本');
    // Fixture is trimmed: do not turn its 3 retained entries into the real original 60.
    expect(r.capture.originalAssemblyCount).toBe(60);
    expect(result.text).toContain('装配目录返回3项');
  });

  it('catalog no local module match is a real local-filter zero, not a schema fallback', async () => {
    const r = replay('catalog');
    const result = await def('catalog').run({ module: 'not-a-module' }, r.ctx);
    expect(result.text).toContain('匹配0个；实际展示0个');
  });

  it('gene lookup omits protein/CDS by default and transcribes response version', async () => {
    const r = replay('gene-lookup');
    const result = await def('gene_lookup').run(argsFor.gene_lookup!, r.ctx);
    expect(result.text).toContain('310 aa');
    expect(result.text).toContain('Botrytis cinerea');
    expect(result.text).toContain('B05.10 GCA_000143535.4(Molecular Plant Pathology. 2017)');
    expect(result.text).toContain('KEGG：0项');
    expect(result.text).not.toContain(String(r.payload.proteinSequence).slice(0, 40));
    expect(result.text).not.toContain(String(r.payload.cdsSequence).slice(0, 40));
    expect(result.meta.request).toContain('"includeSequence":false');
    expect(new URL(r.urls[0]!).searchParams.has('includeSequence')).toBe(false);
  });

  it('optional protein prefix is <=120 aa, explicitly incomplete and not a download', async () => {
    const r = replay('gene-lookup');
    const result = await def('gene_lookup').run({ ...argsFor.gene_lookup, includeSequence: true }, r.ctx);
    expect(result.text).toContain('非完整序列：展示120/310 aa');
    expect(result.text).toContain('不可用于完整序列分析');
    expect(result.text).toContain(String(r.payload.proteinSequence).slice(0, 120));
    expect(result.text).not.toContain(String(r.payload.proteinSequence).slice(0, 121));
    expect(result.meta.request).toContain('"includeSequence":true');
  });

  it('keeps exact species/version spelling and URL encoding; no local presentation query', async () => {
    const r = replay('gene-lookup');
    const organism = 'Fragaria × ananassa';
    const version = 'v1.0 (Paper. 2023) + 原始&注释';
    const result = await def('gene_lookup').run({ geneId: 'x/y?z&1', species: organism, version, includeSequence: true }, r.ctx);
    const url = new URL(r.urls[0]!);
    expect(url.searchParams.get('geneId')).toBe('x/y?z&1');
    expect(url.searchParams.get('species')).toBe(organism);
    expect(url.searchParams.get('version')).toBe(version);
    expect(url.searchParams.has('includeSequence')).toBe(false);
    expect(result.text).toContain(url.href);
  });

  it('expression uses real tissue mean/sampleCount and keeps batch-corrected TPM', async () => {
    const r = replay('expression');
    const result = await def('expression').run({ ...argsFor.expression, top: 2 }, r.ctx);
    expect(result.text).toContain('组织9个；实际展示2个');
    expect(result.text).toContain('检测样本数233');
    expect(result.text).toContain('不是总样本数');
    expect(result.text).toContain('batch-corrected TPM');
    expect(result.text).toContain('dataset=fragaria-vesca-strawberry-atlas-2026');
    expect(result.text).toContain('profileType=replicate_matrix');
    expect(result.text).toContain('| Carpel |');
    expect(dataRows(result.text)).toBe(2);
    expect(r.capture.originalSampleCount).toBe(233);
    expect((r.payload.samples as unknown[]).length).toBe(2);
    expect(new URL(r.urls[0]!).searchParams.has('top')).toBe(false);
    expect(result.meta.request).toContain('"top":2');
  });

  it('expression dataset is sent unchanged and top defaults are explicit', async () => {
    const r = replay('expression');
    const result = await def('expression').run({ ...argsFor.expression, dataset: 'fragaria-vesca-strawberry-atlas-2026' }, r.ctx);
    expect(new URL(r.urls[0]!).searchParams.get('dataset')).toBe('fragaria-vesca-strawberry-atlas-2026');
    expect(result.meta.request).toContain('"top":8');
  });

  it('synteny reports true counts, real versions and upstream truncation; local maxBlocks does not leak', async () => {
    const r = replay('synteny');
    const result = await def('synteny').run({ ...argsFor.synteny, maxBlocks: 1 }, r.ctx);
    expect(result.text).toContain('总块数3；上游返回3；实际展示1；上游truncated=false');
    expect(result.text).toContain('Benihoppe v1.0.a1(Horticulture Research. 2023)');
    expect(result.text).toContain('v1.0.a2(Horticulture Research. 2021)');
    expect(result.text).toContain('不等于一对一正交或功能等价');
    expect(dataRows(result.text)).toBe(1);
    expect(new URL(r.urls[0]!).searchParams.has('maxBlocks')).toBe(false);
    expect(result.meta.request).toContain('"maxBlocks":1');
  });

  it('TF preserves matches total/returned/shown and reports this-response release unknown', async () => {
    const r = replay('tf-matches');
    const result = await def('tf_members').run(argsFor.tf_members!, r.ctx);
    expect(result.text).toContain('total=10677；本页返回2；实际展示2');
    expect(result.text).toContain('release=未知（本次响应未声明）');
    expect(new URL(r.urls[0]!).searchParams.get('page')).toBe('1');
    expect(new URL(r.urls[0]!).searchParams.get('pageSize')).toBe('2');
    expect(new URL(r.urls[0]!).searchParams.has('maxShown')).toBe(false);
    expect(result.meta.request).toContain('"maxShown":20');
  });

  it('TF true zero matches fixture is legal, including page metadata', async () => {
    const r = replay('tf-empty');
    const result = await def('tf_members').run({ family: 'NOT_A_FAMILY' }, r.ctx);
    expect(result.text).toContain('total=0；本页返回0；实际展示0');
    expect(result.text).toContain('已验证合法空结果');
  });

  it('TF refuses summary even when a supplied filter produced it', async () => {
    const r = replay('tf-summary');
    await expect(def('tf_members').run({ family: 'ERF' }, r.ctx)).rejects.toThrow(/意外summary/);
  });

  it('TF mock large page counts only complete byte-fitted rows as shown (never more than20)', async () => {
    const r = replay('tf-matches', (data) => {
      const first = (data.matches as Obj[])[0]!;
      data.matches = Array.from({ length: 100 }, (_, n) => ({ ...first, geneId: `Hap1_gene_${n}` }));
      data.pageSize = 100;
    });
    const result = await def('tf_members').run({ family: 'ERF', pageSize: 100 }, r.ctx);
    const shown = Number(result.text.match(/实际展示(\d+)/)?.[1]);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(20);
    expect(shown).toBe(dataRows(result.text));
    expect(result.text).toContain('本页返回100');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
    expect(result.text).not.toContain('正文已按');
  });

  it('simulated present release is used only from the current response', async () => {
    const r = replay('tf-matches', (data) => { data.summary = { release: { id: 'mock-current-release' } }; });
    const result = await def('tf_members').run(argsFor.tf_members!, r.ctx);
    expect(result.text).toContain('release=mock-current-release');
  });

  const badArgs: Array<[string, Obj]> = [
    ['gene_lookup', {}], ['gene_lookup', { geneId: '  ' }], ['gene_lookup', { geneId: 7 }],
    ['gene_lookup', { geneId: 'x', species: '' }], ['gene_lookup', { geneId: 'x', version: null }],
    ['gene_lookup', { geneId: 'x', includeSequence: 'false' }], ['gene_lookup', { geneId: 'x', includeSequence: 0 }],
    ['expression', { geneId: 'x', dataset: ' ' }], ['expression', { geneId: 'x', top: '2' }],
    ['expression', { geneId: 'x', top: 1.5 }], ['expression', { geneId: 'x', top: 31 }],
    ['synteny', { geneId: 'x', sourceAssembly: 'y' }], ['synteny', { ...argsFor.synteny, maxBlocks: 11 }],
    ['tf_members', {}], ['tf_members', { family: ' ' }], ['tf_members', { family: ['ERF'] }],
    ['tf_members', { family: 'ERF', page: 0 }], ['tf_members', { family: 'ERF', page: 100001 }],
    ['tf_members', { family: 'ERF', pageSize: 101 }], ['tf_members', { family: 'ERF', pageSize: NaN }],
    ['catalog', { module: {} }], ['catalog', { unknown: 'x' }],
  ];
  it.each(badArgs)('rejects invalid %s %j before HTTP', async (name, args) => {
    const r = replay(fixtureFor[name]!);
    await expect(def(name).run(args, r.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(r.urls).toHaveLength(0);
  });

  it.each(['geneId', 'dataset', 'family', 'assembly', 'type', 'species', 'version', 'module'])('enforces source Unicode cap for %s before HTTP', async (key) => {
    const name = key === 'module' ? 'catalog' : key === 'dataset' ? 'expression' : ['family', 'assembly', 'type'].includes(key) ? 'tf_members' : 'gene_lookup';
    const cap = key === 'module' ? 128 : ['species', 'version'].includes(key) ? 512 : 256;
    const r = replay(fixtureFor[name]!);
    await expect(def(name).run({ ...argsFor[name], [key]: 'a'.repeat(cap + 1) }, r.ctx)).rejects.toThrow(/码点上限/);
    expect(r.urls).toHaveLength(0);
  });

  it('uses codepoints, not UTF16 units, for the local module cap', async () => {
    const r = replay('catalog');
    await expect(def('catalog').run({ module: '🌱'.repeat(128) }, r.ctx)).resolves.toBeDefined();
    expect(r.urls).toHaveLength(1);
  });

  it('rejects encoded multibyte request evidence >1536B without truncating or HTTP', async () => {
    const r = replay('gene-lookup');
    await expect(def('gene_lookup').run({ geneId: '麦'.repeat(200) }, r.ctx)).rejects.toThrow(/1536/);
    expect(r.urls).toHaveLength(0);
  });

  it('does not truncate a valid full request longer than300 chars', async () => {
    const r = replay('gene-lookup');
    const version = 'v'.repeat(400);
    const result = await def('gene_lookup').run({ geneId: 'x', version }, r.ctx);
    expect(result.text).toContain(version);
    expect(result.meta.request).toContain(new URL(r.urls[0]!).href);
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });

  it('forwards cancellation signal through fetchPrepared', async () => {
    const r = replay('catalog');
    const signal = new AbortController().signal;
    await def('catalog').run({}, { ...r.ctx, signal });
    expect(r.signals).toEqual([signal]);
  });

  it.each([['gene_lookup', 'gene-lookup-404'], ['expression', 'expression-empty'], ['synteny', 'synteny-empty']])('%s real missing-query fixture is HTML404, not biological absence', async (name, file) => {
    const r = replay(file);
    await expect(def(name).run(argsFor[name]!, r.ctx)).rejects.toThrow(/无法据此判断基因是否存在/);
  });

  it('simulated non-JSON success is format error, not zero or field drift', async () => {
    const r = replay('catalog');
    const http: Fetcher = async <T>(url: string) => ({ data: '<html>fallback</html>' as T, url, status: 200, contentType: 'text/html', attempts: 1, durationMs: 1 });
    await expect(def('catalog').run({}, { http })).rejects.toThrow(/响应格式错误/);
    expect(r.urls).toHaveLength(0);
  });

  const drift: Array<[string, (data: Obj) => void]> = [
    ['catalog', (d) => { delete d.modules; }], ['catalog', (d) => { d.assemblies = []; }],
    ['gene_lookup', (d) => { delete d.id; }], ['gene_lookup', (d) => { d.proteinSequence = {}; }],
    ['gene_lookup', (d) => { d.geneOntology = {}; }],
    ['expression', (d) => { delete d.tissues; }], ['expression', (d) => { d.tissues = []; }],
    ['expression', (d) => { (d.tissues as Obj[])[0]!.mean = null; }],
    ['expression', (d) => { (d.tissues as Obj[])[0]!.sampleCount = '9'; }],
    ['synteny', (d) => { d.blocks = []; }], ['synteny', (d) => { d.totalBlockCount = 0; }],
    ['synteny', (d) => { d.truncated = 'false'; }],
    ['tf_members', (d) => { delete d.matches; }], ['tf_members', (d) => { d.total = '10677'; }],
    ['tf_members', (d) => { d.matches = [null]; }], ['tf_members', (d) => { d.page = 2; }],
  ];
  it.each(drift)('rejects mutated %s structure (simulated, not live evidence)', async (name, mutation) => {
    const r = replay(fixtureFor[name]!, mutation);
    await expect(def(name).run(argsFor[name]!, r.ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('does not silently clip anomalously long upstream version metadata', async () => {
    const r = replay('gene-lookup', (d) => { d.version = '版'.repeat(1000); });
    await expect(def('gene_lookup').run(argsFor.gene_lookup!, r.ctx)).rejects.toThrow(/完整出处超过2560/);
  });

  it('injected transport errors keep full GET and presentation evidence, never raw payload', async () => {
    const http: Fetcher = async (url) => { throw new UpstreamError('模拟限流', { url, status: 429 }); };
    try {
      await def('expression').run({ geneId: 'x', top: 3 }, { http });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).meta.status).toBe(429);
      expect((error as UpstreamError).meta.request).toContain('"top":3');
      expect((error as UpstreamError).meta.request).toContain('geneId=x');
    }
  });
});

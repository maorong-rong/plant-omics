import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, UpstreamError, UpstreamShapeError, describeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import { ToolRegistry } from '../src/core/registry.js';
import type { Fetcher } from '../src/core/types.js';
import { manifest } from '../src/sources/scod/manifest.js';
import { geneRegion, genomeList, tools } from '../src/sources/scod/tools.js';
import { validateProbe } from '../src/sources/scod/probe.js';

/** 合成反例工厂；下方独立describe使用经过原体哈希核对的四份真实裁剪fixture。 */
const simulated = {
  genomes: () => [{ genomeId: 1, name: 'S. spontaneum Np-X', species: 'Saccharum spontaneum', submitter: 'PRIVATE_SENTINEL' }],
  page: (total = 2, start = 0, length = 5): any => ({ draw: 1, recordsTotal: total, recordsFiltered: total, error: null,
    data: Array.from({ length: Math.min(length, Math.max(0, total - start)) }, (_, i) => ({ genomeId: 1,
      geneId: `Npp.TEST${start + i}.1`, chrom: 'Chr1A', posStart: String(130574 + (start + i) * 10),
      posEnd: String(130580 + (start + i) * 10), description: 'PRIVATE_SENTINEL', genome: { submitter: 'PRIVATE_SENTINEL' } })),
  }),
};
const args = { genome_id: 1, chrom: 'Chr1A', pos_start: 100000, pos_end: 200000 };
function context(payload: unknown, status = 200) {
  const urls: string[] = [];
  const http = (async (url: string) => { urls.push(url); return { data: payload, url, status, durationMs: 8, attempts: 1 }; }) as Fetcher;
  return { ctx: { http }, urls };
}

const readFixture = (file: string) => JSON.parse(readFileSync(new URL(`../src/sources/scod/fixtures/${file}`, import.meta.url), 'utf8'));

describe('SCOD：四份真实裁剪fixture离线回放', () => {
  it('目录14条及probe通过，不读取裁掉的提交者与文献信息', async () => {
    const f = readFixture('genome-list.json');
    expect(f.capture.simulated).toBe(false);
    expect(f.capture.sourceBytes).toBe(13222);
    expect(f.payload).toHaveLength(14);
    expect(() => validateProbe(f.payload)).not.toThrow();
    const out = await genomeList.run({}, context(f.payload).ctx);
    expect((out.raw as any).total).toBe(14);
    expect((out.raw as any).records[0]).toMatchObject({ genome_id: 1, species: 'Saccharum spontaneum' });
    expect(out.text).toContain('共14条');
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });
  it('真实正例4条均完全包含在100000–200000之内', async () => {
    const f = readFixture('gene-region-pos.json');
    expect(f.payload.data).toHaveLength(4);
    for (const r of f.payload.data) {
      expect(typeof r.posStart).toBe('string');
      expect(typeof r.posEnd).toBe('string');
      expect(Number(r.posStart)).toBeGreaterThanOrEqual(100000);
      expect(Number(r.posEnd)).toBeLessThanOrEqual(200000);
    }
    const out = await geneRegion.run(args, context(f.payload).ctx);
    expect(out.raw).toMatchObject({ records_total: 4, records_filtered: 4, returned: 4, shown: 4 });
    expect((out.raw as any).records[0]).toMatchObject({ gene_id: 'Npp.01A000040.1', pos_start: 130574, pos_end: 133277 });
    expect(out.text).not.toContain('正文已按');
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
  });
  it('真实空结果是0与空数组，不是null或缺键', async () => {
    const f = readFixture('gene-region-empty.json');
    expect(f.payload.recordsTotal).toBe(0);
    expect(f.payload.recordsFiltered).toBe(0);
    expect(f.payload.data).toEqual([]);
    const out = await geneRegion.run({ ...args, pos_start: 1, pos_end: 100 }, context(f.payload).ctx);
    expect(out.text).toContain('0条不等于“这个位置没有基因”');
    expect(out.raw).toMatchObject({ returned: 0, shown: 0 });
  });
  it('真实服务端分页11总数、2条本页；下一页start=2', async () => {
    const f = readFixture('gene-region-page-length2.json');
    expect(f.payload.recordsTotal).toBe(11);
    expect(f.payload.data).toHaveLength(2);
    const out = await geneRegion.run({ ...args, pos_end: 300000, length: 2 }, context(f.payload).ctx);
    expect(out.raw).toMatchObject({ records_total: 11, records_filtered: 11, returned: 2, shown: 2, next_start: 2 });
    expect(out.text).toContain('下一页start=2');
    expect(out.meta.request).toContain('length=2');
  });
  it.each([
    ['genome-list.json', 13222, '8E3139272DBCDB3BE575971327D9F0BB7227FC4EB00D07335185293DC48C844E'],
    ['gene-region-pos.json', 8176, '95806F261CDE99C3CBC0A08B13302A5C7BA6DEE93D1F278676FE22E2CB731644'],
    ['gene-region-empty.json', 89, '513AF86FE5397C0D2BB039CB28EB9F1F35735F221E6EE61F53752260D3760D3A'],
    ['gene-region-page-length2.json', 4053, '163E004A390A258C7AB5AC1EEC9D7973540E89F9520DE579E4633C1A0DA05DF6'],
  ])('真实fixture %s只保留字段白名单与原计数，带原体指纹', (file, size, hash) => {
    const f = readFixture(file as string);
    expect(f.capture).toMatchObject({ simulated: false, sourceBytes: size, sourceSha256: hash, status: 200 });
    const allowed = Array.isArray(f.payload) ? ['genomeId', 'name', 'species'] : ['genomeId', 'geneId', 'chrom', 'posStart', 'posEnd'];
    const rows = Array.isArray(f.payload) ? f.payload : f.payload.data;
    for (const row of rows) expect(Object.keys(row).sort()).toEqual([...allowed].sort());
    expect(JSON.stringify(f.payload)).not.toMatch(/submitter|publication|rawLink|description|annotation|@/);
  });
});

describe('SCOD：simulated离线契约与反例', () => {
  it('T2两意图在独立注册表硬校验通过，不改全仓装配', () => {
    const registry = new ToolRegistry();
    registry.register({ manifest, tools, validateProbe });
    expect(registry.listTools().map(t => t.name)).toEqual(['scod_genome_list', 'scod_gene_region']);
    expect(registry.listSources()).toHaveLength(1);
    expect(manifest.tier).toBe('T2');
  });
  it('目录是裸数组，请求保留term=，不读submitter等额外字段', async () => {
    const { ctx, urls } = context(simulated.genomes());
    const out = await genomeList.run({}, ctx);
    expect(urls).toEqual(['https://ngdc.cncb.ac.cn/scod/api/genome/list?term=']);
    expect(out.text).toContain('S. spontaneum Np-X');
    expect(out.text).toContain('共1条，展示1条');
    expect(out.text).toContain('HTTP 200');
    expect(out.meta.at).toMatch(/^\d{4}-/);
    expect(JSON.stringify(out)).not.toContain('PRIVATE_SENTINEL');
  });
  it('目录名称隐私哨兵从正文和raw省略', async () => {
    const payload = simulated.genomes(); payload[0]!.name = 'person@example.com';
    const out = await genomeList.run({}, context(payload).ctx);
    expect(JSON.stringify(out)).not.toContain('person@example.com');
    expect(out.text).toContain('隐私省略');
  });
  it.each([{}, { data: [] }, [], [null], [{ genomeId: 1 }]])('目录结构漂移不冒充合法空目录 %j', async payload => {
    await expect(genomeList.run({}, context(payload).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it('目录重复ID报错', async () => {
    const a = simulated.genomes(); a.push(a[0]!);
    await expect(genomeList.run({}, context(a).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it('目录大时准确报裁剪条数且不裁出处', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ genomeId: i + 1, name: 'S. spontaneum Np-X', species: 'Saccharum spontaneum' }));
    const out = await genomeList.run({}, context(many).ctx);
    const raw = out.raw as { total: number; shown: number; omitted: number };
    expect(raw.total).toBe(30); expect(raw.shown + raw.omitted).toBe(30);
    expect(out.text).toContain(`展示${raw.shown}条`);
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
    expect(out.text).not.toContain('正文已按');
  });
  it('区域查询传全套分页参数；字符串坐标转数值，完整本页展示', async () => {
    const { ctx, urls } = context(simulated.page(11, 0, 2));
    const out = await geneRegion.run({ ...args, length: 2 }, ctx);
    const url = new URL(urls[0]!);
    expect(Object.fromEntries(url.searchParams)).toEqual({ genomeId: '1', chrom: 'Chr1A', posStart: '100000', posEnd: '200000', start: '0', length: '2', draw: '1' });
    expect(out.raw).toMatchObject({ records_total: 11, records_filtered: 11, returned: 2, shown: 2, next_start: 2 });
    expect((out.raw as any).records[0].pos_start).toBe(130574);
    expect(out.text).toContain('本页返回并展示2条');
    expect(out.text).toContain('下一页start=2');
    expect(out.text).toContain('0条不等于“这个位置没有基因”');
    expect(JSON.stringify(out)).not.toContain('PRIVATE_SENTINEL');
    expect(out.text).not.toContain('正文已按');
  });
  it('合法0条与越过末页分别说明', async () => {
    const empty = await geneRegion.run(args, context(simulated.page(0)).ctx);
    expect(empty.text).toContain('本次整体包含条件无匹配');
    const beyond = await geneRegion.run({ ...args, start: 20 }, context(simulated.page(11, 20)).ctx);
    expect(beyond.text).toContain('分页已越过末尾');
    expect(beyond.text).not.toContain('本次整体包含条件无匹配');
  });
  it('recordsFiltered为筛选计数，不拿data.length或recordsTotal替代', async () => {
    const p = simulated.page(2); p.recordsTotal = 100;
    const out = await geneRegion.run(args, context(p).ctx);
    expect(out.raw).toMatchObject({ records_total: 100, records_filtered: 2, returned: 2 });
    expect(out.text).toContain('recordsTotal=100，recordsFiltered=2');
  });
  it('等端点不自动扩窗，不猜最小宽度；上游0不说无基因', async () => {
    const { ctx, urls } = context(simulated.page(0));
    const out = await geneRegion.run({ ...args, pos_start: 130574, pos_end: 130574 }, ctx);
    expect(urls[0]).toContain('posStart=130574&posEnd=130574');
    expect(out.text).toContain('0条不等于');
  });
  it.each([
    ['缺计数', (p: any) => { delete p.recordsTotal; }],
    ['负计数', (p: any) => { p.recordsFiltered = -1; }],
    ['计数字符串', (p: any) => { p.recordsTotal = '2'; }],
    ['缺数组', (p: any) => { delete p.data; }],
    ['数组内null', (p: any) => { p.data[0] = null; }],
    ['有总数却空页', (p: any) => { p.data = []; }],
    ['串基因组', (p: any) => { p.data[0].genomeId = 2; }],
    ['串染色体', (p: any) => { p.data[0].chrom = 'chr1A'; }],
    ['坐标null', (p: any) => { p.data[0].posStart = null; }],
    ['坐标浮点串', (p: any) => { p.data[0].posStart = '130574.5'; }],
    ['起点越界', (p: any) => { p.data[0].posStart = '99999'; }],
    ['终点越界', (p: any) => { p.data[0].posEnd = '200001'; }],
    ['身份重复', (p: any) => { p.data[1].geneId = p.data[0].geneId; }],
    ['draw错配', (p: any) => { p.draw = 2; }],
  ])('%s严格报漂移', async (_label, mutate) => {
    const p = simulated.page(); mutate(p);
    await expect(geneRegion.run(args, context(p).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it('业务error不当作0条，不回显服务器路径', async () => {
    const p = simulated.page(0); p.error = '/private/server/path contact@example.com';
    try { await geneRegion.run(args, context(p).ctx); throw new Error('unexpected success'); }
    catch (e) { expect(e).toBeInstanceOf(UpstreamError); expect(describeError(e)).not.toContain('/private/server/path'); }
  });
  it.each([
    { ...args, length: 51 }, { ...args, length: 0 }, { ...args, length: 1.5 }, { ...args, length: '2' },
    { ...args, start: -1 }, { ...args, genome_id: 0 }, { ...args, chrom: 'chr1A' },
    { ...args, pos_start: 0 }, { ...args, pos_start: 300000 }, { ...args, term: 'x' },
  ])('参数非法零请求 %j', async input => {
    const { ctx, urls } = context(simulated.page());
    await expect(geneRegion.run(input, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(urls).toHaveLength(0);
  });
  it('大页若超正文预算明确报错，不本地丢行冒充整页', async () => {
    const { ctx, urls } = context(simulated.page(50, 0, 50));
    await expect(geneRegion.run({ ...args, length: 50 }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(urls[0]).toContain('length=50');
  });
  it('上游错误不冒充查无、原错误文本不透出', async () => {
    const http = (async (url: string) => { throw new UpstreamError('/private/path contact@example.com', { url, status: 404, bodySnippet: 'PRIVATE_SENTINEL' }); }) as Fetcher;
    try { await geneRegion.run(args, { http }); throw new Error('unexpected success'); }
    catch (e) {
      expect(e).toBeInstanceOf(UpstreamError);
      expect(describeError(e)).not.toMatch(/private|example|SENTINEL/);
      expect(describeError(e)).toContain('genomeId=1');
    }
  });
  it('probe只验目录，失败抛异常', () => {
    expect(() => validateProbe(simulated.genomes())).not.toThrow();
    expect(() => validateProbe({ data: [] })).toThrow(UpstreamShapeError);
    expect(() => validateProbe([])).toThrow(UpstreamShapeError);
  });
});

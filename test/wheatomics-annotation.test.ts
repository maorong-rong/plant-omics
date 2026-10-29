import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import type { Fetcher, ToolContext } from '../src/core/types.js';
import { geneAnnotation } from '../src/sources/wheatomics/annotation.js';

const fixture = (kind: string) => JSON.parse(readFileSync(new URL(`../src/sources/wheatomics/fixtures/pfam-${kind}.json`, import.meta.url), 'utf8')).payload;
function context(payload: unknown) {
  const urls: string[] = [];
  const http = (async (url: string) => { urls.push(url); return { data: payload, url, status: 200, durationMs: 7, attempts: 1 }; }) as Fetcher;
  return { ctx: { http } as ToolContext, urls };
}
const args = { pfam_id: 'PF00319' };

describe('WheatOmics Pfam 注释（全离线）', () => {
  it('真实裁剪回放：保留358条计数，正文和raw按展示范围裁剪', async () => {
    const { ctx, urls } = context(fixture('pos'));
    const out = await geneAnnotation.run(args, ctx);
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect([...url.searchParams.keys()]).toEqual(['ID']);
    expect(url.searchParams.get('ID')).toBe('PF00319');
    expect(out.text).toContain('共 358 条');
    expect(out.text).toContain('坐标单位：Mb');
    expect(out.text).toContain('8.652783');
    const raw = out.raw as { shown: number; omitted: number; records: unknown[] };
    expect(out.text).toContain(`展示 ${raw.shown} 条`);
    expect(raw.omitted).toBe(358 - raw.shown);
    expect(raw.records).toHaveLength(raw.shown);
    expect(out.text.split('\n').filter(l => l.startsWith('|')).length - 2).toBe(raw.shown);
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
    expect(out.text).not.toContain('正文已按');
    expect(out.meta.request).toContain('ID=PF00319');
    expect(out.meta.request).toContain('"limit":5');
  });
  it('count=0和空数组是合法空结果', async () => {
    const out = await geneAnnotation.run({ pfam_id: 'PF999999' }, context(fixture('neg')).ctx);
    expect(out.text).toContain('共 0 条，展示 0 条');
    expect(out.text).toContain('上游明确返回');
  });
  it('limit仅影响本地展示，计数和尾行一致', async () => {
    const out = await geneAnnotation.run({ ...args, limit: 20 }, context(fixture('pos')).ctx);
    const raw = out.raw as { shown: number; omitted: number };
    expect(raw.shown).toBeGreaterThan(0);
    expect(raw.shown).toBeLessThanOrEqual(20);
    expect(out.text).toContain(`另有 ${raw.omitted} 条未展示`);
    expect(out.text).not.toContain('正文已按');
  });
  it.each([
    ['缺count', (p: any) => { delete p.data.count; }],
    ['负count', (p: any) => { p.data.count = -1; }],
    ['null记录', (p: any) => { p.data.records[0] = null; }],
    ['计数不符', (p: any) => { p.data.count = 0; }],
    ['结构域错配', (p: any) => { p.data.domain = 'PF99999'; }],
    ['表错配', (p: any) => { p.data.table = 'UNREQUESTED'; }],
    ['坐标字符串', (p: any) => { p.data.records[0].start_mb = '1'; }],
    ['缺基因', (p: any) => { delete p.data.records[0].gene_primary; }],
    ['单条域错配', (p: any) => { p.data.records[0].domain = 'PF99999: other'; }],
  ])('%s不当作合法结果（合成反例）', async (_name, mutate) => {
    const payload = fixture('pos'); mutate(payload);
    await expect(geneAnnotation.run(args, context(payload).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it.each([{ pfam_id: 'X' }, { ...args, limit: 0 }, { ...args, limit: 21 }, { ...args, offset: 1 }])('非法参数零请求 %j', async input => {
    const { ctx, urls } = context(fixture('pos'));
    await expect(geneAnnotation.run(input, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(urls).toHaveLength(0);
  });
  it('自由文本与额外字段不进入正文或raw（合成哨兵）', async () => {
    const payload = fixture('pos');
    payload.data.secret = 'PRIVATE_SENTINEL';
    payload.data.records[0].description = 'PRIVATE_SENTINEL';
    payload.data.records[0].contact = 'PRIVATE_SENTINEL';
    const out = await geneAnnotation.run(args, context(payload).ctx);
    expect(JSON.stringify(out)).not.toContain('PRIVATE_SENTINEL');
  });
  it('404不能吞为查无', async () => {
    const http = (async (url: string) => { throw new UpstreamError('上游404', { url, status: 404 }); }) as Fetcher;
    await expect(geneAnnotation.run(args, { http })).rejects.toMatchObject({ meta: { status: 404 } });
  });
});

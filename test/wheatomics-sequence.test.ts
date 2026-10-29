import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, UpstreamError, UpstreamShapeError, describeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import { createFetcher } from '../src/core/http.js';
import type { Fetcher } from '../src/core/types.js';
import { geneSequence } from '../src/sources/wheatomics/sequence.js';

const id = 'TraesCS5A02G391700';
const read = (kind: string) => JSON.parse(readFileSync(new URL(`../src/sources/wheatomics/fixtures/sequence-${kind}.json`, import.meta.url), 'utf8'));
function context(payload: unknown) {
  const urls: string[] = [];
  const http = (async (url: string) => { urls.push(url); return { data: payload, url, status: 200, durationMs: 9, attempts: 1 }; }) as Fetcher;
  return { ctx: { http }, urls };
}
function synthetic(sequence: string, kind = 'gene') {
  return { gene_id: id, [`${kind}_sequence`]: `>${id}.1\n${sequence}` };
}

describe('WheatOmics仅基因序列分块（全离线）', () => {
  it.each([['gene', 735], ['protein', 244]])('真实%s按单条去重长度%s，不拼接，不数头行换行', async (kind, total) => {
    const { ctx, urls } = context(read('pos').payload);
    const out = await geneSequence.run({ gene_id: id, sequence_type: kind }, ctx);
    const raw = out.raw as { total_length: number; upstream_records: number; duplicates_removed: number; sequence: string };
    expect(raw.total_length).toBe(total);
    expect(raw.sequence).toHaveLength(total as number);
    expect(raw.upstream_records).toBe(2);
    expect(raw.duplicates_removed).toBe(1);
    expect(out.text).toContain('已去重');
    expect(out.text).toContain('本地1起位置，非基因组坐标');
    expect(out.text).not.toContain('正文已按');
    expect(urls).toHaveLength(1);
    expect([...new URL(urls[0]!).searchParams.keys()]).toEqual(['gene_id']);
    expect(out.meta.request).toContain(`"sequence_type":"${kind}"`);
    expect(out.meta.request).toContain('"offset":1,"length":1000');
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
  });
  it('模拟长序列1000块完整；下一块连续，不丢不重', async () => {
    const seq = 'ACGT'.repeat(575);
    const out1 = await geneSequence.run({ gene_id: id }, context(synthetic(seq)).ctx);
    const out2 = await geneSequence.run({ gene_id: id, offset: 1001 }, context(synthetic(seq)).ctx);
    const out3 = await geneSequence.run({ gene_id: id, offset: 2001 }, context(synthetic(seq)).ctx);
    const raws = [out1, out2, out3].map(o => o.raw as { sequence: string; next_offset?: number });
    expect(raws.map(r => r.sequence.length)).toEqual([1000, 1000, 300]);
    expect(raws.map(r => r.next_offset)).toEqual([1001, 2001, undefined]);
    expect(raws.map(r => r.sequence).join('')).toBe(seq);
    for (const out of [out1, out2, out3]) {
      expect(out.text).not.toContain('正文已按');
      expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
      expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
    }
  });
  it('本地offset=2、length=3准确切出第2–4位', async () => {
    const out = await geneSequence.run({ gene_id: id, offset: 2, length: 3 }, context(synthetic('ACGTACGT')).ctx);
    expect(out.raw).toMatchObject({ sequence: 'CGT', total_length: 8, offset: 2, end: 4, next_offset: 5 });
    expect(out.text).toContain('第2–4位');
  });
  it('越过末尾不是查无，无下一块', async () => {
    const out = await geneSequence.run({ gene_id: id, offset: 736 }, context(read('pos').payload).ctx);
    expect(out.text).toContain('已越过末尾；不是查无序列');
    expect(out.raw).toMatchObject({ total_length: 735, sequence: '', shown_length: 0 });
  });
  it('仅by-gene已验证JSON404判本次未找到，并保留404出处', async () => {
    const f = read('neg');
    const http = (async (url: string) => { throw new UpstreamError('404', { url, status: 404,
      contentType: f.capture.contentType, bodySnippet: JSON.stringify(f.payload), attempts: 1 }); }) as Fetcher;
    const out = await geneSequence.run({ gene_id: 'TraesCS9Z99G999999' }, { http });
    expect(out.meta.status).toBe(404);
    expect(out.text).toContain('不代表基因不存在');
    expect(out.text).toContain('HTTP 404');
    expect(out.raw).toMatchObject({ found: false });
  });
  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['Application/Problem+JSON; charset=UTF-8', true],
    ['application/jsonp', false],
    ['application/problem+jsonp', false],
    ['x-application/json', false],
    ['text/application/json', false],
    ['application/json trailing', false],
    ['application/foo bar+json', false],
    ['application/json, text/html', false],
  ])('SEQ-01：真实HTTP层Response桩媒体类型 %s → 查无=%s', async (contentType, allowed) => {
    const payload = read('neg').payload;
    let calls = 0;
    const http = createFetcher({ retries: 0 }, async () => {
      calls += 1;
      return new Response(JSON.stringify(payload), { status: 404, headers: { 'content-type': contentType as string } });
    });
    const run = geneSequence.run({ gene_id: 'TraesCS9Z99G999999' }, { http });
    if (allowed) {
      const out = await run;
      expect(out.raw).toMatchObject({ found: false });
      expect(out.meta.status).toBe(404);
    } else {
      await expect(run).rejects.toBeInstanceOf(UpstreamError);
    }
    expect(calls).toBe(1);
  });
  it.each([
    ['HTML404', 'text/html', '<html>not found</html>', 404],
    ['改版404', 'application/json', '{"detail":"Not Found"}', 404],
    ['串号404', 'application/json', JSON.stringify({ detail: 'No sequence found for OTHER (tried: OTHER, OTHER.1).' }), 404],
    ['400带路径', 'application/json', '{"detail":"/private/server/path"}', 400],
    ['503', 'application/json', '{}', 503],
  ])('%s不吞为查无，错误不泄漏原正文', async (_label, contentType, bodySnippet, status) => {
    const http = (async (url: string) => { throw new UpstreamError('上游失败', { url, status: status as number, contentType: contentType as string, bodySnippet: bodySnippet as string }); }) as Fetcher;
    try { await geneSequence.run({ gene_id: id }, { http }); throw new Error('unexpected success'); }
    catch (e) { expect(e).toBeInstanceOf(UpstreamError); expect(describeError(e)).not.toContain('/private/server/path'); }
  });
  it.each([
    ['顶层身份错', (p: any) => { p.gene_id = 'OTHER'; }],
    ['缺序列', (p: any) => { delete p.gene_sequence; }],
    ['null序列', (p: any) => { p.gene_sequence = null; }],
    ['无FASTA头', (p: any) => { p.gene_sequence = 'ACGT'; }],
    ['空FASTA记录', (p: any) => { p.gene_sequence = `>${id}.1\n`; }],
    ['相同ID不同内容', (p: any) => { p.gene_sequence = `>${id}.1\nACGT\n>${id}.1\nACGA`; }],
    ['多个ID', (p: any) => { p.gene_sequence = `>${id}.1\nACGT\n>${id}.2\nACGT`; }],
    ['正文非法字符', (p: any) => { p.gene_sequence = `>${id}.1\nAC邮箱GT`; }],
  ])('%s报结构漂移（合成反例）', async (_label, mutate) => {
    const p = read('pos').payload; mutate(p);
    await expect(geneSequence.run({ gene_id: id }, context(p).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it.each([
    { gene_id: id, region: 'Chr1A_Chinese_Spring1.0:200-500' },
    { gene_id: id, length: 1001 }, { gene_id: id, length: 0 }, { gene_id: id, length: 1.5 },
    { gene_id: id, offset: 0 }, { gene_id: id, offset: '1' }, { gene_id: id, sequence_type: 'genome' },
    { gene_id: 'X' }, { gene_id: id, offset: Number.MAX_SAFE_INTEGER + 1 },
  ])('非法参数零请求 %j', async args => {
    const { ctx, urls } = context(read('pos').payload);
    await expect(geneSequence.run(args, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(urls).toHaveLength(0);
  });
  it('raw和文本不输出附加字段、未选序列或FASTA自由头', async () => {
    const p = synthetic('ACGT');
    p.gene_sequence = `>${id}.1 PRIVATE_SENTINEL\nACGT`;
    const out = await geneSequence.run({ gene_id: id }, context({ ...p, additional_sequences: 'PRIVATE_SENTINEL', private: 'PRIVATE_SENTINEL', protein_sequence: 'PRIVATE_SENTINEL' }).ctx);
    expect(JSON.stringify(out)).not.toContain('PRIVATE_SENTINEL');
  });
  it('蛋白终止符不冒充氨基酸残基，明确计数口径', async () => {
    const out = await geneSequence.run({ gene_id: id, sequence_type: 'protein' }, context(synthetic('MGR*', 'protein')).ctx);
    expect(out.raw).toMatchObject({ total_length: 4, unit: '序列符号（含*终止标记）', sequence: 'MGR*' });
    expect(out.text).toContain('含*终止标记');
  });
  it('同ID不同头行不悄悄去重', async () => {
    const p = synthetic('ACGT'); p.gene_sequence += `\n>${id}.1 other\nACGT`;
    await expect(geneSequence.run({ gene_id: id }, context(p).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, UpstreamError, UpstreamShapeError, describeError } from '../src/core/errors.js';
import { createFetcher } from '../src/core/http.js';
import { utf8Bytes } from '../src/core/format.js';
import { ToolRegistry } from '../src/core/registry.js';
import type { Fetcher } from '../src/core/types.js';
import { manifest } from '../src/sources/ensemblplants/manifest.js';
import { SPECIES, classify400, lookupGene, sequence, tools, xrefs, SNIPPET_LIMIT } from '../src/sources/ensemblplants/tools.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../src/sources/ensemblplants/fixtures/${name}`, import.meta.url), 'utf8'));
const pos = () => read('lookup-symbol-pos.json');
const idPos = () => read('lookup-id-pos.json');
const sp = 'arabidopsis_thaliana';

function ok(payload: unknown) {
  const urls: string[] = [];
  const http = (async (url: string) => { urls.push(url); return { data: payload, url, status: 200, durationMs: 9, attempts: 1, contentType: 'application/json' }; }) as Fetcher;
  return { ctx: { http }, urls };
}
function httpError(status: number, body: unknown, contentType = 'application/json', opts: { rawBody?: string; bodySnippet?: string } = {}) {
  const urls: string[] = [];
  const text = opts.rawBody ?? opts.bodySnippet ?? JSON.stringify(body);
  const http = (async (url: string) => {
    urls.push(url);
    throw new UpstreamError('上游失败', { url, status, contentType, bodySnippet: text,
      ...(opts.rawBody === undefined ? {} : { rawBody: opts.rawBody }) } as any);
  }) as Fetcher;
  return { ctx: { http }, urls };
}

describe('Ensembl Plants lookup_gene：真实裁剪 fixture 回放', () => {
  it('符号正例 441 B 原样回放，物种经响应侧核验', async () => {
    const f = pos();
    expect(f.capture).toMatchObject({ status: 200, sourceBytes: 441, simulated: false });
    const { ctx, urls } = ok(f.payload);
    const out = await lookupGene.run({ species: sp, symbol: 'FT' }, ctx);
    expect(urls[0]).toBe('https://rest.ensembl.org/lookup/symbol/arabidopsis_thaliana/FT?content-type=application/json');
    expect(out.text).toContain('AT1G65480');
    expect(out.text).toContain('TAIR10');
    expect(out.text).toContain('1:24331373-24333999');
    expect(out.text).toContain('拟南芥');
    expect((out.raw as any).species).toBe(sp);
    expect((out.raw as any).found).toBe(true);
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });
  it('ID 正例回放；ID 请求必须与响应 id 一致', async () => {
    const f = idPos();
    expect(f.capture.sourceBytes).toBe(441);
    const { ctx, urls } = ok(f.payload);
    const out = await lookupGene.run({ species: sp, id: 'AT1G65480' }, ctx);
    expect(urls[0]).toContain('/lookup/id/AT1G65480');
    expect(urls[0]).toContain(`species=${sp}`);
    expect((out.raw as any).id).toBe('AT1G65480');
  });
  it.each([
    ['符号', 'lookup-symbol-neg.json', { symbol: 'NO_SUCH_GENE_ZZZ' }, 'lookup-symbol', 'NO_SUCH_GENE_ZZZ'],
    ['ID', 'lookup-id-neg.json', { id: 'AT9G99999' }, 'lookup-id', 'AT9G99999'],
  ])('%s查无（真实 400）转合法空，且不说“基因不存在”', async (_label, file, query, endpoint, key) => {
    const f = read(file as string);
    const raw = JSON.stringify(f.payload);
    const { ctx } = httpError(400, f.payload, 'application/json', { rawBody: raw });
    const out = await lookupGene.run({ species: sp, ...(query as object) }, ctx);
    expect(out.raw).toMatchObject({ found: false });
    expect(out.text).toContain('上游明确未找到');
    expect(out.text).toContain('不代表该基因在其他库');
    expect(out.meta.status).toBe(400);
    expect(classify400({ endpoint: endpoint as any, requestKey: key as string, contentType: 'application/json', rawBody: raw })).toBe('not-found');
  });
});

describe('ENSP-02：400 分流绑定端点 + 请求身份 + 完整 JSON', () => {
  const good = JSON.stringify({ error: 'No valid lookup found for symbol FT' });
  const goodId = JSON.stringify({ error: "ID 'AT1G65480' not found" });
  it('四条全满足才归空', () => {
    expect(classify400({ endpoint: 'lookup-symbol', requestKey: 'FT', contentType: 'application/json', rawBody: good })).toBe('not-found');
    expect(classify400({ endpoint: 'lookup-id', requestKey: 'AT1G65480', contentType: 'application/json', rawBody: goodId })).toBe('not-found');
  });
  it.each([
    ['端点不匹配（符号形态走到 sequence）', { endpoint: 'sequence-id' as const, requestKey: 'FT', contentType: 'application/json', rawBody: good }],
    ['端点不匹配（ID 形态走到 xrefs）', { endpoint: 'xrefs-id' as const, requestKey: 'AT1G65480', contentType: 'application/json', rawBody: goodId }],
    ['请求身份不符', { endpoint: 'lookup-symbol' as const, requestKey: 'VRN1', contentType: 'application/json', rawBody: good }],
    ['非 JSON：jsonp', { endpoint: 'lookup-symbol' as const, requestKey: 'FT', contentType: 'application/jsonp', rawBody: good }],
    ['非 JSON：HTML', { endpoint: 'lookup-symbol' as const, requestKey: 'FT', contentType: 'text/html', rawBody: good }],
    ['畸形 JSON', { endpoint: 'lookup-symbol' as const, requestKey: 'FT', contentType: 'application/json', rawBody: '{"error":"No valid lookup found for symbol FT"' }],
    ['带前后缀（未锚定）', { endpoint: 'lookup-symbol' as const, requestKey: 'FT', contentType: 'application/json', rawBody: `prefix ${good}` }],
    ['截断体（省略号）', { endpoint: 'lookup-symbol' as const, requestKey: 'FT', contentType: 'application/json', rawBody: `${good.slice(0, 40)}…` }],
  ])('%s → 不归空', (_label, input) => {
    expect(classify400(input as any)).not.toBe('not-found');
  });
  it('【ENSP-02 反例】原体含非法换行、被 snippet 压平后看似合法 → 不归空', () => {
    // 原体在字符串内部被塞了换行，本身不是合法 JSON。
    const rawWithNewline = '{"error":"No valid lookup found for symbol\nFT"}';
    // snippet() 的压平结果恰好长得像合法 JSON。
    const flattened = rawWithNewline.replace(/\s+/g, ' ').trim();
    expect(() => JSON.parse(rawWithNewline)).toThrow();
    expect(() => JSON.parse(flattened)).not.toThrow();
    expect(classify400({ endpoint: 'lookup-symbol', requestKey: 'FT', contentType: 'application/json', rawBody: rawWithNewline })).toBe('unknown');
    // 同一输入若只给压平片段（无原体），也必须不归空。
    expect(classify400({ endpoint: 'lookup-symbol', requestKey: 'FT', contentType: 'application/json', bodySnippet: flattened })).toBe('unknown');
  });
  it('缺原体（只有 bodySnippet）→ 一律不归空，即使片段完全合法', () => {
    expect(classify400({ endpoint: 'lookup-symbol', requestKey: 'FT', contentType: 'application/json', bodySnippet: good })).toBe('unknown');
    expect(classify400({ endpoint: 'lookup-id', requestKey: 'AT1G65480', contentType: 'application/json', bodySnippet: goodId })).toBe('unknown');
  });
  it('原体超过 300 且非完整 JSON 形态 → 不归空', () => {
    const long = `{"error":"No valid lookup found for symbol FT","pad":"${'A'.repeat(SNIPPET_LIMIT)}"`;
    expect(classify400({ endpoint: 'lookup-symbol', requestKey: 'FT', contentType: 'application/json', rawBody: long })).toBe('unknown');
  });
  it('参数错（cdna 缺 multiple_sequences）判 bad-request，不归空', () => {
    const body = JSON.stringify({ error: 'Requesting a gene and type not equal to "genomic" can result in multiple sequences. 2 sequences detected. Please rerun your request and specify the multiple_sequences parameter' });
    expect(classify400({ endpoint: 'sequence-id', requestKey: 'AT1G65480', contentType: 'application/json', rawBody: body })).toBe('bad-request');
  });
  it('参数错经工具真实抛错，不返回空结果，且不回显上游原文', async () => {
    const body = { error: 'Requesting a gene and type not equal to "genomic" ... Please rerun ...' };
    const { ctx } = httpError(400, body, 'application/json', { rawBody: JSON.stringify(body) });
    try {
      await lookupGene.run({ species: sp, symbol: 'FT' }, ctx);
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UpstreamError);
      expect(describeError(e)).not.toContain('Please rerun');
    }
  });
});

describe('ENSP-01：物种隔离（响应侧核验，缺证据不放行）', () => {
  it('人类对象（200）被拒：跨分区', async () => {
    const payload = { ...pos().payload, species: 'homo_sapiens', id: 'ENSG00000141510' };
    await expect(lookupGene.run({ species: sp, symbol: 'FT' }, ok(payload).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it('响应缺 species 字段 → 拒答，不默认放行（合成反例）', async () => {
    const payload = { ...pos().payload };
    delete (payload as any).species;
    await expect(lookupGene.run({ species: sp, symbol: 'FT' }, ok(payload).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it('响应物种与请求物种不一致 → 拒答', async () => {
    const payload = { ...pos().payload, species: 'oryza_sativa' };
    await expect(lookupGene.run({ species: sp, symbol: 'FT' }, ok(payload).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it.each(['homo_sapiens', 'zea_mays_old', 'Arabidopsis thaliana', ''])('入参物种 %s 非白名单 → 零请求', async (species) => {
    const { ctx, urls } = ok(pos().payload);
    await expect(lookupGene.run({ species, symbol: 'FT' }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(urls).toHaveLength(0);
  });
  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf'])(
    '【审查反例】原型键 %s 不得通过白名单 → 零请求', async (species) => {
      const { ctx, urls } = ok(pos().payload);
      await expect(lookupGene.run({ species, symbol: 'FT' }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(urls).toHaveLength(0);
    });
  it.each(['constructor', 'toString', '__proto__'])('响应侧物种为原型键 %s → 拒答，不放行', async (species) => {
    const payload = { ...pos().payload, species };
    await expect(lookupGene.run({ species: sp, symbol: 'FT' }, ok(payload).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it('白名单是常量且含四个已实测物种，每个都带当前组装名', () => {
    expect(Object.keys(SPECIES).sort()).toEqual(['arabidopsis_thaliana', 'oryza_sativa', 'triticum_aestivum', 'zea_mays']);
    expect(Object.isFrozen(SPECIES)).toBe(true);
    expect(SPECIES.arabidopsis_thaliana.assembly).toBe('TAIR10');
    expect(SPECIES.oryza_sativa.assembly).toBe('IRGSP-1.0');
    expect(SPECIES.triticum_aestivum.assembly).toBe('IWGSC');
    expect(SPECIES.zea_mays.assembly).toBe('Zm-B73-REFERENCE-NAM-5.0');
  });
  it('【ENSP-06】查无文案带当前组装名', async () => {
    const f = read('lookup-id-neg.json');
    const { ctx } = httpError(400, f.payload, 'application/json', { rawBody: JSON.stringify(f.payload) });
    const out = await lookupGene.run({ species: sp, id: 'AT9G99999' }, ctx);
    expect(out.text).toContain('TAIR10');
    expect(out.text).toContain('基因 ID 分代次');
  });
  it('【ENSP-06】玉米旧编号查无时明确指出 NAM-5.0 与 Zm00001eb…', async () => {
    const body = { error: "ID 'Zm00001d027624' not found" };
    const { ctx } = httpError(400, body, 'application/json', { rawBody: JSON.stringify(body) });
    const out = await lookupGene.run({ species: 'zea_mays', id: 'Zm00001d027624' }, ctx);
    expect(out.text).toContain('Zm-B73-REFERENCE-NAM-5.0');
    expect(out.text).toContain('已实测旧编号');
    expect(out.text).toContain('Zm00001eb');
    expect((out.raw as any).assembly).toBe('Zm-B73-REFERENCE-NAM-5.0');
    expect((out.raw as any).stale_id_hint).toBeTruthy();
  });
  it('正例输出透出 assembly_name 与物种标签', async () => {
    const { ctx } = ok(pos().payload);
    const out = await lookupGene.run({ species: sp, symbol: 'FT' }, ctx);
    expect(out.text).toContain('TAIR10');
    expect(out.text).toContain('拟南芥 Arabidopsis thaliana');
    expect((out.raw as any).assembly_name).toBe('TAIR10');
  });
});

describe('ensemblplants_sequence：两步核验 + 逐条不拼接 + 长度口径', () => {
  const lookupOk = () => idPos().payload;
  /** 两步：第一次 lookup，第二次目标端点。 */
  function twoStep(target: unknown, opts: { lookup?: unknown } = {}) {
    const urls: string[] = [];
    const http = (async (url: string) => {
      urls.push(url);
      const isLookup = url.includes('/lookup/');
      return { data: isLookup ? (opts.lookup ?? lookupOk()) : target, url, status: 200, durationMs: 5,
        attempts: 1, contentType: 'application/json' };
    }) as Fetcher;
    return { ctx: { http }, urls };
  }

  it('【前置 lookup 出处】两次请求各自五要素齐全，含前置请求的查询时刻', async () => {
    const f = read('sequence-protein-multi-pos.json');
    const out = await sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, twoStep(f.payload).ctx);
    expect(out.text).toContain('前置物种核验请求=');
    // 完整请求（含查询参数）——不是只有 pathname
    expect(out.text).toContain('/lookup/id/AT1G65480');
    // HTTP 状态与耗时
    expect(out.text).toMatch(/HTTP 200，\d+ ms/);
    // **查询时刻**：缺了它就只剩一条可复现出处
    expect(out.text).toMatch(/查询时刻 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect((out.raw as any).lookup_request).toContain('/lookup/id/AT1G65480');
  });
  it('【manifest 措辞】只保留已实测旧 ID 本次查无，不推断整类编号', () => {
    const text = manifest.caveats.join('\n');
    expect(text).toContain('Zm00001d027624');
    expect(text).toContain('本次查无');
    expect(text).toContain('不据此判定整类');
    // 不得出现"整类都查不到"式断言
    expect(text).not.toContain('旧编号 Zm00001d… 在本源查不到');
  });
  it('【身份绑定】真实 protein 两条转录本的 query 与 id 均属请求基因', async () => {
    const f = read('sequence-protein-multi-pos.json');
    for (const r of f.payload) {
      expect(r.query).toBe('AT1G65480');
      expect(r.id).toMatch(/^AT1G65480(\.\d+)?$/);
    }
    const out = await sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, twoStep(f.payload).ctx);
    expect((out.raw as any).total_records).toBe(2);
  });
  it.each([
    ['query 指向别的基因', (p: any) => { p[0].query = 'AT1G01010'; }],
    ['id 是别的基因的转录本', (p: any) => { p[0].id = 'AT1G01010.1'; }],
    ['缺 query 字段', (p: any) => { delete p[0].query; }],
    ['id 不是转录本形态', (p: any) => { p[0].id = 'AT1G65480XYZ'; }],
  ])('【身份绑定】%s → 报漂移，拒绝展示', async (_label, mutate) => {
    const f = read('sequence-protein-multi-pos.json');
    const payload = JSON.parse(JSON.stringify(f.payload));
    mutate(payload);
    await expect(sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, twoStep(payload).ctx))
      .rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it('物种措辞不得声称逐条核验，且必须声明残余风险', async () => {
    const f = read('sequence-protein-multi-pos.json');
    const out = await sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, twoStep(f.payload).ctx);
    expect(out.text).toContain('已知残余风险');
    expect(out.text).not.toContain('逐条核验');
    expect(out.text).not.toContain('逐条物种');
  });
  it('【条目核对】重复转录本 ID → 整次拒答，不过滤后返回', async () => {
    const f = read('sequence-protein-multi-pos.json');
    const payload = JSON.parse(JSON.stringify(f.payload));
    payload[1].id = payload[0].id;   // 两条同 ID
    await expect(sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, twoStep(payload).ctx))
      .rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it('【条目核对】protein 里混入 dna 条目 → 整次拒答', async () => {
    const f = read('sequence-protein-multi-pos.json');
    const payload = JSON.parse(JSON.stringify(f.payload));
    payload[1].molecule = 'dna';
    await expect(sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, twoStep(payload).ctx))
      .rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it('【条目核对】长度口径标注为按 seq 字符数计，不假装与上游字段核对', async () => {
    const f = read('sequence-protein-multi-pos.json');
    const out = await sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, twoStep(f.payload).ctx);
    expect(out.text).toContain('长度按 seq 字符数计');
    // 上游确实没有长度字段，不得声称已核对自报长度
    for (const r of f.payload) expect(Object.hasOwn(r, 'length')).toBe(false);
  });
  it('【P1 计数】3 条 × 500 aa：字节闸只渲染 1 条，必须报 shown=1、omitted=2', async () => {
    // 调研者反推：响应字节 ≈ 总氨基酸数 + 98×条数；3×500=1500 aa 远超 1408。
    const three = [0, 1, 2].map((i) => ({ id: `AT1G65480.${i + 1}`, molecule: 'protein',
      seq: 'M'.repeat(500), desc: null, version: null, query: 'AT1G65480' }));
    const { ctx } = twoStep(three);
    const out = await sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, ctx);
    const raw = out.raw as any;
    expect(raw.total_records).toBe(3);
    // **核心断言**：shown 只能是实际渲染条数，不许用"打算展示的 3 条"
    expect(raw.shown).toBe(raw.records.length);
    expect(raw.shown).toBeLessThan(3);
    // **第一层**：从正文反推实际条目数（不读 raw 自报值）
    const inBody = out.text.split('\n').filter((l) => /^\d+\. \S+｜共 \d+ (bp|aa)｜/.test(l)).length;
    expect(inBody).toBe(raw.shown);
    // **第二层**：对上游返回条数
    expect(raw.total_records).toBe(3);
    expect(raw.shown + raw.omitted).toBe(3);
    expect(raw.omitted).toBeGreaterThan(0);
    // 正文必须明示"另有 N 条未展示"，不得谎报"3 条全给了"
    expect(out.text).toContain(`另有 ${raw.omitted} 条未展示`);
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
    // 每条渲染出来的都标截断，长度仍如实报 500
    for (const r of raw.records) {
      expect(r.length).toBe(500);
      expect(r.shown_length).toBeLessThan(500);
      expect(r.truncated).toBe(true);
    }
    expect(out.text).not.toContain('正文已按');
  });
  it('【P1 恒等式·两层】任何次数下：正文实际条目数 = shown，且 shown + omitted = 上游条数', async () => {
    for (const n of [1, 2, 3, 4, 7]) {
      const recs = Array.from({ length: n }, (_, i) => ({ id: `AT1G65480.${i + 1}`, molecule: 'protein',
        seq: 'M'.repeat(n === 7 ? 400 : 20), desc: null, version: null, query: 'AT1G65480' }));
      const out = await sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, twoStep(recs).ctx);
      const raw = out.raw as any;
      // 第二层：对上游条数（不是对另一个自报数字）
      expect(raw.total_records, `n=${n}`).toBe(n);
      expect(raw.shown + raw.omitted, `n=${n}`).toBe(n);
      expect(raw.shown, `n=${n}`).toBeLessThanOrEqual(3);
      // 第一层：**从正文反推**实际渲染条数，不读变量
      const inBody = out.text.split('\n').filter((l) => /^\d+\. \S+｜共 \d+ (bp|aa)｜/.test(l)).length;
      expect(inBody, `n=${n}: 正文条目数必须等于 shown`).toBe(raw.shown);
      expect(raw.records.length, `n=${n}`).toBe(raw.shown);
      if (raw.omitted > 0) expect(out.text, `n=${n}`).toContain('另有');
    }
  });
  it('【双闸】超过 3 条时条数闸触发，报"另有 N 条未展示"', async () => {
    const four = [0, 1, 2, 3].map((i) => ({ id: `AT1G65480.${i + 1}`, molecule: 'protein',
      seq: 'M'.repeat(50), desc: null, version: null, query: 'AT1G65480' }));
    const { ctx } = twoStep(four);
    const out = await sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, ctx);
    const raw = out.raw as any;
    expect(raw.total_records).toBe(4);
    expect(raw.shown).toBe(3);
    expect(raw.omitted).toBe(1);
    expect(out.text).toContain('另有 1 条未展示');
  });
  it('【顶层形态】genomic 是对象、protein 是数组，两种都能解析', async () => {
    const g = read('sequence-genomic-pos.json');
    expect(Array.isArray(g.payload)).toBe(false);
    const p = read('sequence-protein-multi-pos.json');
    expect(Array.isArray(p.payload)).toBe(true);
    const a = await sequence.run({ species: sp, id: 'AT1G65480' }, twoStep(g.payload).ctx);
    const b = await sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, twoStep(p.payload).ctx);
    expect((a.raw as any).total_records).toBe(1);
    expect((b.raw as any).total_records).toBe(2);
  });
  it('物种归属措辞如实：写明是第 1 步确认基因 ID，转录本归属为残余风险', async () => {
    const f = read('sequence-protein-multi-pos.json');
    const out = await sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, twoStep(f.payload).ctx);
    expect(out.text).toContain('物种归属：由第 1 步 lookup/id');
    expect(out.text).toContain('已知残余风险');
    // 不得声称"逐条核验了物种"
    expect(out.text).not.toContain('逐条核验物种');
  });

  it('genomic 真实回放：2627 bp，超预算只给前缀但三项齐全；先 lookup 后 sequence', async () => {
    const f = read('sequence-genomic-pos.json');
    expect(f.capture.sourceBytes).toBe(2755);
    expect(f.payload.seq.length).toBe(2627);
    const { ctx, urls } = twoStep(f.payload);
    const out = await sequence.run({ species: sp, id: 'AT1G65480' }, ctx);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/lookup/id/AT1G65480');
    expect(urls[1]).toContain('/sequence/id/AT1G65480');
    const raw = out.raw as any;
    expect(raw.total_records).toBe(1);
    expect(raw.records[0].length).toBe(2627);
    expect(raw.records[0].truncated).toBe(true);
    expect(raw.records[0].sequence.length).toBeLessThan(2627);
    // 三项同现：完整长度 / 展示区间 / 已截断
    expect(out.text).toContain('共 2627 bp');
    expect(out.text).toContain('第 1–');
    expect(out.text).toContain('已截断，非完整序列');
    // 两次出处都出现
    expect(out.text).toContain('前置物种核验请求=');
    expect(out.text).toContain('/lookup/id/AT1G65480');
    expect(out.text).toContain('/sequence/id/AT1G65480');
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
    expect(out.text).not.toContain('正文已按');
  });

  it('protein 真实回放：2 条（219/175 aa），逐条列出不拼接，单位 aa', async () => {
    const f = read('sequence-protein-multi-pos.json');
    expect(f.payload).toHaveLength(2);
    const { ctx } = twoStep(f.payload);
    const out = await sequence.run({ species: sp, id: 'AT1G65480', type: 'protein' }, ctx);
    const raw = out.raw as any;
    expect(raw.total_records).toBe(2);
    expect(raw.unit).toBe('aa');
    expect(raw.records.map((r: any) => r.length)).toEqual([219, 175]);
    expect(out.text).toContain('AT1G65480.2');
    expect(out.text).toContain('AT1G65480.1');
    expect(out.text).toContain('219 aa');
    expect(out.text).toContain('175 aa');
    expect(out.text).toContain('不拼接');
    // 两条各自的序列都出现，且不是拼接成一条
    expect(raw.records[0].sequence.endsWith(raw.records[1].sequence.slice(0, 10))).toBe(false);
  });

  it('cdna/cds 未开放 → 零请求拒绝', async () => {
    for (const type of ['cdna', 'cds']) {
      const { ctx, urls } = twoStep({});
      await expect(sequence.run({ species: sp, id: 'AT1G65480', type }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(urls).toHaveLength(0);
    }
  });

  it('单位与 molecule 不符 → 报漂移，不按错误单位展示', async () => {
    const f = read('sequence-genomic-pos.json');
    const bad = { ...f.payload, molecule: 'protein' };
    const { ctx } = twoStep(bad);
    await expect(sequence.run({ species: sp, id: 'AT1G65480' }, ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('物种核验失败（lookup 物种不符）→ 不查目标端点', async () => {
    const f = read('sequence-genomic-pos.json');
    const wrongLookup = { ...idPos().payload, species: 'homo_sapiens' };
    const { ctx, urls } = twoStep(f.payload, { lookup: wrongLookup });
    await expect(sequence.run({ species: sp, id: 'AT1G65480' }, ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
    expect(urls.some((u) => u.includes('/sequence/'))).toBe(false);
  });

  it('序列含非法字符 → 报漂移', async () => {
    const f = read('sequence-genomic-pos.json');
    const { ctx } = twoStep({ ...f.payload, seq: 'ACGT邮箱ACGT' });
    await expect(sequence.run({ species: sp, id: 'AT1G65480' }, ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
});

describe('ensemblplants_xrefs：两步核验 + 总数/展示数', () => {
  function twoStep(target: unknown) {
    const urls: string[] = [];
    const http = (async (url: string) => {
      urls.push(url);
      const isLookup = url.includes('/lookup/');
      return { data: isLookup ? idPos().payload : target, url, status: 200, durationMs: 4, attempts: 1,
        contentType: 'application/json' };
    }) as Fetcher;
    return { ctx: { http }, urls };
  }
  it('真实回放：9 条 / 2030 B，报总数并只展示前 N 条', async () => {
    const f = read('xrefs-id-pos.json');
    expect(f.capture.sourceBytes).toBe(2030);
    expect(f.payload).toHaveLength(9);
    const { ctx, urls } = twoStep(f.payload);
    const out = await xrefs.run({ species: sp, id: 'AT1G65480' }, ctx);
    expect(urls).toHaveLength(2);
    const raw = out.raw as any;
    expect(raw.total).toBe(9);
    expect(raw.shown + raw.omitted).toBe(9);
    expect(out.text).toContain('共 9 条跨库映射');
    expect(out.text).toContain(`展示 ${raw.shown} 条`);
    // 9 条能放进 1408 B 时全部展示；只有真的省略时才必须写"另有 N 条"。
    if (raw.omitted > 0) expect(out.text).toContain(`另有 ${raw.omitted} 条未展示`);
    else expect(raw.shown).toBe(9);
    expect(out.text).toContain('前置物种核验请求=');
    expect(out.text).toContain('NASC_GENE_ID');
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
  });
  it('【ENSP-11】xrefs 恒等式：任意条数下 shown + omitted = 总数，且 shown = 实际表格行数', async () => {
    for (const n of [0, 1, 2, 5, 9, 12]) {
      const payload = n === 0 ? [] : Array.from({ length: n }, (_, i) => ({
        dbname: `DB_${i}`, info_type: 'DIRECT', db_display_name: `DB ${i}`,
        display_id: `ID_${i}`, synonyms: [], primary_id: `P_${i}`,
        description: 'd', info_text: '', version: '0',
      }));
      const { ctx } = twoStep(payload);
      const out = await xrefs.run({ species: sp, id: 'AT1G65480' }, ctx);
      const raw = out.raw as any;
      if (n === 0) { expect(raw.total).toBe(0); continue; }
      expect(raw.shown + raw.omitted, `n=${n}`).toBe(n);
      expect(raw.shown, `n=${n}`).toBe(raw.rendered_rows);
      // 正文实际表格数据行数必须等于 shown
      const tableRows = out.text.split('\n').filter((l) => l.trim().startsWith('|')).length - 2;
      expect(tableRows, `n=${n}`).toBe(raw.shown);
      if (raw.omitted > 0) expect(out.text, `n=${n}`).toContain('另有');
    }
  });
  it('【ENSP-11】xrefs 真实回放：9 条时 shown/rendered/表格行数三者一致', async () => {
    const f = read('xrefs-id-pos.json');
    const { ctx } = twoStep(f.payload);
    const out = await xrefs.run({ species: sp, id: 'AT1G65480' }, ctx);
    const raw = out.raw as any;
    expect(raw.total).toBe(9);
    expect(raw.shown).toBe(raw.rendered_rows);
    expect(raw.shown + raw.omitted).toBe(9);
  });
  it('空数组 → 明确空结果，不说"没有该基因"', async () => {
    const { ctx } = twoStep([]);
    const out = await xrefs.run({ species: sp, id: 'AT1G65480' }, ctx);
    expect(out.text).toContain('未返回任何跨库映射');
    expect(out.text).toContain('不代表该基因没有对应记录');
  });
  it('非数组响应 → 报漂移', async () => {
    const { ctx } = twoStep({ foo: 1 });
    await expect(xrefs.run({ species: sp, id: 'AT1G65480' }, ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it('符号与 id 恰好一个；两个都给零请求', async () => {
    const { ctx, urls } = twoStep([]);
    await expect(xrefs.run({ species: sp, id: 'AT1G65480', symbol: 'FT' }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(urls).toHaveLength(0);
  });
});

describe('ENSP-02：经真实公共 HTTP 链回放（createFetcher + Response 桩）', () => {
  const realChain = (status: number, body: string, contentType: string) =>
    createFetcher({ retries: 0 }, async () => new Response(body, { status, headers: { 'content-type': contentType } })) as Fetcher;

  it('合法查无 JSON + 完整原体 → 正确判为"未找到"（rawBody 已落地）', async () => {
    const http = realChain(400, JSON.stringify({ error: 'No valid lookup found for symbol FT' }), 'application/json');
    const out = await lookupGene.run({ species: sp, symbol: 'FT' }, { http });
    expect(out.raw).toMatchObject({ found: false });
    expect(out.text).toContain('上游明确未找到');
    expect(out.meta.status).toBe(400);
  });
  it('【审查反例】畸形 JSON（字符串内非法换行）经公共链 → 必须抛错，不得判查无', async () => {
    const http = realChain(400, '{"error":"No valid lookup found for symbol\nFT"}', 'application/json');
    await expect(lookupGene.run({ species: sp, symbol: 'FT' }, { http })).rejects.toBeInstanceOf(UpstreamError);
  });
  it('HTML 400 → 抛错，不判查无', async () => {
    const http = realChain(400, '<html>err</html>', 'text/html');
    await expect(lookupGene.run({ species: sp, symbol: 'FT' }, { http })).rejects.toBeInstanceOf(UpstreamError);
  });
  it('【元数据】每份 fixture 都必须有完整抓取元数据（URL/状态/字节/日期/客户端）', () => {
    const files = ['lookup-symbol-pos.json', 'lookup-id-pos.json', 'lookup-symbol-neg.json',
      'lookup-id-neg.json', 'sequence-genomic-pos.json', 'sequence-protein-multi-pos.json', 'xrefs-id-pos.json'];
    for (const file of files) {
      const f = read(file);
      expect(f.capture, file).toMatchObject({ simulated: false, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      expect(f.capture.request, file).toMatch(/^GET https:\/\/rest\.ensembl\.org\//);
      expect(typeof f.capture.status, file).toBe('number');
      expect(f.capture.sourceBytes, file).toBeGreaterThan(0);
      expect(f.capture.sourceSha256, file).toMatch(/^[0-9A-F]{64}$/);
      // 抓取客户端：没有它就无法证明这份 fixture 对应哪次请求。
      expect(f.capture.client, file).toBeTruthy();
      // **ENSP-09 三档口径**：确证 / 近似 / 未知。禁止把旁证写成抓取时刻。
      const status = f.capture.captureTimeStatus;
      expect(['确证', '近似', '未知'], file).toContain(status);
      if (status === '确证') {
        expect(f.capture.capturedAt, file).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/);
        expect(Number.isNaN(new Date(f.capture.capturedAt as string).getTime()), file).toBe(false);
      } else {
        // 近似/未知都不得留下会被当成抓取时刻的单点字段
        expect(f.capture.capturedAt, file).toBeUndefined();
        expect(f.capture.captureTimeUpperBound, file).toBeUndefined();
        expect(f.capture.captureTimeNote, file).toBeTruthy();
        if (status === '未知') {
          // 未知档：不许出现任何形似抓取时刻的值
          expect(f.capture.captureTimeRange, file).toBeUndefined();
          expect(f.capture.captureTimeBasis, file).toBeUndefined();
        }
      }
      // **mtime 只能作为"文件写入时间"单独列，不得混入抓取时刻**
      expect(f.capture.fileWriteTimeMtime, file).toMatch(/\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
      expect(f.capture.fileWriteTimeNote, file).toContain('不代表抓取');
      // 可核替代边界：git 首次入库（ISO 8601 带偏移），且明确不替代抓取时刻
      expect(f.capture.firstCommittedAt, file).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
      expect(f.capture.firstCommittedNote, file).toContain('不替代抓取时刻');
    }
  });
  it('503 HTML 未被混入 fixtures', () => {
    const files = ['lookup-symbol-pos.json', 'lookup-id-pos.json', 'sequence-genomic-pos.json',
      'sequence-protein-multi-pos.json', 'xrefs-id-pos.json'];
    for (const file of files) {
      expect(JSON.stringify(read(file).payload), file).not.toContain('503 Service Unavailable');
    }
  });
  it('【ENSP-02】原型键拒绝必须零请求（无任何上游调用也能红）', async () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const { ctx, urls } = ok(pos().payload);
      await expect(lookupGene.run({ species: key, symbol: 'FT' }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
      await expect(sequence.run({ species: key, id: 'AT1G65480' }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
      await expect(xrefs.run({ species: key, id: 'AT1G65480' }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(urls, key).toHaveLength(0);
    }
  });
  it('【包装校验】payload 紧凑序列化后的 SHA256 必须等于 capture.sourceSha256', () => {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const files = ['lookup-symbol-pos.json', 'lookup-id-pos.json', 'lookup-symbol-neg.json',
      'lookup-id-neg.json', 'sequence-genomic-pos.json', 'sequence-protein-multi-pos.json', 'xrefs-id-pos.json'];
    for (const file of files) {
      const f = read(file);
      // 包装结构：{capture, payload}；payload 即上游原体（未改字段值）。
      const payloadBytes = Buffer.from(JSON.stringify(f.payload), 'utf8');
      const digest = createHash('sha256').update(payloadBytes).digest('hex').toUpperCase();
      expect(digest, `${file}: payload 与 capture.sourceSha256 不符`).toBe(f.capture.sourceSha256);
      // 字节数也必须等于实测原体
      expect(payloadBytes.length, file).toBe(f.capture.sourceBytes);
    }
  });
  it('503 错误页单独存放，不按 JSON 解析，且不混入有效 fixture', () => {
    const errDir = new URL('../src/sources/ensemblplants/fixtures/errors/', import.meta.url);
    const errFile = new URL('http-503-service-unavailable.html', errDir);
    const raw = readFileSync(errFile, 'utf8');
    expect(raw).toContain('503 Service Unavailable');
    // 必须不是 JSON：解析应当失败，这正是"不许按 JSON 解析"的证据。
    expect(() => JSON.parse(raw)).toThrow();
    expect(Buffer.byteLength(raw, 'utf8')).toBe(107);
    // 有效 fixture 名单里不得出现该内容
    const valid = ['lookup-symbol-pos.json', 'lookup-id-pos.json', 'lookup-symbol-neg.json',
      'lookup-id-neg.json', 'sequence-genomic-pos.json', 'sequence-protein-multi-pos.json', 'xrefs-id-pos.json'];
    for (const file of valid) {
      expect(JSON.stringify(read(file)), file).not.toContain('503 Service Unavailable');
    }
  });
  it('【rawBody 落地后的接口保持就绪】分类器在给定原体时按原体严格解析', () => {
    // core 尚无 rawBody 字段时，此用例证明：只要原体传入，分类即可正确工作。
    const raw = JSON.stringify({ error: 'No valid lookup found for symbol FT' });
    expect(classify400({ endpoint: 'lookup-symbol', requestKey: 'FT', contentType: 'application/json', rawBody: raw }))
      .toBe('not-found');
    // 仅压平片段（无原体）→ 不判定
    expect(classify400({ endpoint: 'lookup-symbol', requestKey: 'FT', contentType: 'application/json', bodySnippet: raw }))
      .toBe('unknown');
    // 原体被截断（模拟 >4KB 后截断）→ 同样不参与判定
    const huge = JSON.stringify({ error: 'No valid lookup found for symbol FT', pad: 'A'.repeat(5000) });
    expect(classify400({ endpoint: 'lookup-symbol', requestKey: 'FT', contentType: 'application/json', rawBody: huge }))
      .toBe('not-found'); // 未截断则仍可严格解析
    const truncated = `${huge.slice(0, 4096)}`;
    expect(classify400({ endpoint: 'lookup-symbol', requestKey: 'FT', contentType: 'application/json', rawBody: truncated }))
      .toBe('unknown');   // 截断体解析失败 → 不判定
  });
});

describe('参数与结构', () => {
  it.each([
    [{ species: sp }],
    [{ species: sp, symbol: 'FT', id: 'AT1G65480' }],
    [{ species: sp, symbol: 'FT', extra: 1 }],
    [{ species: sp, symbol: 'bad symbol' }],
    [{ species: sp, id: 'x'.repeat(41) }],
  ])('非法参数零请求 %j', async (args) => {
    const { ctx, urls } = ok(pos().payload);
    await expect(lookupGene.run(args as any, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(urls).toHaveLength(0);
  });
  it.each([
    ['缺 id', (p: any) => { delete p.id; }, { symbol: 'FT' }],
    ['start 浮点', (p: any) => { p.start = 1.5; }, { symbol: 'FT' }],
    ['end 小于 start', (p: any) => { p.end = 1; }, { symbol: 'FT' }],
    ['缺 assembly', (p: any) => { delete p.assembly_name; }, { symbol: 'FT' }],
    ['缺 seq_region', (p: any) => { delete p.seq_region_name; }, { symbol: 'FT' }],
    ['ID 请求回显了别的基因', (p: any) => { p.id = 'AT1G01010'; }, { id: 'AT1G65480' }],
    ['符号请求回显了别的基因', (p: any) => { p.display_name = 'VRN1'; }, { symbol: 'FT' }],
  ])('%s 报漂移', async (_label, mutate, query) => {
    const payload = pos().payload; mutate(payload);
    await expect(lookupGene.run({ species: sp, ...(query as object) }, ok(payload).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });
  it('5xx 只说本次失败，不判源不可用；HTML 也能处理', async () => {
    const http = (async (url: string) => {
      throw new UpstreamError('上游失败', { url, status: 500, contentType: 'text/html', bodySnippet: '<html>error</html>', attempts: 3 });
    }) as Fetcher;
    try {
      await lookupGene.run({ species: sp, symbol: 'FT' }, { http });
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UpstreamError);
      const msg = describeError(e);
      expect(msg).toContain('本次请求失败');
      expect(msg).toContain('已重试 2 次');
      expect(msg).not.toMatch(/不可用|故障|坏了/);
    }
  });
  it('在独立注册表登记通过硬校验；三个工具名都带源前缀', () => {
    const registry = new ToolRegistry();
    registry.register({ manifest, tools });
    expect(registry.listTools().map((t) => t.name))
      .toEqual(['ensemblplants_lookup_gene', 'ensemblplants_sequence', 'ensemblplants_xrefs']);
    expect(manifest.tier).toBe('T1');
    expect(manifest.docs).toBeTruthy();
  });
  it('描述不暗示批量能力，且旧编号提示必须在 description 里（用户可见）', () => {
    expect(lookupGene.description).toContain('不支持批量查询');
    // ENSP-06：模型只在调用时看 description，提示写在记录里等于对用户不可见。
    expect(lookupGene.description).toContain('分代次');
    expect(lookupGene.description).toContain('Zm00001d');
    expect(lookupGene.description).toContain('Zm00001eb');
    expect(lookupGene.description).toContain('NAM-5.0');
    expect(lookupGene.description).toContain('玉米');
  });
});

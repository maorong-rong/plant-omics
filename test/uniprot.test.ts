import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../src/core/errors.js';
import { createFetcher } from '../src/core/http.js';
import { utf8Bytes } from '../src/core/format.js';
import { ToolRegistry } from '../src/core/registry.js';
import type { Fetcher } from '../src/core/types.js';
import { manifest } from '../src/sources/uniprot/manifest.js';
import { assertEndpointMatchesUrl, getEntry, searchProteins, tools } from '../src/sources/uniprot/tools.js';

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../src/sources/uniprot/fixtures/${name}`, import.meta.url), 'utf8'));
const payload = (name: string) => read(name).payload;

/** 成功桩：直接给 data，记录 URL。 */
function ok(data: unknown, headers: Record<string, string> = { 'x-uniprot-release': '2026_03' }) {
  const urls: string[] = [];
  const http = (async (url: string) => {
    urls.push(url);
    return { data, url, status: 200, durationMs: 400, attempts: 1, contentType: 'application/json', headers };
  }) as Fetcher;
  return { ctx: { http }, urls };
}

/** 真实公共链 + Response 桩：验证错误分流。 */
function realChain(status: number, body: string, contentType = 'application/json'): Fetcher {
  return createFetcher({ retries: 0 }, async () => new Response(body, {
    status, headers: { 'content-type': contentType },
  })) as Fetcher;
}

describe('UniProt 真实 fixture 回放', () => {
  it('检索正例：2,787 B / 2 条，含 reviewed 与 unreviewed 各一条', async () => {
    const f = payload('search-pos.json');
    // 真实 x-total-results 在**响应头**里（fixture 记在 capture.xTotalResults）
    const out = await searchProteins.run({ organism_id: 3702, gene: 'FT' },
      ok(f, { 'x-total-results': '2', 'x-uniprot-release': '2026_03' }).ctx);
    const raw = out.raw as { totalResults: number; returned: number; records: Array<{ accession: string; entryType: string; lengthAa: number }> };
    expect(raw.totalResults).toBe(2);
    expect(raw.returned).toBe(2);
    // **entryType 必须标**（负责人 2026-11-01 要求）：同基因两个版本
    const types = raw.records.map((r) => r.entryType);
    expect(types).toContain('已审（Swiss-Prot）');
    expect(types).toContain('未审（TrEMBL）');
    expect(out.text).toContain('已审（Swiss-Prot）');
    expect(out.text).toContain('未审（TrEMBL）');
  });

  it('**长度单位是氨基酸数**：正文必须标「氨基酸」，且不得把氨基酸当 bp 表述', async () => {
    const out = await searchProteins.run({ organism_id: 3702, gene: 'FT' },
      ok(payload('search-pos.json'), { 'x-total-results': '2', 'x-uniprot-release': '2026_03' }).ctx);
    expect(out.text).toContain('氨基酸');
    // 正文里出现「碱基」只允许在**否定句**（"不是碱基数"），不能有肯定式 bp 表述
    expect(out.text).not.toMatch(/\d+\s*bp/i);
    expect(out.text).not.toMatch(/\d+\s*碱基/);
    const raw = out.raw as { records: Array<{ lengthAa?: number }> };
    // 实测 Q9SXZ2 的 sequence.length=175（氨基酸）
    expect(raw.records.some((r) => r.lengthAa === 175)).toBe(true);
  });

  it('空结果：x-total-results=0 时可确定说「命中 0 条」', async () => {
    const out = await searchProteins.run({ organism_id: 3702, gene: 'NOSUCHGENEZZZ' },
      ok(payload('search-empty.json'), { 'x-total-results': '0', 'x-uniprot-release': '2026_03' }).ctx);
    expect(out.text).toContain('命中 0 条');
    expect(out.text).toContain('x-total-results=0');
    // 仍必须给用户能改的条件 + 当前值 + 动作
    expect(out.text).toContain('可做的');
    expect(out.text).toContain('3702');
  });

  it('**缺 x-total-results 时不许说「命中 0 条」**（无计数头则原因不明）', async () => {
    const out = await searchProteins.run({ organism_id: 3702, gene: 'NOSUCHGENEZZZ' },
      ok(payload('search-empty.json'), { 'x-uniprot-release': '2026_03' }).ctx);
    // 结构断言：计数头非 value 档 → 结论行不可能是「命中 0 条」（不靠字面反向匹配）
      expect((out.raw as { countHeader?: string }).countHeader).not.toBe('value');
    expect(out.text).toContain('未提供 x-total-results');
    expect(out.text).toContain('这不等于');
  });

  it('单条正例：P46290 → 120 氨基酸，不返回序列本体', async () => {
    const out = await getEntry.run({ accession: 'P46290' }, ok(payload('entry-pos.json')).ctx);
    const raw = out.raw as { accession: string; lengthAa: number; hasSequence: boolean; gene?: string };
    expect(raw.accession).toBe('P46290');
    expect(raw.lengthAa).toBe(120);      // 实测 sequence.length
    expect(raw.hasSequence).toBe(true);  // 上游确有序列
    // **但正文不给序列本体**
    expect(out.text).toContain('本工具不返回序列本体');
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });

  it('单条：**长度单位写「氨基酸」**', async () => {
    const out = await getEntry.run({ accession: 'P46290' }, ok(payload('entry-pos.json')).ctx);
    expect(out.text).toContain('长度(氨基酸)');
    expect(out.text).not.toContain('bp');
  });
});

/**
 * 审查第①条：**真实公共链会不会丢掉 `x-total-results` 计数头**。
 *
 * 这是全批最关键的一条：如果公共层不传头，源层看 `data` 就永远分不清
 * "真 0 条"与"上游没给计数"，而我的 40 例专测是**手工往桩里塞 headers** 的，
 * 正好绕过了这一层——**测试绿了，但真实链路可能是坏的**。
 *
 * 所以这里**不用桩**，用 `createFetcher` 走真实公共层（离线，靠本地 Response 构造），
 * 断言 `headers` 被保留下来且 `x-total-results` 可读。
 */
describe('【审查第①条】真实公共链必须保留计数头', () => {
  /**
   * `x-total-results` 头值是否属"非法"。
   * 判据必须与实现一致：**纯数字 且 落在安全整数内**——
   * 只判纯数字会放过 `'999999999999999999999'`（`Number()` 后是 1e+21，仍是有限数）。
   */
  const headingIsInvalid = (v: string | undefined): boolean => {
    if (v === undefined) return false;
    const t = v.trim();
    if (t === '') return false;                 // 空值走 empty 档，不是 invalid
    if (!/^\d+$/.test(t)) return true;          // 非纯数字
    return !Number.isSafeInteger(Number(t));    // 超安全整数
  };

  it('createFetcher 返回的 HttpResult 带 headers，且 x-total-results 可读', async () => {
    const http = createFetcher({ retries: 0 }, async () => new Response(
      JSON.stringify({ results: [] }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-total-results': '0', 'x-uniprot-release': '2026_03' } },
    )) as Fetcher;
    const res = await http('https://rest.uniprot.org/uniprotkb/search?query=x');
    expect(res.headers, '公共层必须传出响应头').toBeTruthy();
    expect(res.headers!['x-total-results']).toBe('0');
  });

  it('**走真实公共层**：空结果能据此确定说「命中 0 条」', async () => {
    // 关键：不手工塞 headers，headers 由 Response 带出来、经 createFetcher 传到源层
    const http = createFetcher({ retries: 0 }, async () => new Response(
      JSON.stringify({ results: [] }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-total-results': '0', 'x-uniprot-release': '2026_03' } },
    )) as Fetcher;
    const out = await searchProteins.run({ organism_id: 3702, gene: 'NOSUCHGENEZZZ' }, { http });
    expect(out.text).toContain('命中 0 条');
    expect(out.text).toContain('x-total-results=0');
    expect((out.raw as { totalResults: number | null }).totalResults).toBe(0);
  });

  it('走真实公共层：上游**不给**计数头时，不许说「命中 0 条」', async () => {
    const http = createFetcher({ retries: 0 }, async () => new Response(
      JSON.stringify({ results: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as Fetcher;
    const out = await searchProteins.run({ organism_id: 3702, gene: 'NOSUCHGENEZZZ' }, { http });
    // 结构断言：计数头非 value 档 → 结论行不可能是「命中 0 条」（不靠字面反向匹配）
      expect((out.raw as { countHeader?: string }).countHeader).not.toBe('value');
    expect(out.text).toContain('未提供 x-total-results');
    expect((out.raw as { totalResults: number | null }).totalResults).toBeNull();
  });

  /**
   * 审查 REV-UNIPROT 抓到的「空串变 0」：
   * `x-total-results: ""` 经 `Number('') === 0` 且 `isSafeInteger(0)` 为真，
   * 会被当成"上游说命中 0 条"。**空头 ≠ 0**。
   */
  it('【空值头】x-total-results="" 不许变成「命中 0 条」', async () => {
    const http = createFetcher({ retries: 0 }, async () => new Response(
      JSON.stringify({ results: [] }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-total-results': '' } },
    )) as Fetcher;
    const out = await searchProteins.run({ organism_id: 3702, gene: 'NOSUCHGENEZZZ' }, { http });
    // 结构断言：计数头非 value 档 → 结论行不可能是「命中 0 条」（不靠字面反向匹配）
      expect((out.raw as { countHeader?: string }).countHeader).not.toBe('value');
    expect(out.text).toContain('值为空');
    expect(out.text).toContain('这不等于命中 0 条');
    const raw = out.raw as { totalResults: number | null; countHeader: string };
    expect(raw.totalResults).toBeNull();
    expect(raw.countHeader).toBe('empty');   // 与 absent 分开，不混成一种
  });

  it('【空值头】全空格同样不算 0', async () => {
    const http = createFetcher({ retries: 0 }, async () => new Response(
      JSON.stringify({ results: [] }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-total-results': '   ' } },
    )) as Fetcher;
    const out = await searchProteins.run({ organism_id: 3702, gene: 'NOSUCHGENEZZZ' }, { http });
    // 结构断言：计数头非 value 档 → 结论行不可能是「命中 0 条」（不靠字面反向匹配）
      expect((out.raw as { countHeader?: string }).countHeader).not.toBe('value');
  });

  it('【计数头四态】值 / 缺席 / 空值 / 非法 各自分开', async () => {
    const cases: Array<[string | undefined, string]> = [
      ['0', '值 0 → 命中 0 条'],
      [undefined, '缺席 → 未提供'],
      ['', '空值 → 值为空'],
      ['abc', '非法 → 抛错'],
      ['-1', '负数 → 抛错（只接受纯数字）'],
      ['1.5', '小数 → 抛错'],
      // 超长数字：`Number('999…')` = 1e+21 仍是有限数，只靠 isFinite 会放行
      ['999999999999999999999', '超安全整数 → 抛错（不能当成 1e21 条）'],
    ];
    for (const [headerVal, label] of cases) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (headerVal !== undefined) headers['x-total-results'] = headerVal;
      const http = createFetcher({ retries: 0 }, async () => new Response(
        JSON.stringify({ results: [] }), { status: 200, headers },
      )) as Fetcher;
      const run = searchProteins.run({ organism_id: 3702, gene: 'X' }, { http });
      if (headingIsInvalid(headerVal)) {
        // ② 非数字 → 抛错（"给错了"，不是"没给"）
        await expect(run, label).rejects.toBeInstanceOf(UpstreamShapeError);
      } else {
        const out = await run;
        const raw = out.raw as { totalResults: number | null; countHeader: string };
        /**
         * **不用 `not.toContain(语义短语)`**（负责人 2026-11-01 定规：反向断言最容易自杀）。
         * 改为一律**结构断言**：直接看 `countHeader` 这个枚举值，
         * 它是 `value|absent|empty` 三态之一，比"正文里有没有某句话"稳得多。
         */
        if (headerVal === '0') {
          expect(raw.countHeader, label).toBe('value');
          expect(raw.totalResults, label).toBe(0);      // '0' 必须变成 0
        } else if (headerVal === undefined) {
          expect(raw.countHeader, label).toBe('absent');
          expect(raw.totalResults, label).toBeNull();
        } else {
          // '' 与全空白
          expect(raw.countHeader, label).toBe('empty');
          expect(raw.totalResults, label).toBeNull();
        }
      }
    }
  });
});

describe('错误分流：400 两种形态、404 两种含义', () => {
  /**
   * **端点声明与 URL 必须一致**（负责人 2026-11-01：让事实约束声明）。
   *
   * `endpoint` 是可乱传的字符串；URL 是事实。不自检的话，
   * 有人传 `'entry-by-id'` 却给了 `/search` 的 URL，就会把"检索出错"说成
   * "这个 accession 不存在"——**判据换了位置，门槛却没拦住**。
   */
  describe('端点自检：声明必须与 URL 事实一致', () => {
    const BASE = 'https://rest.uniprot.org';
    const entry = (acc: string) => `${BASE}/uniprotkb/${acc}?format=json`;
    const search = (q: string) => `${BASE}/uniprotkb/search?query=${q}&format=json`;

    it.each([
      [entry('P46290'), 'entry-by-id'],
      [entry('A0A0P0UX28'), 'entry-by-id'],
      [search('gene:FT'), 'search'],
    ] as const)('合法组合不抛：%s / %s', (url, ep) => {
      expect(() => assertEndpointMatchesUrl(url, ep)).not.toThrow();
    });

    it('**声明 entry-by-id 却给 search 的 URL → 抛内部错误（这正是要防的误用）**', () => {
      expect(() => assertEndpointMatchesUrl(search('gene:FT'), 'entry-by-id'))
        .toThrow(/entry-by-id.*检索入口/);
    });

    it('声明 search 却给单条 URL → 抛内部错误', () => {
      expect(() => assertEndpointMatchesUrl(entry('P46290'), 'search'))
        .toThrow(/search.*不含/);
    });

    it('声明 entry-by-id 但路径不是单条形态（如 /uniprotkb/）→ 抛内部错误', () => {
      expect(() => assertEndpointMatchesUrl(`${BASE}/uniprotkb/?format=json`, 'entry-by-id'))
        .toThrow(/不是 \/uniprotkb\/<accession> 形态/);
    });

    it('非法 URL → 抛内部错误而不是让 URL 解析异常冒出去', () => {
      expect(() => assertEndpointMatchesUrl('not-a-url', 'search')).toThrow(/非法 URL/);
    });

    it('两个工具的**真实 URL** 各自与声明一致（自检未被绕过）', async () => {
      const okHttp = ok(payload('search-pos.json'), { 'x-total-results': '2', 'x-uniprot-release': '2026_03' });
      await searchProteins.run({ organism_id: 3702, gene: 'FT' }, okHttp.ctx);
      expect(okHttp.urls[0]).toContain('/uniprotkb/search');
      expect(() => assertEndpointMatchesUrl(okHttp.urls[0]!, 'search')).not.toThrow();

      const entryHttp = ok(payload('entry-pos.json'));
      await getEntry.run({ accession: 'P46290' }, entryHttp.ctx);
      expect(() => assertEndpointMatchesUrl(entryHttp.urls[0]!, 'entry-by-id')).not.toThrow();
    });
  });

  it('检索语法错 400 → 说是 query 语法问题，给可执行动作', async () => {
    const body = JSON.stringify(payload('search-400.json'));
    const http = realChain(400, body);
    const err = await searchProteins.run({ organism_id: 3702, gene: 'FT' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const msg = (err as Error).message;
    expect(msg).toContain('语法不合法');
    expect(msg).toContain('organism_id');
    // 不透传上游原文
    expect(msg).not.toContain('query parameter has an invalid syntax');
  });

  it('accession 格式错 400 → 说格式问题，并提示别拿基因名当 accession', async () => {
    // 关键：这里必须用**能通过本地正则**的输入，才能测到上游 400 分流
    // （'AT1G65480' 会被本地正则先拦下，零请求——那是另一条断言，见下个用例）
    const body = JSON.stringify({
      url: 'http://rest.uniprot.org/uniprotkb/Q9SXZ2',
      messages: ["The 'accession' value has invalid format. It should be a valid UniProtKB accession"],
    });
    const http = realChain(400, body);
    /**
     * 用 `Q9SXZ2`（**能过严格正则的合法 accession**）来触发上游 400——
     * 这样测的是"上游说格式非法时我们怎么解释"，而不是本地正则。
     * 另一种更常见的情形（用户把基因名当 accession）已在本地被拦，零请求，见上一组用例。
     */
    const err = await getEntry.run({ accession: 'Q9SXZ2' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const msg = (err as Error).message;
    expect(msg).toContain('格式不合法');
    expect(msg).toContain('gene 参数');
    expect(msg).not.toContain("The 'accession' value has invalid format");
  });

  it('**单条 404（JSON Resource not found）→ 是「该 accession 不存在」，不是「源坏了」**', async () => {
    const body = JSON.stringify(payload('entry-404.json'));
    const http = realChain(404, body);
    const err = await getEntry.run({ accession: 'A0A0A0A0A0' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const msg = (err as Error).message;
    expect(msg).toContain('这个 accession 没有对应条目');
    expect(msg).toContain('不等于');
    expect(msg).toContain('源不可用');
    // 必须给出「基因名不是 accession」这条可执行提示
    expect(msg).toContain('gene 参数');
  });

  /**
   * 【R11 P1】端点类型是"查无"判据的第一层。
   *
   * 检索端点 `/uniprotkb/search` 返回 404/400，意思是**上游不认这次请求**，
   * 不是"这个物种没有这个蛋白"。把它说成查无，用户会以为数据不存在，
   * 进而换源、换参数、得出错误结论。
   */
  it('【R11 P1】检索端点 404 → 上游不认请求，绝不说成「查无」', async () => {
    // 即使正文长得像单条查无（含 Resource not found），检索端点也不许下"查无"结论
    const body = JSON.stringify({ url: 'http://x/search', messages: ['Resource not found'] });
    const http = realChain(404, body);
    const err = await searchProteins.run({ organism_id: 3702, gene: 'FT' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const msg = (err as Error).message;
    expect(msg).toContain('检索入口');
    expect(msg).toContain('不是"没有匹配的记录"');
    // **不许**出现"这条不存在"式的结论
    expect(msg).not.toContain('这个 accession 没有对应条目');
  });

  it('【R11 P1】检索端点 400 → 按上游错误报，绝不当查无', async () => {
    const body = JSON.stringify(payload('search-400.json'));
    const http = realChain(400, body);
    const err = await searchProteins.run({ organism_id: 3702, gene: 'FT' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const msg = (err as Error).message;
    // 400 走的是"语法不合法"分支——比 404 更具体，但关键是不许说成"没有匹配"
    expect(msg).toContain('语法不合法');
    expect(msg).not.toContain('没有匹配');
    expect(msg).not.toContain('命中 0 条');
    // 必须给可执行动作
    expect(msg).toContain('organism_id');
  });

  /**
   * 【R11 P1】判据字段：只看错误消息字段，不拿整份 body 做 includes。
   * 否则 `url` 或 `query` 回显里恰好含 "resource not found" 也会被误判成查无。
   *
   * ⚠️ 这条用例的构造很关键：`url` 里必须是真的**空格分隔** `resource not found`，
   * 才能匹配 `\s+` 正则。我第一版写成 `resource-not-found`（连字符），
   * 变异验证时全绿——**用例根本没覆盖到判据**，白写。
   */
  it('【R11 P1】404 但在 url 回显里有 "resource not found"（错误字段没说）→ 不判查无', async () => {
    const body = JSON.stringify({
      url: 'http://x/uniprotkb?q=resource not found',
      messages: ['Invalid parameter value'],
    });
    // 先自证：整份 body 确实含该短语，否则这条用例又落空
    expect(/resource\s+not\s+found/i.test(body), '用例构造前提：body 含该短语').toBe(true);
    const http = realChain(404, body);
    const err = await getEntry.run({ accession: 'P46290' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const msg = (err as Error).message;
    expect(msg).toContain('错误消息字段里**没有**');
    expect(msg).not.toContain('这个 accession 没有对应条目');
  });

  /**
   * 【R11 P2】计数头说 5 条、本次返回 0 条 → 是**上游自相矛盾**，不是"命中 0 条"。
   * 原实现会把它压成"命中 0 条"——用一个确定答案盖住一次上游异常。
   */
  it('【R11 P2】x-total-results=5 但 results 为空 → 抛错，不许输出「命中 0 条」', async () => {
    const http = createFetcher({ retries: 0 }, async () => new Response(
      JSON.stringify({ results: [] }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-total-results': '5' } },
    )) as Fetcher;
    const err = await searchProteins.run({ organism_id: 3702, gene: 'FT' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamShapeError);
    const msg = (err as Error).message;
    // 两端都显示，并说明不是"没有"
    expect(msg).toContain('x-total-results=5');
    expect(msg).toContain('不能当成"命中 0 条"');
    expect(msg).toContain('不是"这个基因没有条目"');
  });

  it('404 但正文是 HTML（nginx）→ 绝不判为查无', async () => {
    // 用**真实原件** boguspath-404-html.json（404 / text/html / 153 B / nginx）
    const body = payload('boguspath-404-html.json') as unknown as string;
    const http = realChain(404, typeof body === 'string' ? body : '<html>404</html>', 'text/html');
    const err = await getEntry.run({ accession: 'P46290' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const msg = (err as Error).message;
    // 修订后措辞：不是"路径不存在"这么肯定，而是"不能判定为条目不存在"
    expect(msg).toContain('不能判定为"该条目不存在"');
    expect(msg).not.toContain('这个 accession 没有对应条目');
  });

  it('【审查第②条】JSON 404 但正文不是 Resource not found → 不许说成查无', async () => {
    // 这是审查抓到的真缺口：原实现"只要有 { 就当查无"
    const body = JSON.stringify({ url: 'http://x/y', messages: ['Invalid parameter value'] });
    const http = realChain(404, body);
    const err = await getEntry.run({ accession: 'P46290' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const msg = (err as Error).message;
    expect(msg).toContain('不能判定为"该条目不存在"');
    expect(msg).toContain('路径/参数契约变了');
    expect(msg).not.toContain('这个 accession 没有对应条目');
  });

  it('【第④条·原体】400 有两种以上入参错误，各自原件都在', async () => {
    // accession 格式错（157 B）
    const accFmt = JSON.stringify(payload('entry-400-accformat.json'));
    const e1 = await getEntry.run({ accession: 'P46290' }, { http: realChain(400, accFmt) })
      .then(() => null, (e: unknown) => e);
    expect(e1).toBeInstanceOf(UpstreamError);
    expect((e1 as Error).message).toContain('格式不合法');

    // fields 参数非法（108 B）
    const badField = JSON.stringify(payload('search-400-badfield.json'));
    const e2 = await searchProteins.run({ organism_id: 3702, gene: 'FT' }, { http: realChain(400, badField) })
      .then(() => null, (e: unknown) => e);
    expect(e2).toBeInstanceOf(UpstreamError);
    // 不认识的上游码不许直接透出原文
    expect((e2 as Error).message).not.toContain('Invalid fields parameter value');
  });

  it('403（根路径 nginx）→ 是「拒绝访问」，不是查无', async () => {
    const http = realChain(403, '<html>403</html>', 'text/html');
    const err = await searchProteins.run({ organism_id: 3702, gene: 'FT' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toContain('拒绝访问');
  });

  /**
   * 【R11 残余·P2 负控一】`fields` 参数被上游拒绝，**不许**说成"你的 query 语法错了"。
   *
   * 缺口原状：400 只区分 accession 与"其余"，其余一律断言 query 语法错。
   * `fields` 是**本仓自己固定传的**，报成用户检索条件错会让用户去改 AND/OR，
   * 而真正的修法在维护者这边——把内部问题误导成用户问题。
   * 用真实原体 `search-400-badfield.json`（108 B），走真实公共链。
   */
  it('【R11 残余】400 fields 参数错 → 说明是本仓字段清单问题，不许说成 query 语法错', async () => {
    const body = JSON.stringify(payload('search-400-badfield.json'));
    const err = await searchProteins.run({ organism_id: 3702, gene: 'FT' }, { http: realChain(400, body) })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const msg = (err as Error).message;
    expect(msg).toContain('fields');
    expect(msg).toContain('不是你查询条件写错了');
    expect(msg).not.toContain('query **语法不合法**');
    expect(msg).not.toContain('多余的 AND/OR');
    expect(msg).not.toContain('Invalid fields parameter value');
  });

  /** 【R11 残余】真正的 query 语法错**仍要**报 query 语法——分档不能把两类合并。真实原体 103 B。 */
  it('【R11 残余】400 query 语法错 → 仍报 query 语法，并给可执行建议', async () => {
    const body = JSON.stringify(payload('search-400.json'));
    const err = await searchProteins.run({ organism_id: 3702, gene: 'FT' }, { http: realChain(400, body) })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const msg = (err as Error).message;
    expect(msg).toContain('query **语法不合法**');
    expect(msg).toContain('AND/OR');
  });

  /** 【R11 残余】未识别的 400 **不许兜底成 query 语法错**：不认识就说不认识，让维护者补原体。 */
  it('【R11 残余】400 消息不属于已实测三类 → 判未知契约问题，不兜底成 query 语法错', async () => {
    const unknown400 = JSON.stringify({
      url: 'http://rest.uniprot.org/uniprotkb/search',
      messages: ['some brand new upstream complaint'],
    });
    const err = await searchProteins.run({ organism_id: 3702, gene: 'FT' }, { http: realChain(400, unknown400) })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const msg = (err as Error).message;
    expect(msg).toContain('不属于本仓已实测的三类');
    expect(msg).not.toContain('query **语法不合法**');
  });

  /**
   * 【R11 残余·P2 负控二】**非空结果**带非法计数头 → 必须抛结构漂移，
   * 不许走到渲染后把"上游给了坏值"说成"上游没给总数"。
   *
   * 缺口原状：`invalid` 检查只嵌在 `results.length === 0` 分支，
   * 于是 2 条结果 + `x-total-results: bogus` 一路渲染成「上游未给总数（x-total-results 缺失）」。
   */
  it('【R11 残余】非空结果 + 非法 x-total-results → 抛结构漂移，不说成「缺失」', async () => {
    const http = createFetcher({ retries: 0 }, async () => new Response(
      JSON.stringify(payload('search-pos.json')),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-total-results': 'bogus',
          'x-uniprot-release': '2026_03',
        },
      },
    )) as Fetcher;
    const err = await searchProteins.run({ organism_id: 3702, gene: 'FT' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamShapeError);
    const msg = (err as Error).message;
    expect(msg).toContain('不是非负整数');
    expect(msg).toContain('不是"上游没给计数"');
    expect(msg).not.toContain('缺失）');
  });

  /** 【R11 残余】非空结果 + 空值头 → `empty` 与 `absent` 分档，措辞必须点明"头存在但值为空"。 */
  it('【R11 残余】非空结果 + 空值 x-total-results 头 → 不说成「缺失」', async () => {
    const http = createFetcher({ retries: 0 }, async () => new Response(
      JSON.stringify(payload('search-pos.json')),
      { status: 200, headers: { 'content-type': 'application/json', 'x-total-results': '   ' } },
    )) as Fetcher;
    const out = await searchProteins.run({ organism_id: 3702, gene: 'FT' }, { http })
      .then((r) => r, (e: unknown) => e);
    if (out instanceof Error) {
      expect(out.message).not.toContain('缺失）');
    } else {
      expect(out.text).toContain('头存在但值为空');
      expect(out.text).not.toContain('x-total-results 缺失');
    }
  });
});

describe('入参与边界：本地拒绝、零请求', () => {
  it.each([[999999], [0], [3701], ['homo_sapiens'], ['']])(
    'organism_id=%s 不在白名单 → 拒绝', async (v) => {
      const { ctx, urls } = ok(payload('search-pos.json'));
      const err = await searchProteins.run({ organism_id: v, gene: 'FT' }, ctx)
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidArgumentError);
      expect(urls).toHaveLength(0);
      expect((err as Error).message).toContain('未实测条目数');
    });

  it('白名单只含四个已实测物种', () => {
    expect(manifest.species).toHaveLength(4);
    for (const s of ['Arabidopsis thaliana', 'Triticum aestivum', 'Oryza sativa', 'Zea mays']) {
      expect(manifest.species).toContain(s);
    }
  });

  it('gene 与 accession 只能给一个', async () => {
    const { ctx, urls } = ok(payload('search-pos.json'));
    const err = await searchProteins.run({ organism_id: 3702, gene: 'FT', accession: 'Q9SXZ2' }, ctx)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidArgumentError);
    expect(urls).toHaveLength(0);
  });

  it('两个都不给 → 拒绝（只给物种会返回全库）', async () => {
    const { ctx, urls } = ok(payload('search-pos.json'));
    await expect(searchProteins.run({ organism_id: 3702 }, ctx)).rejects.toThrow(/至少给一个/);
    expect(urls).toHaveLength(0);
  });

  it('**请求必须带 fields**（不写它 2 条就 44 KB）', async () => {
    const { ctx, urls } = ok(payload('search-pos.json'));
    await searchProteins.run({ organism_id: 3702, gene: 'FT' }, ctx);
    // URLSearchParams 会把逗号编码成 %2C，所以解码后再断言语义
    const decoded = decodeURIComponent(urls[0]!);
    expect(decoded).toContain('fields=accession,gene_names,protein_name,length,organism_name,reviewed');
  });

  it('size 越界 → 本地拒绝，零请求', async () => {
    for (const bad of [0, 101, 1.5, '20']) {
      const { ctx, urls } = ok(payload('search-pos.json'));
      await expect(searchProteins.run({ organism_id: 3702, gene: 'FT', size: bad }, ctx),
        `size=${String(bad)}`).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(urls).toHaveLength(0);
    }
  });

  it('未知参数 → 拒绝', async () => {
    const { ctx, urls } = ok(payload('search-pos.json'));
    await expect(searchProteins.run({ organism_id: 3702, gene: 'FT', cursor: 'x' }, ctx))
      .rejects.toThrow(/未知参数/);
    expect(urls).toHaveLength(0);
  });

  it('accession 形状非法 → 本地拒绝（**宽松正则挡不住基因名，这条就是证据**）', async () => {
    // `AT1G65480` 是 9 位字母数字——`^[A-Za-z0-9]{6,10}$` 会放行它。
    // 严格 accession 正则把它挡在本地，零请求。
    for (const bad of ['AT1G65480', 'FT', 'Q9SXZ', 'Q9SXZ2EXTRA', 'TraesCS5A02G391700', 'Os01g0100100']) {
      const { ctx, urls } = ok(payload('entry-pos.json'));
      await expect(getEntry.run({ accession: bad }, ctx), bad).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(urls).toHaveLength(0);
    }
  });

  it('合法 accession 一律放行（严格正则不是"什么都挡"）', async () => {
    // entry-pos.json 的原体是 P46290，所以只有 P46290 能通过身份绑定
    const { ctx, urls } = ok(payload('entry-pos.json'));
    await getEntry.run({ accession: 'P46290' }, ctx);
    expect(urls).toHaveLength(1);
    // 其它合法形态的 accession 应被放行到"发请求"这一步（身份不符是上游响应的问题，不是本地拦截）
    for (const good of ['Q9SXZ2', 'A0A0P0UX28', 'A0A0A0A0A0']) {
      const { ctx: c2, urls: u2 } = ok({ primaryAccession: good, sequence: { length: 1 } });
      await getEntry.run({ accession: good }, c2);
      expect(u2, good).toHaveLength(1);
    }
  });

  it('【审查第③条】单条响应身份绑定：返回别的 accession 必须拒答', async () => {
    // 模拟接口返回合法数据、但属于另一个条目——用户看不出异常，这正是 STRING 那类缺陷
    const wrong = {
      entryType: 'UniProtKB reviewed (Swiss-Prot)',
      primaryAccession: 'Q99999',
      organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
      sequence: { length: 100 },
    };
    const err = await getEntry.run({ accession: 'P46290' }, ok(wrong).ctx)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamShapeError);
    const msg = (err as Error).message;
    expect(msg).toContain('身份不符');
    expect(msg).toContain('Q99999');
    expect(msg).toContain('P46290');
  });

  it('缺 primaryAccession → 无法确认身份，抛错而不是用请求值顶上', async () => {
    const noAcc = { entryType: 'UniProtKB reviewed (Swiss-Prot)', sequence: { length: 100 } };
    await expect(getEntry.run({ accession: 'P46290' }, ok(noAcc).ctx))
      .rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('reviewed_only=true 会真的写进 query', async () => {
    const { ctx, urls } = ok(payload('search-pos.json'));
    await searchProteins.run({ organism_id: 3702, gene: 'FT', reviewed_only: true }, ctx);
    expect(urls[0]).toContain('reviewed%3Atrue');
  });
});

describe('输出预算与结构', () => {
  it('正文不超过 1408 字节，且不交统一截断', async () => {
    const out = await searchProteins.run({ organism_id: 3702, gene: 'FT' }, ok(payload('search-pos.json')).ctx);
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
    expect(out.text).not.toContain('正文已按');
  });

  it('结果很多时会截断展示条数并说明还有多少', async () => {
    const many = {
      results: Array.from({ length: 40 }, (_, i) => ({
        entryType: 'UniProtKB unreviewed (TrEMBL)', primaryAccession: `A0A0A0A0A${i % 10}`,
        organism: { scientificName: 'Arabidopsis thaliana', taxonId: 3702 },
        proteinDescription: { recommendedName: { fullName: { value: `Protein ${i} with a fairly long descriptive name` } } },
        genes: [{ geneName: { value: `GENE${i}` } }], sequence: { length: 100 + i },
      })),
    };
    const out = await searchProteins.run({ organism_id: 3702, gene: 'FT', size: 100 },
      ok(many, { 'x-total-results': '40', 'x-uniprot-release': '2026_03' }).ctx);
    const raw = out.raw as { shown: number; omitted: number; returned: number };
    expect(raw.returned).toBe(40);
    expect(raw.shown + raw.omitted).toBe(40);
    if (raw.omitted > 0) expect(out.text).toContain('另有');
  });

  it('缺 length 时显示「未提供」，不许变成 0', async () => {
    const noLen = {
      results: [{
        entryType: 'UniProtKB reviewed (Swiss-Prot)', primaryAccession: 'Q9SXZ2',
        organism: { scientificName: 'Arabidopsis thaliana', taxonId: 3702 },
        proteinDescription: { recommendedName: { fullName: { value: 'FT' } } },
        genes: [{ geneName: { value: 'FT' } }], sequence: { length: null },
      }],
    };
    const out = await searchProteins.run({ organism_id: 3702, gene: 'FT' },
      ok(noLen, { 'x-total-results': '1', 'x-uniprot-release': '2026_03' }).ctx);
    expect(out.text).toContain('未提供');
    expect(out.text).toContain('这不等于长度为 0');
    expect((out.raw as { records: Array<{ lengthAa?: number }> }).records[0]!.lengthAa).toBeUndefined();
  });

  it('length 是坏值（字符串 abc）→ 抛结构漂移，不静默当 0', async () => {
    const bad = {
      results: [{
        entryType: 'UniProtKB reviewed (Swiss-Prot)', primaryAccession: 'Q9SXZ2',
        organism: { scientificName: 'Arabidopsis thaliana', taxonId: 3702 },
        sequence: { length: 'abc' },
      }],
    };
    await expect(searchProteins.run({ organism_id: 3702, gene: 'FT' },
      ok(bad, { 'x-total-results': '1' }).ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('results 不是数组 → 结构漂移', async () => {
    await expect(searchProteins.run({ organism_id: 3702, gene: 'FT' }, ok({ results: 'x' }).ctx))
      .rejects.toBeInstanceOf(UpstreamShapeError);
  });
});

describe('注册与清单', () => {
  it('独立注册表通过，两个工具都带 uniprot_ 前缀', () => {
    const registry = new ToolRegistry();
    registry.register({ manifest, tools });
    const names = registry.listTools().map((t) => t.name);
    expect(names).toEqual(['uniprot_search_proteins', 'uniprot_get_entry']);
    expect(names.every((n) => n.startsWith('uniprot_'))).toBe(true);
    expect(manifest.tier).toBe('T1');
  });

  it('manifest 写明 entryType 必标、长度单位、idmapping 阻塞', () => {
    const text = manifest.caveats.join('\n');
    expect(text).toContain('entryType');
    expect(text).toContain('氨基酸数');
    expect(text).toContain('idmapping');
    expect(text).toContain('只接受 POST');
  });

  /**
   * `secondaryAccession` 的诚实降级**必须在 caveats 里写明**。
   *
   * 起因：我曾口头声称"manifest 里写了这条"，但实际没写——
   * 于是用户拿 secondary accession 查会被拒答，却没有任何地方解释为什么。
   * 这条断言防它再次"只存在于对话里"。
   */
  it('manifest 必须写明 secondaryAccession 本批不支持及替代做法', () => {
    const text = manifest.caveats.join('\n');
    expect(text).toContain('secondaryAccession');
    expect(text).toContain('会被拒答');
    expect(text).toContain('uniprot_search_proteins');   // 必须给替代动作
    // 不许写成"不支持别名"这种含糊说法而不解释前提
    expect(text).toContain('primaryAccession');
  });

  it('能力边界声明：不返回序列本体、不做比对、不接 idmapping', () => {
    // 断言的是「明确声明不做什么」，而不是「描述里不出现某个词」——
    // 后者会把"不返回序列本体"这种**正确的否定声明**也判成违规。
    const all = tools.map((t) => t.description).join('\n');
    expect(all).toContain('不返回序列本体');
    expect(all).toContain('不做序列比对');
    expect(all).toContain('idmapping');
    expect(all).toContain('不分页');
  });
});

describe('【证据自洽】fixture 原体与哈希（离线，与 STRING 同口径）', () => {
  const files = readdirSync(new URL('../src/sources/uniprot/fixtures', import.meta.url))
    .filter((f) => f.endsWith('.json'));

  it('至少 5 份', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)('%s：原体哈希/字节数/派生一致', (f) => {
    const doc = JSON.parse(readFileSync(
      new URL(`../src/sources/uniprot/fixtures/${f}`, import.meta.url), 'utf8'));
    const cap = doc.capture;
    expect(cap.request).toBeTruthy();
    expect(typeof cap.status).toBe('number');
    expect(cap.captureTimeStatus).toBe('确证');
    expect(cap.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(cap.simulated).toBe(false);

    const bytes = Buffer.from(doc.rawBody, 'utf8');
    expect(bytes.length).toBe(cap.sourceBytes);
    expect(createHash('sha256').update(bytes).digest('hex').toUpperCase()).toBe(cap.sourceSha256);
    // 语义级：JSON.parse(原体) 深等于 payload；非 JSON 逐字相等
    if (/^\s*[[{]/.test(doc.rawBody)) {
      expect(JSON.parse(doc.rawBody)).toEqual(doc.payload);
    } else {
      expect(doc.payload).toBe(doc.rawBody);
    }
  });

  it('双哈希字段存在且口径写明「不证明历史采集」', () => {
    for (const f of files) {
      const cap = JSON.parse(readFileSync(
        new URL(`../src/sources/uniprot/fixtures/${f}`, import.meta.url), 'utf8')).capture;
      expect(cap.canonicalSha256).toMatch(/^[0-9A-F]{64}$/);
      expect(cap.canonicalSha256OfRawBody).toMatch(/^[0-9A-F]{64}$/);
      // 这条措辞是审查者要求的：不许把「哈希一致」写成「证明当初抓过」
      expect(cap.rawBodyNote).toContain('不得据此推断更早的采集时刻');
      expect(cap.canonicalNote).toContain('不证明历史采集动作');
    }
  });
});

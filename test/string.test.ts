import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../src/core/errors.js';
import { createFetcher } from '../src/core/http.js';
import { utf8Bytes } from '../src/core/format.js';
import { ToolRegistry } from '../src/core/registry.js';
import type { Fetcher } from '../src/core/types.js';
import { manifest } from '../src/sources/string/manifest.js';
import {
  SPECIES, buildEmptyCondition, checkTaxonEcho, classifyEmptyOrError, cleanErrorMessage,
  interactionPartners, resolveIds, requireTaxon, tools,
} from '../src/sources/string/tools.js';

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../src/sources/string/fixtures/${name}`, import.meta.url), 'utf8'));
const payload = (name: string) => read(name).payload;

function ok(data: unknown, contentType = 'text/json; charset=utf-8') {
  const urls: string[] = [];
  const http = (async (url: string) => {
    urls.push(url);
    return { data, url, status: 200, durationMs: 900, attempts: 1, contentType };
  }) as Fetcher;
  return { ctx: { http }, urls };
}

/** 真实公共链 + Response 桩：验证 text/json 与错误形态。 */
function realChain(status: number, body: string, contentType = 'text/json; charset=utf-8'): Fetcher {
  return createFetcher({ retries: 0 }, async () => new Response(body, {
    status, headers: { 'content-type': contentType },
  })) as Fetcher;
}

describe('STRING 真实 fixture 回放', () => {
  it('resolve 正例：743 B，解析出 3702.Q9SXZ2', async () => {
    const f = read('resolve-pos.json');
    expect(f.capture).toMatchObject({ status: 200, sourceBytes: 743, simulated: false });
    const out = await resolveIds.run({ species: 3702, identifier: 'AT1G65480' }, ok(f.payload).ctx);
    expect(out.text).toContain('3702.Q9SXZ2');
    expect(out.text).toContain('FT');
    expect((out.raw as any).resolved).toBe(1);
    // 必须提示下一步用法
    expect(out.text).toContain('string_interaction_partners');
  });

  it('resolve 空：200 + [] 必须说明两种可能，不说"基因不存在"', async () => {
    const f = read('resolve-empty.json');
    expect(f.capture.sourceBytes).toBe(2);
    // 该 fixture 是 species=4565（不在白名单），但空结果文案本身与物种无关，
    // 这里用白名单内物种回放同一空 payload 验证文案。
    const out = await resolveIds.run({ species: 3702, identifier: 'NO_SUCH_SYMBOL_ZZZ' }, ok(f.payload).ctx);
    expect(out.text).toContain('空数组有两种可能');
    expect(out.text).toContain('不等于“这个基因不存在”');
    expect((out.raw as any).resolved).toBe(0);
  });

  it('partners 正例：2,486 B / 10 条，只给 score 与主要通道', async () => {
    const f = read('partners-pos.json');
    expect(f.capture.sourceBytes).toBe(2486);
    const out = await interactionPartners.run(
      { species: 3702, string_id: '3702.Q9SXZ2', limit: 10 }, ok(f.payload).ctx);
    const raw = out.raw as any;
    expect(raw.total).toBe(10);
    expect(raw.shown + raw.omitted).toBe(10);
    expect(out.text).toContain('score');
    expect(out.text).toContain('综合置信度');
    // 8 个通道不全量透出
    expect(out.text).not.toContain('nscore');
    expect(out.text).not.toContain('fscore');
  });

  it('fixture 元数据：抓取时刻按未知档，mtime 单列', () => {
    for (const file of ['resolve-pos.json', 'resolve-empty.json', 'partners-pos.json',
      'partners-notfound.json', 'partners-unknown-organism.json']) {
      const c = read(file).capture;
      expect(c.captureTimeStatus, file).toBe('未知');
      expect(c.capturedAt, file).toBeUndefined();
      expect(c.fileWriteTimeMtime, file).toBeTruthy();
      expect(c.contentType, file).toContain('text/json');
      expect(c.sourceSha256, file).toMatch(/^[0-9A-F]{64}$/);
    }
  });
});

describe('【硬要求 1】未解析标识符不许静默返回空', () => {
  it.each(['AT1G65480', 'Q9SXZ2', 'TraesCS5A02G391700', '', '3702.', '.Q9SXZ2'])(
    'string_id=%s → 本地按形状拒绝，零请求', async (stringId) => {
      const { ctx, urls } = ok(payload('partners-pos.json'));
      /** 先断言"零请求"，再断言"文案形状"：不是做拦截，是拦后要能给出下一步。 */
      const err = await interactionPartners.run({ species: 3702, string_id: stringId }, ctx)
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidArgumentError);
      expect(urls).toHaveLength(0);
      expect((err as Error).message).toContain('3702.Q9SXZ2');
    });
  it('拒绝文案必须点名 string_resolve_ids，且明确不返回空冒充无互作', async () => {
    try {
      await interactionPartners.run({ species: 3702, string_id: 'AT1G65480' }, ok([]).ctx);
      throw new Error('should throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('string_resolve_ids');
      expect(msg).toContain('不会返回空列表');
    }
  });
  it('【STR-A】形状合法但 ID 实际无效 → 上游 404 明确否定，不当成空', async () => {
    // 实测 partners-badstringid.json：404 / 591 B / Error:"not found"
    const body = JSON.stringify(payload('partners-badstringid.json'));
    const http = realChain(404, body);
    const err = await interactionPartners.run({ species: 3702, string_id: '3702.NOSUCHIDZZZ' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    const msg = (err as Error).message;
    expect(msg).toContain('STRING 不认识');
    expect(msg).toContain('核对编号');
    // 不许把用户指回 resolve_ids 当解释（partners 自己会解析，指过去是空转）
    expect(msg).not.toContain('请先用 string_resolve_ids');
    expect(msg).not.toContain('请先调用 string_resolve_ids');
    expect(msg).toContain('这不是"该基因没有互作"');
  });
});

/** 端点必须显式参与分类：同一个 404 在 resolve 端点不是"查无"（STR-B）。 */
describe('【STR-B】空错证据不跨端点借用', () => {
  it('resolve 端点 404 不认作 error-not-found', () => {
    const body = [{ Error: 'not found' }];
    expect(classifyEmptyOrError(404, body, JSON.stringify(body), 'interaction_partners')).toBe('error-not-found');
    expect(classifyEmptyOrError(404, body, JSON.stringify(body), 'get_string_ids')).toBe('error-unknown');
  });
  it('interactions 端点的 "nothing found" 不得被当成查无（本仓不接该端点）', () => {
    const body = [{ Error: 'nothing found' }];
    for (const ep of ['get_string_ids', 'interaction_partners'] as const) {
      expect(classifyEmptyOrError(404, body, JSON.stringify(body), ep)).toBe('error-unknown');
    }
  });
  it('两个端点各自的 200+[] 得到不同 kind（可区分"未解析"与"无伙伴"）', () => {
    expect(classifyEmptyOrError(200, [], '[]', 'get_string_ids')).toBe('empty-not-resolved');
    expect(classifyEmptyOrError(200, [], '[]', 'interaction_partners')).toBe('empty-no-partner');
    expect(classifyEmptyOrError(200, [], '[]', 'get_string_ids'))
      .not.toBe(classifyEmptyOrError(200, [], '[]', 'interaction_partners'));
  });
  it('resolve 端点自己也有 400 unknown organism 原件（不是借用 partners 的）', async () => {
    const cap = read('resolve-unknown-organism.json').capture as { status: number; sourceBytes: number };
    expect(cap.status).toBe(400);
    const body = JSON.stringify(payload('resolve-unknown-organism.json'));
    expect(classifyEmptyOrError(400, payload('resolve-unknown-organism.json'), body, 'get_string_ids'))
      .toBe('error-unknown-organism');
    const http = realChain(400, body);
    const err = await resolveIds.run({ species: 3702, identifier: 'AT1G65480' }, { http })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toContain('上游不认识该物种');
  });
  it('camelCase 转发桩真实原件：404 / 109 B / 不带 content-type，正文含 forwarded', () => {
    const doc = read('partners-camel-forward.json') as { capture: { status: number; sourceBytes: number; contentType: string }; payload: string };
    expect(doc.capture.status).toBe(404);
    expect(doc.capture.sourceBytes).toBe(109);
    expect(doc.capture.contentType).toBe('');
    expect(doc.payload).toContain('you are being forwarded');
    expect(classifyEmptyOrError(404, undefined, doc.payload, 'interaction_partners')).toBe('error-unknown');
  });
});

describe('【硬要求 2】三种"没有"分开报，不按状态码统一判空', () => {
  it('200 + [] → 合法空（两种可能都说）', () => {
    expect(classifyEmptyOrError(200, [], '[]', 'interaction_partners')).toBe('empty-no-partner');
    expect(classifyEmptyOrError(200, [], '[]', 'get_string_ids')).toBe('empty-not-resolved');
  });
  it('404 + Error:not found → error-not-found（不是空）', async () => {
    const body = JSON.stringify(payload('partners-notfound.json'));
    expect(classifyEmptyOrError(404, payload('partners-notfound.json'), body, 'interaction_partners')).toBe('error-not-found');
    const http = realChain(404, body);
    try {
      await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2' }, { http });
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UpstreamError);
      expect((e as Error).message).toContain('STRING 不认识');
      // 不回显上游原文（HTML 洗或不透）
      expect((e as Error).message).not.toContain('<p>');
      expect((e as Error).message).not.toContain('&nbsp;');
    }
  });
  it('400 + unknown organism → 明确"物种不存在"而非"没有互作数据"', async () => {
    const body = JSON.stringify(payload('partners-unknown-organism.json'));
    expect(classifyEmptyOrError(400, payload('partners-unknown-organism.json'), body, 'interaction_partners')).toBe('error-unknown-organism');
    const http = realChain(400, body);
    try {
      await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2' }, { http });
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UpstreamError);
      expect((e as Error).message).toContain('上游不认识该物种');
      // 不得把"物种不存在"说成"没有互作"：允许出现"这不是…没有互作数据"的否定式，
      // 但不许单独断言成"没有互作"。用否定式正则钉住语义。
      expect((e as Error).message).toContain('这不是');
      expect((e as Error).message).toContain('该物种没有互作数据');
    }
  });
  it('404 HTML 转发桩（camelCase 方法名会得到）→ 不判空，提示下划线', async () => {
    const http = realChain(404, 'you are being forwarded', 'text/html');
    try {
      await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2' }, { http });
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UpstreamError);
      expect((e as Error).message).toContain('下划线');
    }
  });
});

describe('【硬要求 3】species 必填 + 回读核对 + 别名必须透出', () => {
  it('缺 species → 零请求拒绝', async () => {
    const { ctx, urls } = ok([]);
    await expect(interactionPartners.run({ string_id: '3702.Q9SXZ2' }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(resolveIds.run({ identifier: 'AT1G65480' }, ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(urls).toHaveLength(0);
  });
  it.each(['4565', '4577', '999999', 'constructor', ''])('物种 %s 不在白名单 → 拒绝', (species) => {
    expect(() => requireTaxon({ species })).toThrow(InvalidArgumentError);
  });
  it('4565/4577 的拒绝文案必须说"能力未验证"，不说"不覆盖"', () => {
    for (const sp of [4565, 4577]) {
      try { requireTaxon({ species: sp }); throw new Error('should throw'); }
      catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('未验证');
        expect(msg).not.toContain('不覆盖');
      }
    }
  });
  it('回读：等于请求值 → 通过且无别名提示', () => {
    expect(checkTaxonEcho(3702, 3702, 'u')).toEqual({});
  });
  it('回读：4530 → 39947 必须透出"由 X 解析为 Y"', () => {
    const { aliasNote } = checkTaxonEcho(4530, 39947, 'u');
    expect(aliasNote).toBeTruthy();
    expect(aliasNote).toContain('4530');
    expect(aliasNote).toContain('39947');
    expect(aliasNote).toContain('Japonica');
    expect(aliasNote).toContain('不是 4530 字面对应的更大范围');
  });
  it('回读：物种不符 → 拒答，不猜不兜底', () => {
    expect(() => checkTaxonEcho(3702, 39947, 'u')).toThrow(UpstreamShapeError);
    expect(() => checkTaxonEcho(39947, 3702, 'u')).toThrow(UpstreamShapeError);
  });
  it('别名透出要真进正文（用 4530 请求、响应 39947）—— 真实原件，不用改字段的合成件', async () => {
    // 原件 resolve-4530.json：请求 species=4530，上游回显 ncbiTaxonId=39947。
    // 旧版这里是拿 resolve-pos.json 改字段拼出来的（{...f[0], ncbiTaxonId: 39947}），
    // 那属于 simulated 件，不能当"已实测覆盖"，已删除。
    const doc = read('resolve-4530.json') as { capture: { request: string }; payload: unknown[] };
    expect(doc.capture.request).toContain('species=4530');
    const out = await resolveIds.run({ species: 4530, identifier: 'Os01g0100100' }, ok(doc.payload).ctx);
    expect(out.text).toContain('4530');
    expect(out.text).toContain('39947');
    expect(out.text).toContain('Japonica');
    expect(out.text).toContain('上游将 4530 解析为 39947');
  });
  it('string_id 物种前缀与 species 不一致 → 拒绝（避免串物种）', async () => {
    await expect(interactionPartners.run({ species: 3702, string_id: '39947.Q9SXZ2' }, ok([]).ctx))
      .rejects.toBeInstanceOf(InvalidArgumentError);
  });
  it('canonicalTaxon 已移除；物种改为三个独立输入值，不做等价推断', () => {
    expect(Object.keys(SPECIES).map(Number).sort()).toEqual([3702, 39947, 4530]);
    expect(SPECIES[4530].expectedEcho).toBe(39947);   // 记录回显，不是等价
    expect(SPECIES[39947].expectedEcho).toBe(39947);
    expect(SPECIES[3702].expectedEcho).toBe(3702);
  });
  it('【不许反推】请求 39947 却回显 4530 → 拒答（无此实测）', () => {
    expect(() => checkTaxonEcho(39947, 4530, 'u')).toThrow(UpstreamShapeError);
  });
});

/**
 * STR-C：物种回显必须是**明确接受映射表**，不是"不一致就提示后放行"。
 * 这里同时钉住"39947 有直接正例"（此前审查指出缺这份证据）。
 */
describe('【STR-C】物种回显是明确映射表，不是泛化"就近解析"', () => {
  it('39947 直接请求有真实正例原件（不是从 4530 推断的）', async () => {
    const doc = read('resolve-39947.json') as {
      capture: { request: string; status: number }; payload: Array<Record<string, unknown>>;
    };
    expect(doc.capture.request).toContain('species=39947');
    expect(doc.capture.status).toBe(200);
    expect(doc.payload[0]!.ncbiTaxonId).toBe(39947);
    const out = await resolveIds.run({ species: 39947, identifier: 'Os01g0100100' }, ok(doc.payload).ctx);
    expect((out.raw as any).resolved).toBe(1);
    // 请求值 = 回显值，不应产生任何别名提示
    expect(out.text).not.toContain('上游将');
  });
  it('partners 端点 39947 正例：请求 39947、回显 39947', async () => {
    const doc = read('partners-39947.json') as { capture: { request: string }; payload: unknown[] };
    expect(doc.capture.request).toContain('species=39947');
    const out = await interactionPartners.run({ species: 39947, string_id: '39947.A0A0P0UX28' }, ok(doc.payload).ctx);
    expect((out.raw as any).total).toBe(doc.payload.length);
    expect(out.text).not.toContain('上游将');
  });
  it('两侧都有 4530 的真实正例：请求 4530、回显 39947、正文必须透出', async () => {
    const docs = ['resolve-4530.json', 'partners-4530.json'] as const;
    for (const name of docs) {
      const doc = read(name) as { capture: { request: string; simulated: boolean }; payload: unknown };
      expect(doc.capture.request, name).toContain('species=4530');
      expect(doc.capture.simulated, `${name} 必须是真抓件`).toBe(false);
    }
    // 上游对 4530 与 39947 的响应逐字节相同（同一 sha），这是"落到同一粳稻"的证据，
    // 但**不构成**两者等价的认定——映射表里仍保留两条独立输入。
    const a = read('partners-4530.json').capture.sourceSha256;
    const b = read('partners-39947.json').capture.sourceSha256;
    expect(a).toBe(b);
    expect(SPECIES[4530].expectedEcho).toBe(39947);
    expect(SPECIES[39947].expectedEcho).toBe(39947);
  });
  it('接受映射表只含已实测的那一条：4530→39947，其余一律拒答', () => {
    // 允许：等于请求值
    expect(checkTaxonEcho(3702, 3702, 'u').aliasNote).toBeUndefined();
    expect(checkTaxonEcho(39947, 39947, 'u').aliasNote).toBeUndefined();
    // 允许且必须提示：4530 → 39947
    expect(checkTaxonEcho(4530, 39947, 'u').aliasNote).toContain('4530');
    // 不允许：3702↔39947 互串；39947→4530 反推；4530 回显别的物种
    for (const [req, echo] of [[3702, 39947], [39947, 3702], [39947, 4530], [4530, 3702]] as const) {
      expect(() => checkTaxonEcho(req, echo, 'u'), `${req}→${echo}`).toThrow(UpstreamShapeError);
    }
  });
  it('映射表是常量、可枚举，不是"任意不一致先提示后放行"', () => {
    const table = Object.entries(SPECIES).map(([req, v]) => [Number(req), v.expectedEcho] as const);
    // 按 key 升序：4530 / 3702 / 39947（对象键顺序不可依赖，这里显式排序）
    const sorted = [...table].sort((a, b) => a[0] - b[0]);
    expect(sorted).toEqual([[3702, 3702], [4530, 39947], [39947, 39947]]);
    // 除 4530 外没有第二个"回显 ≠ 请求"的入口，这就是"明确映射表"的判据
    expect(sorted.filter(([req, echo]) => req !== echo)).toEqual([[4530, 39947]]);
  });
});

/**
 * 身份核验：返回记录必须绑定回请求的标识符。
 * 这是 REV-STR-01 在回放中抓到的真缺陷——原先两个端点都没读"这是谁的记录"，错基因响应会被照收。
 * 上游实测逐字回显（大小写敏感），所以可以精确断言。
 */
describe('【身份核验】错基因/错标识符的响应必须拒答，不许照收', () => {
  it('partners：stringId_A 与请求的 string_id 不一致 → 抛错，不是静默丢弃也不是取第一条', async () => {
    // 原件 partners-wrongself.json：请求 3702.Q84JK2，响应 stringId_A 全是 3702.Q84JK2。
    // 这里故意用 3702.Q9SXZ2 去"收"这份响应，模拟上游回错对象。
    const doc = read('partners-wrongself.json') as { capture: { simulated: boolean }; payload: unknown[] };
    expect(doc.capture.simulated).toBe(false);
    expect((doc.payload[0] as { stringId_A: string }).stringId_A).toBe('3702.Q84JK2');

    const err = await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2' }, ok(doc.payload).ctx)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamShapeError);
    const msg = (err as Error).message;
    expect(msg).toContain('A 侧与请求的 string_id 不一致');
    expect(msg).toContain('3702.Q84JK2');
    expect(msg).toContain('3702.Q9SXZ2');
    expect(msg).toContain('拒绝把别的基因的互作当成结果');
  });
  it('partners：正常原件逐条自洽（A 侧就是请求值）→ 通过', async () => {
    const doc = read('partners-pos.json') as { capture: { request: string }; payload: unknown[] };
    const out = await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2' }, ok(doc.payload).ctx);
    expect((out.raw as any).total).toBe(10);
  });
  it('resolve：queryItem 与请求的 identifier 不一致 → 抛错', async () => {
    // 原件 resolve-other-gene.json：请求 FT，queryItem="FT"。用 AT1G65480 去收这份响应。
    const doc = read('resolve-other-gene.json') as { capture: { simulated: boolean }; payload: Array<{ queryItem: string }> };
    expect(doc.capture.simulated).toBe(false);
    expect(doc.payload[0]!.queryItem).toBe('FT');

    const err = await resolveIds.run({ species: 3702, identifier: 'AT1G65480' }, ok(doc.payload).ctx)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamShapeError);
    const msg = (err as Error).message;
    expect(msg).toContain('与请求标识符对不上');
    expect(msg).toContain('AT1G65480');
    expect(msg).toContain('「FT」');
  });
  it('resolve：正常原件 queryItem 逐字回显请求值 → 通过（核验不是恒真）', async () => {
    const doc = read('resolve-pos.json') as { payload: Array<{ queryItem: string }> };
    expect(doc.payload[0]!.queryItem).toBe('AT1G65480');
    const out = await resolveIds.run({ species: 3702, identifier: 'AT1G65480' }, ok(doc.payload).ctx);
    expect((out.raw as any).resolved).toBe(1);
  });
  it('resolve：queryItem 缺失也算对不上（不许把缺失当匹配）', async () => {
    const doc = read('resolve-pos.json') as { payload: Array<Record<string, unknown>> };
    const withoutEcho = [{ ...doc.payload[0]!, queryItem: undefined }];
    delete (withoutEcho[0] as Record<string, unknown>).queryItem;
    await expect(resolveIds.run({ species: 3702, identifier: 'AT1G65480' }, ok(withoutEcho).ctx))
      .rejects.toBeInstanceOf(UpstreamShapeError);
  });
});

/**
 * 证据自洽性：fixture 里存的原体必须与它记录的 sourceSha256 逐字节对应。
 *
 * 这条是**离线**的（不许联网，§四铁律）：它证明的是"文件内部自洽"，
 * 不能证明上游当时真返回过，也不能证明这份原体来自哪个 URL——那两点只能靠
 * 联网复核（本次已逐件重取验证过，见记录 §2.1）。
 * 但它能挡住一类很实际的事故：有人手改 payload 或粘贴错文件，导致原体与哈希不再对应。
 */
describe('【证据自洽】fixture 原体与 sourceSha256 逐字节对应', () => {
  const files = readdirSync(new URL('../src/sources/string/fixtures', import.meta.url))
    .filter((f) => f.endsWith('.json'));

  it('至少 17 份（新增件必须带 rawBody，不能只贴 payload）', () => {
    expect(files.length).toBeGreaterThanOrEqual(17);
  });

  it.each(files)('%s：sha256(rawBody) === sourceSha256，字节数也相等', (f) => {
    const doc = JSON.parse(readFileSync(
      new URL(`../src/sources/string/fixtures/${f}`, import.meta.url), 'utf8'));
    const cap = doc.capture ?? {};
    // 四件齐全才算实测：完整请求 / 状态+content-type / 采集元数据 / 原体哈希对应
    expect(cap.request, `${f}: 缺完整请求`).toBeTruthy();
    expect(typeof cap.status, `${f}: 缺状态`).toBe('number');
    expect(cap.contentType, `${f}: 缺 content-type 字段`).not.toBeUndefined();
    expect(cap.captureTimeStatus, `${f}: 缺采集时刻档位`).toBeTruthy();
    // 已知就写时刻、未知就写未知，不许留空
    if (cap.captureTimeStatus === '确证') expect(cap.capturedAt, `${f}: 标确证却没有时刻`).toBeTruthy();
    if (cap.captureTimeStatus === '未知') expect(cap.capturedAt, `${f}: 标未知却填了时刻`).toBeUndefined();

    expect(typeof doc.rawBody, `${f}: 缺 rawBody（原体）`).toBe('string');
    const bytes = Buffer.from(doc.rawBody, 'utf8');
    expect(bytes.length, `${f}: 原体字节数与 sourceBytes 不符`).toBe(cap.sourceBytes);
    expect(createHash('sha256').update(bytes).digest('hex').toUpperCase(),
      `${f}: 原体 sha256 与记录值不符`).toBe(cap.sourceSha256);
  });

  /**
   * 语义级核对（负责人 2026-11-01 定的两级验收的第二级）。
   *
   * 为什么必须显式用 canonicalJson 而不是只靠 `toEqual`：
   * 调研者实测发现 **Ensembl 的字节序不稳定**——三份 fixture 内容完全相同、只是键顺序不同，
   * 哈希就不同。也就是说 `sourceSha256` 相等是**字节级同一**，不是**语义级一致**。
   * 所以两级都要：
   *   身份级 `sha256(rawBody) === sourceSha256`  ← 证明"就是当时那份字节"
   *   语义级 `canonicalJson(parse(rawBody)) === canonicalJson(payload)` ← 不受键序影响
   * 这里把"键序无关"写成**可执行的规范化**，而不是依赖 `toEqual` 的实现细节。
   */
  const canonicalJson = (v: unknown): string => {
    const walk = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === 'object') {
        return Object.fromEntries(
          Object.keys(x as Record<string, unknown>).sort()
            .map((k) => [k, walk((x as Record<string, unknown>)[k])]));
      }
      return x;
    };
    return JSON.stringify(walk(v));
  };

  it('语义级：canonicalJson(原体) === canonicalJson(payload)，且不受键序影响', () => {
    /**
     * 逐份核对，**不许静默跳过**（负责人 2026-11-01 规矩：校验函数里的
     * `continue`/`return`/`if (!x) skip` 都是"看起来做了、其实没做"的人口）。
     * 分类计数后一次断言总数，少一份就红。
     */
    let jsonCount = 0;
    let textCount = 0;
    for (const f of files) {
      const doc = JSON.parse(readFileSync(
        new URL(`../src/sources/string/fixtures/${f}`, import.meta.url), 'utf8'));
      expect(typeof doc.rawBody, `${f}: 缺 rawBody，无法离线核对派生件`).toBe('string');
      expect(doc.payload, `${f}: 缺派生 payload`).not.toBeUndefined();

      if (!/^\s*[[{]/.test(doc.rawBody)) {
        // 非 JSON（HTML 转发桩）：**也要断言** payload 与原体逐字一致，不是跳过
        textCount += 1;
        expect(doc.payload, `${f}: 非 JSON 原体应与 payload 逐字一致`).toBe(doc.rawBody);
        // 不得声称是 JSON：这条堵住"200 却返回 HTML 还被当正常响应"的另一半
        expect(String(doc.capture.contentType ?? ''), `${f}: 非 JSON 原体却声称 JSON content-type`)
          .not.toContain('json');
      } else {
        jsonCount += 1;
        // 两级都断言：深相等（结构）+ 规范化串相等（键序无关，口径显式）
        expect(JSON.parse(doc.rawBody), `${f}: JSON.parse(原体) 与 payload 不一致`).toEqual(doc.payload);
        expect(canonicalJson(JSON.parse(doc.rawBody)), `${f}: 规范化后仍不一致`)
          .toBe(canonicalJson(doc.payload));
      }
    }
    // 总数必须覆盖全部文件：分类漏了哪份，这里立刻暴露
    expect(jsonCount + textCount, `分类总数 ${jsonCount}+${textCount} 应等于文件数 ${files.length}`)
      .toBe(files.length);
    // 两类的具体数字也钉住：JSON 16 / 非 JSON 1（唯一那份是 camelCase 的 HTML 转发桩）。
    // 数字取自脚本分类结果，不凭记忆；若改了就说明 fixture 结构变了，要人看一眼。
    expect({ jsonCount, textCount }).toEqual({ jsonCount: 16, textCount: 1 });
  });

  /**
   * 双哈希（负责人 2026-11-01 采纳调研者方案）：
   *   sourceSha256            → 当次原体字节，仅留痕，证明"这份原体没被改过"
   *   canonicalSha256         → 键排序后哈希，表示"**本次比较的这两份内容一致**"
   *                             （**不是**"跨次稳定"——那只对所比较的这两份成立）
   *
   * 起因：Ensembl Plants 同一请求两次抓，字节数全同、内容全同、**只是键序不同**，sha256 就全变了。
   * 若只认字节哈希，那 5 份正常件每次重抓都会报假 DIFF，最后一定有人把检查关掉。
   */
  it('每份都记了 canonicalSha256 两个字段，且与独立重算值一致', () => {
    for (const f of files) {
      const doc = JSON.parse(readFileSync(
        new URL(`../src/sources/string/fixtures/${f}`, import.meta.url), 'utf8'));
      const cap = doc.capture;
      expect(cap.canonicalSha256, `${f}: 缺 canonicalSha256`).toMatch(/^[0-9A-F]{64}$/);
      expect(cap.canonicalSha256OfRawBody, `${f}: 缺 canonicalSha256OfRawBody`).toMatch(/^[0-9A-F]{64}$/);
      // 重算：不许只信记录值
      const isJson = /^\s*[[{]/.test(doc.rawBody);
      const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase();
      const derived = isJson ? sha(canonicalJson(doc.payload)) : sha(doc.payload);
      const fromRaw = isJson ? sha(canonicalJson(JSON.parse(doc.rawBody))) : sha(doc.rawBody);
      expect(cap.canonicalSha256, `${f}: canonicalSha256 与重算不符`).toBe(derived);
      expect(cap.canonicalSha256OfRawBody, `${f}: canonicalSha256OfRawBody 与重算不符`).toBe(fromRaw);
      // 语义层必须一致（这是 canonical 存在的意义）
      expect(fromRaw, `${f}: 原体与派生件规范化后不一致`).toBe(derived);
    }
  });

  /**
   * 双哈希口径必须写明**边界**。
   *
   * 上一版这两条断言是这样写的：
   *   `.toContain('跨次稳定')` / `.toContain('不可复现')`
   * ——**它们钉住的是不成立的结论**。`canonical` 只对所比较的这两份内容成立，
   * 不能推出"跨次永远稳定"；同理"字节哈希不可复现"是对某个上游某段时间的观察，
   * 不是普遍性质。**一个断言若钉住不成立的结论，比没有断言更坏**：
   * 以后谁写了正确实现、得到不同结果反而会被它判红，而它今天全绿会让人以为这性质被验证过。
   * （负责人 2026-11-01 定性：P1 级测试缺陷，不是 P2 文案。）
   *
   * 现在只断言**边界必须被写出来**，不断言那个不成立的绝对性质。
   */
  it('双哈希口径必须写明边界：不证明历史采集、不保证未来跨次相同', () => {
    for (const f of files) {
      const doc = JSON.parse(readFileSync(
        new URL(`../src/sources/string/fixtures/${f}`, import.meta.url), 'utf8'));
      const note = doc.capture.canonicalNote as string;
      expect(note, `${f}: 缺双哈希口径说明`).toBeTruthy();
      // 必须写明「本次比较的两份」这个限定，而不是宣称跨次稳定
      expect(note, `${f}: 未写明 canonical 的适用边界`).toContain('本次比较的这两份内容一致');
      expect(note, `${f}: 未声明不保证未来抓取仍相同`).toContain('不保证未来抓取仍相同');
      // **反向断言：不许再出现那两个绝对措辞**
      expect(note, `${f}: 仍宣称"跨次稳定"这一不成立的绝对性质`).not.toContain('跨次稳定');
      expect(note, `${f}: 仍宣称"不可复现"这一未验证的普遍性`).not.toContain('不可复现');
      // rawBodyNote 同理：不许把"与基线一致"写成"与当初一致"
      const rawNote = doc.capture.rawBodyNote as string;
      expect(rawNote, `${f}: 未声明不证明历史采集`).toContain('不证明历史采集发生过');
      expect(rawNote, `${f}: 仍把"与基线一致"写成"与当初一致"`).not.toContain('故与当初那次抓取的响应逐字节一致');
    }
  });

  it('规范化函数本身要能吃掉键序差异（否则上面那条是恒真的摆设）', () => {
    const a = { b: 1, a: [{ d: 2, c: 3 }] };
    const b = { a: [{ c: 3, d: 2 }], b: 1 };
    // 原始序列化不同（这正是 Ensembl 字节序不稳定的形态）……
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    // ……但规范化后必须相等
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    // 值真的不同时必须不等（防止规范化把所有东西都抹平）
    expect(canonicalJson(a)).not.toBe(canonicalJson({ b: 1, a: [{ d: 2, c: 4 }] }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));  // 数组顺序有意义，不许排序
  });

  it('新采集的原体不得被用来补证旧抓取时刻（每份都要判定，不许按字段跳过）', () => {
    /**
     * 原写法 `if (cap.rawBodySource !== 're-collected') continue;` 是**真违规**：
     * 某份 fixture 若丢了 `rawBodySource` 字段，它会被静默放过——
     * 而"新采集时刻被拿来补旧时刻"正是这条要防的，漏检的恰恰是最可疑的那种。
     *
     * 现在改成**三分类、逐份判定、总数核对**：
     *   re-collected → 必须齐字段，且不得升格 capturedAt
     *   其它值（含缺失）→ 必须**没有** recapture 相关字段（防止有人只加半边）
     * 每类都计数，最后核总数。
     */
    let recaptured = 0;
    let notRecaptured = 0;
    for (const f of files) {
      const doc = JSON.parse(readFileSync(
        new URL(`../src/sources/string/fixtures/${f}`, import.meta.url), 'utf8'));
      const cap = doc.capture;

      if (cap.rawBodySource === 're-collected') {
        recaptured += 1;
        // 重取件必须自带采集时刻……
        expect(cap.rawBodyCollectedAt, `${f}: 标了 re-collected 却没有采集时刻`)
          .toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // ……但**不能**因此把原始抓取时刻升格为"确证"
        if (cap.captureTimeStatus === '未知') {
          expect(cap.capturedAt, `${f}: 原始时刻未知，却因重取而填了 capturedAt`).toBeUndefined();
        }
        expect(cap.rawBodyNote, `${f}: 缺"不得据此外推时刻"的说明`).toContain('不得据此');
      } else {
        // 不是重取件：**必须没有**重取字段。否则是半套标注，比不标更误导
        notRecaptured += 1;
        expect(cap.rawBodyCollectedAt, `${f}: 未标 re-collected 却有 rawBodyCollectedAt`)
          .toBeUndefined();
      }
    }
    expect(recaptured + notRecaptured, '分类总数应等于文件数').toBe(files.length);
    // 本批 17 份**全部**是重取件（新采集），故 notRecaptured 必须为 0。
    // 将来若有真·原始抓取件混入，这个数字会变，提醒人复核而不是默默放过。
    expect({ recaptured, notRecaptured }).toEqual({ recaptured: 17, notRecaptured: 0 });
  });

  it('合成的件必须标 simulated:true（本批 STRING 一份都没有）', () => {
    for (const f of files) {
      const doc = JSON.parse(readFileSync(
        new URL(`../src/sources/string/fixtures/${f}`, import.meta.url), 'utf8'));
      expect(doc.capture.simulated, `${f}: 必须是真抓件`).toBe(false);
    }
  });
});

/**
 * 缺失值规则（负责人 2026-11-01 裁定，覆盖我上一版"缺失即拒答"的做法）：
 *
 * `null` 是"上游没给"，`0` 是"给了，值是零"——科学含义相反。
 * 规则是 **缺失一律显示"未提供"，不许补 0、不许补空串、不许 `??` 兜成任何具体值**；
 * 但**越界值（1.5 / -0.2 / NaN）仍必须抛错**，那是刻度漂移，不是缺失。
 * 两者分开处理：缺失是可容忍的事实，漂移是必须报的故障。
 */
describe('【缺失值】null/空串 显示"未提供"，但越界仍抛错', () => {
  it('score: null → 显示"未提供"，不是 0.000，也不算拒答', async () => {
    const doc = read('partners-pos.json') as { payload: Array<Record<string, unknown>> };
    const withNull = doc.payload.map((r) => ({ ...r, score: null }));
    const out = await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2' }, ok(withNull).ctx);
    // 正文里必须出现"未提供"，且绝不能出现 0.000 冒充分数
    expect(out.text).toContain('未提供');
    expect(out.text).not.toContain('0.000');
    // 必须显式说明"这不等于 0 分"
    expect(out.text).toContain('这不等于 0 分');
    // 结构层：score 为 undefined，不是 0
    const p = (out.raw as { partners: Array<{ score?: number }> }).partners[0]!;
    expect(p.score).toBeUndefined();
    expect(p.score).not.toBe(0);
  });

  it.each([[''], [undefined], [null]])(
    'score=%s → 按"未提供"处理，不退化成 0', async (bad) => {
      const doc = read('partners-pos.json') as { payload: Array<Record<string, unknown>> };
      const rows = doc.payload.map((r) => ({ ...r, score: bad }));
      const out = await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2' }, ok(rows).ctx);
      expect(out.text).toContain('未提供');
      expect(out.text).not.toContain('0.000');
      expect((out.raw as { partners: Array<{ score?: number }> }).partners[0]!.score).toBeUndefined();
    });

  it.each([[1.5], [-0.2], [Number.NaN], ['abc'], [[]], [false], [{}]])(
    'score=%s 是坏值/越界 → 必须抛错（"没给"与"给错了"不许合并）', async (bad) => {
      const doc = read('partners-pos.json') as { payload: Array<Record<string, unknown>> };
      const rows = doc.payload.map((r) => ({ ...r, score: bad }));
      await expect(interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2' }, ok(rows).ctx))
        .rejects.toBeInstanceOf(UpstreamShapeError);
    });

  it('score: 0 是合法值，且必须显示成 0.000（不许被当成"未提供"）', async () => {
    const doc = read('partners-pos.json') as { payload: Array<Record<string, unknown>> };
    const zero = doc.payload.map((r) => ({ ...r, score: 0 }));
    const out = await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2' }, ok(zero).ctx);
    expect((out.raw as { partners: Array<{ score?: number }> }).partners[0]!.score).toBe(0);
    expect(out.text).toContain('0.000');
    expect(out.text).not.toContain('这不等于 0 分');   // 全都有值时不该出那条警示
  });

  it('分通道 null 不进"主要证据"（原实现会被算成 0 并参与排序）', async () => {
    const doc = read('partners-pos.json') as { payload: Array<Record<string, unknown>> };
    const rows = doc.payload.map((r) => ({
      ...r, nscore: null, fscore: null, pscore: null, ascore: null, escore: null, dscore: null, tscore: null,
    }));
    const out = await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2' }, ok(rows).ctx);
    const p = (out.raw as any).partners[0];
    expect(p.topChannels).toEqual([]);       // 没有任何有效通道，而不是一串 0
    expect(p.channelCount).toBe(0);
  });
});

describe('【硬要求 4】输出只给名字 + score + 主通道；清洗 HTML', () => {
  it('cleanErrorMessage 去掉标签与实体', () => {
    const raw = '<p>Sorry<br/>not found</p>&nbsp;here';
    const cleaned = cleanErrorMessage(raw)!;
    expect(cleaned).not.toContain('<');
    expect(cleaned).not.toContain('&nbsp;');
    expect(cleaned).toContain('Sorry');
  });
  it('正文受 1408 字节约束且不交统一截断', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      stringId_A: '3702.Q9SXZ2', stringId_B: `3702.P${i}`, preferredName_A: 'FT',
      preferredName_B: `PARTNER_${i}`, ncbiTaxonId: 3702, score: 0.9,
      nscore: 0, fscore: 0, pscore: 0, ascore: 0, escore: 0.8, dscore: 0.7, tscore: 0,
    }));
    const out = await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2', limit: 100 }, ok(many).ctx);
    const raw = out.raw as any;
    expect(raw.total).toBe(60);
    expect(raw.shown + raw.omitted).toBe(60);
    expect(utf8Bytes(out.text.split('\n——\n')[0]!)).toBeLessThanOrEqual(1408);
    expect(out.text).not.toContain('正文已按');
    if (raw.omitted > 0) expect(out.text).toContain('另有');
  });
  it('content-type 为 text/json 也要接受（上游实际返回）', async () => {
    const f = payload('resolve-pos.json');
    const out = await resolveIds.run({ species: 3702, identifier: 'AT1G65480' }, ok(f, 'text/json; charset=utf-8').ctx);
    expect((out.raw as any).resolved).toBe(1);
  });
  it('content-type 为 text/html（转发桩）→ 报漂移不解析', async () => {
    const f = payload('resolve-pos.json');
    await expect(resolveIds.run({ species: 3702, identifier: 'AT1G65480' }, ok(f, 'text/html').ctx))
      .rejects.toBeInstanceOf(UpstreamShapeError);
  });
});

describe('【新裁定】空结果必须带条件限定 + 参数是本仓策略', () => {
  it('partners 空结果必须写明"在 required_score ≥ N 下"，不得说"该基因没有互作"', async () => {
    const out = await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2', required_score: 999 }, ok([]).ctx);
    expect(out.text).toContain('required_score ≥ 999');
    expect(out.text).toContain('上游刻度 0–1000');
    // 必须声明"不区分"
    expect(out.text).toContain('无法区分');
    // 不得出现**无条件肯定式**（"该基因没有互作"作为独立断言）；
    // 允许"这不等于「该基因没有互作」"这种否定式说明。
    const affirmative = /(?<!这不等于[“"])该基因没有互作(?!”)/;
    expect(out.text).not.toMatch(affirmative);
    expect(out.text).toContain('这不等于“该基因没有互作”');
    const conds = (out.raw as any).emptyCondition as Array<{ condition: string; current: unknown }>;
    expect(conds.find((c) => c.condition === 'required_score')!.current).toBe(999);
    expect(conds.find((c) => c.condition === 'species')!.current).toBe(3702);
  });
  it('required_score 默认 400，且默认会写进正文条件', async () => {
    const out = await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2' }, ok([]).ctx);
    expect(out.text).toContain('required_score ≥ 400');
  });
  it('required_score 默认值会真的发给上游作为参数', async () => {
    const { ctx, urls } = ok(payload('partners-pos.json'));
    await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2' }, ctx);
    expect(urls[0]).toContain('required_score=400');
  });
  it('resolve 空结果也要带条件限定（species + identifier 当前值）', async () => {
    const out = await resolveIds.run({ species: 3702, identifier: 'NO_SUCH_ZZZ' }, ok([]).ctx);
    expect(out.text).toContain('在 species=3702');
    expect(out.text).toContain('identifier=「NO_SUCH_ZZZ」');
    expect((out.raw as any).emptyCondition).toBeTruthy();
  });
  it('limit / required_score 的描述必须标明"本仓策略"而非上游限制', () => {
    const props = interactionPartners.parameters.properties as Record<string, { description?: string }>;
    expect(props.limit!.description).toContain('本仓策略');
    expect(props.limit!.description).toContain('不是上游限制');
    expect(props.required_score!.description).toContain('必须可调');
    // 不得写成"上游最多 100"
    expect(props.limit!.description).not.toContain('上游最多');
  });
});

describe('【判据】条件必须是用户能改的，且带当前值', () => {
  it('partners 空：条件含当前阈值与可调范围（不是抽象"有条件"）', async () => {
    const out = await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2', required_score: 999 }, ok([]).ctx);
    expect(out.text).toContain('required_score ≥ 999');          // 当前值
    expect(out.text).toContain('最低 0');                         // 可调范围
    expect(out.text).toContain('可把 required_score 调低');       // 可执行动作
    const conds = (out.raw as any).emptyCondition as Array<{ condition: string; current: unknown; adjustable: unknown[] }>;
    expect(conds.find((c) => c.condition === 'required_score')!.current).toBe(999);
  });
  it('resolve 空：两个可调条件都给出当前值与可选值', async () => {
    const out = await resolveIds.run({ species: 3702, identifier: 'NO_SUCH_ZZZ' }, ok([]).ctx);
    expect(out.text).toContain('identifier=「NO_SUCH_ZZZ」');      // 当前值
    expect(out.text).toContain('UniProt');                        // 可换成什么
    expect(out.text).toContain('species 当前为 3702');             // 当前值
    expect(out.text).toContain('3702（拟南芥）/ 39947 / 4530');    // 可选集合
    interface CondItem { condition: string; current: unknown; adjustable: unknown[] }
    const cond = (out.raw as { emptyCondition: CondItem[] }).emptyCondition;
    const sp2 = cond.find((c) => c.condition === 'species')!;
    const idc = cond.find((c) => c.condition === 'identifier')!;
    expect(sp2.current).toBe(3702);
    expect(sp2.adjustable).toEqual([3702, 39947, 4530]);
    expect(idc.current).toBe('NO_SUCH_ZZZ');
  });
  it('省略提示必须带当前 limit 与 required_score 数值', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      stringId_A: '3702.Q9SXZ2', stringId_B: `3702.P${i}`, preferredName_A: 'FT',
      preferredName_B: `PARTNER_${i}`, ncbiTaxonId: 3702, score: 0.9,
      nscore: 0, fscore: 0, pscore: 0, ascore: 0, escore: 0.8, dscore: 0.7, tscore: 0,
    }));
    const out = await interactionPartners.run(
      { species: 3702, string_id: '3702.Q9SXZ2', limit: 5, required_score: 700 }, ok(many).ctx);
    const raw = out.raw as any;
    if (raw.omitted > 0) {
      expect(out.text).toContain('当前 limit=5');
      expect(out.text).toContain('required_score=700');
    }
  });
});

describe('【v3 核对】策略不得写成上游事实（description 也要查）', () => {
  it('工具描述不得出现"上游最多/上游只支持/只认它自己的ID"这类伪装', () => {
    for (const t of tools) {
      expect(t.description, t.name).not.toContain('上游最多');
      expect(t.description, t.name).not.toContain('上游只支持');
      expect(t.description, t.name).not.toContain('只认它自己的 ID');
      expect(t.description, t.name).not.toContain('必须传 stringId');
    }
  });
  it('description 必须显式声明"本仓策略"，并把上游事实与本仓选择分列', () => {
    const partner = interactionPartners.description;
    // 上游事实：上游自己会解析——不得写成"必须先解析"
    expect(partner).toContain('上游会自行解析基因名');
    expect(partner).toContain('不是接口要求');
    // 本仓选择：要求传已解析 ID，且明确标注是策略
    expect(partner).toContain('这是本仓策略、不是接口限制');
    const resolve = resolveIds.description;
    // resolve 必须定位成"可选"，不得再制造前置必要性
    expect(resolve).toContain('可选工具');
    expect(resolve).toContain('不是查互作的前置步骤');
    expect(resolve).toContain('上游 interaction_partners 本身就能解析基因名');
  });
  it('description 必须写明身份核验方式（STR-A 要求给出调用链内核验手段）', () => {
    const partner = interactionPartners.description;
    expect(partner).toContain('身份核验方式');
    expect(partner).toContain('taxon 前缀');
    // 形状合法但无效的 ID 由上游明确否定，不是空——这一条要写出"不是空数组"
    expect(partner).toContain('404');
    expect(partner).toContain('不是空数组');
  });
  it('resolve_ids 不得写成"必须先调"（v3 §8.1 已撤回）', () => {
    expect(resolveIds.description).not.toContain('必须先调');
    expect(resolveIds.description).not.toContain('建议先调');
    expect(resolveIds.description).not.toContain('查互作前必须');
  });
  it('非法 string_id 的错误文案必须给两条可执行动作，且不把 resolve 说成唯一出路', async () => {
    await expect(interactionPartners.run({ species: 3702, string_id: 'AT1G65480' }, ok([]).ctx))
      .rejects.toThrow(/可做的两件事/);
    // 必须包含"核对前缀"这条独立动作，而不只是"去调 resolve"
    await expect(interactionPartners.run({ species: 3702, string_id: 'AT1G65480' }, ok([]).ctx))
      .rejects.toThrow(/核对是否包含/);
  });
  it('manifest.caveats 不得残留"必须两步"或"物种必须显式指定"式上游事实表述', () => {
    const text = manifest.caveats.join('\n');
    expect(text).not.toContain('**必须两步**');
    expect(text).not.toContain('**物种必须显式指定**');
    // 也不得残留"只认 stringId / 未解析会得到空数组"这类已被实测推翻的说法
    expect(text).not.toContain('只认 STRING 自己的 stringId');
    expect(text).not.toContain('未解析的基因编号会得到空数组');
    // 必须把两条都标成本仓策略
    expect(text).toContain('上游会自行解析基因名');
    expect(text).toContain('**这是本仓策略，不是接口限制**');
    expect(text).toContain('**`species` 必填是本仓策略，理由已实测**');
  });
  it('manifest.caveats 按端点分列"没有"的三种形态，且标明不许互相借用', () => {
    const text = manifest.caveats.join('\n');
    expect(text).toContain('按端点各自成立');
    expect(text).toContain('404 + Error:"not found"');
    expect(text).toContain('nothing found');
    expect(text).toContain('不接');
    // 物种回显写成"明确映射表"，不许出现"就近解析"这种外推说法
    expect(text).toContain('明确映射表');
    expect(text).not.toContain('就近解析');
  });
  it('species 必填的理由必须写成实测证据，不得写成"不传结果相同"', () => {
    const text = manifest.caveats.join('\n');
    // 实测：不传 species 会跨物种乱解析（FT → 小鼠 10090），这是必填的真正理由
    expect(text).toContain('10090.ENSMUSP00000112375');
    expect(text).toContain('小鼠');
    expect(text).toContain('不传时**会跨物种乱解析**');
    // 旧说法是把未验证的推断写成上游事实，已撤回
    expect(text).not.toContain('不传也能 200 且结果相同');
  });
  it('不传 species 的乱解析有真实原件，且能回放（证据不是转述）', async () => {
    const doc = read('resolve-nospecies-FT.json') as {
      capture: { request: string; simulated: boolean; status: number };
      payload: Array<Record<string, unknown>>;
    };
    expect(doc.capture.simulated).toBe(false);
    expect(doc.capture.request).toContain('identifiers=FT');
    expect(doc.capture.request).not.toContain('species=');
    expect(doc.capture.status).toBe(200);
    // 同一 "FT"，不传 species 落到小鼠；这就是 requireTaxon 强制必填的实测依据
    expect(doc.payload[0]!.stringId).toBe('10090.ENSMUSP00000112375');
    expect(doc.payload[0]!.ncbiTaxonId).toBe(10090);
    expect(doc.payload[0]!.taxonName).toBe('Mus musculus');
    // 而传 3702 是拟南芥（resolve-pos.json 同查询）
    const pos = payload('resolve-pos.json') as Array<Record<string, unknown>>;
    expect(pos[0]!.stringId).toBe('3702.Q9SXZ2');
  });
  it('limit 在 resolve 端点无效这条必须如实写明（不许把它写成能截断候选）', () => {
    const text = manifest.caveats.join('\n');
    expect(text).toContain('未观察到任何效果');
    expect(text).toContain('已不发送该参数');
    expect(text).toContain('解释不了的魔数');
  });
  it('resolve 实际请求不再带 limit（魔数已删，不是改成别的数）', async () => {
    const { ctx, urls } = ok(payload('resolve-pos.json'));
    await resolveIds.run({ species: 3702, identifier: 'AT1G65480' }, ctx);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('get_string_ids');
    expect(urls[0]).toContain('identifiers=AT1G65480');
    expect(urls[0]).toContain('species=3702');
    expect(urls[0]).not.toContain('limit=');
  });
});

describe('【第三层】emptyCondition 结构化：三要素必填 + 断言可抓', () => {
  const REQUIRED = ['condition', 'current', 'adjustable', 'action'] as const;

  function assertStructured(cond: unknown, label: string): void {
    expect(Array.isArray(cond), `${label}: emptyCondition 必须是数组`).toBe(true);
    const items = cond as Array<Record<string, unknown>>;
    expect(items.length, `${label}: 至少一项`).toBeGreaterThan(0);
    for (const item of items) {
      for (const key of REQUIRED) {
        expect(Object.hasOwn(item, key), `${label}: 缺字段 ${key}`).toBe(true);
      }
      expect(item.condition, label).toBeTruthy();
      expect(item.current, `${label}: current 不得为空`).not.toBe('');
      expect(item.current, label).not.toBeUndefined();
      expect(Array.isArray(item.adjustable), label).toBe(true);
      expect((item.adjustable as unknown[]).length, `${label}: adjustable 不得为空`).toBeGreaterThan(0);
      expect(item.action, `${label}: action 不得为空`).toBeTruthy();
    }
  }

  it('partners 空分支 → 结构化条件完整', async () => {
    const out = await interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2', required_score: 999 }, ok([]).ctx);
    assertStructured((out.raw as any).emptyCondition, 'partners');
    const cond = (out.raw as any).emptyCondition as any[];
    const score = cond.find((c) => c.condition === 'required_score')!;
    expect(score.current).toBe(999);
    expect(score.action).toContain('999');
  });

  it('resolve 空分支 → 结构化条件完整（identifier + species 两项）', async () => {
    const out = await resolveIds.run({ species: 3702, identifier: 'NO_SUCH_ZZZ' }, ok([]).ctx);
    assertStructured((out.raw as any).emptyCondition, 'resolve');
    const cond = (out.raw as any).emptyCondition as any[];
    expect(cond.map((c) => c.condition)).toEqual(['identifier', 'species']);
    expect(cond[0]!.current).toBe('NO_SUCH_ZZZ');
    expect(cond[1]!.adjustable).toEqual([3702, 39947, 4530]);
  });

  it('【新判据】action 必须指向我们真实提供的工具入口，不能只说"确认/换一种"', async () => {
    const KNOWN_TOOLS = ['string_resolve_ids', 'string_interaction_partners'];
    const cases: Array<[string, Promise<unknown>]> = [
      ['partners', interactionPartners.run({ species: 3702, string_id: '3702.Q9SXZ2', required_score: 999 }, ok([]).ctx)],
      ['resolve', resolveIds.run({ species: 3702, identifier: 'NO_SUCH_ZZZ' }, ok([]).ctx)],
    ];
    for (const [label, p] of cases) {
      const out = await (p as Promise<{ raw: unknown }>);
      const conds = (out.raw as { emptyCondition: Array<{ action: string; condition: string; current: unknown }> }).emptyCondition;
      for (const c of conds) {
        // 动作必须点名要重新调用的工具（否则用户知道该改却不知道怎么走下一步）
        expect(
          KNOWN_TOOLS.some((t) => c.action.includes(t)),
          `${label}/${c.condition}: action 未指向任何已提供的工具入口 → "${c.action}"`,
        ).toBe(true);
        // 动作必须包含当前值或替代值，不能是"确认是否正确"这类诊断
        expect(c.action, `${label}/${c.condition}`).not.toMatch(/^确认/);
        expect(c.action, `${label}/${c.condition}`).not.toBe('换一种标识符形式重试');
      }
    }
  });

  it('buildEmptyCondition 拒绝三类不合格输入（结构上写不出无条件空）', () => {
    expect(() => buildEmptyCondition([])).toThrow(/至少带一个/);
    expect(() => buildEmptyCondition([{ condition: 'species', current: '', adjustable: [1], action: 'x' }])).toThrow(/current 不得为空/);
    expect(() => buildEmptyCondition([{ condition: 'species', current: 3702, adjustable: [], action: 'x' }])).toThrow(/adjustable 不得为空/);
    expect(() => buildEmptyCondition([{ condition: 'species', current: 3702, adjustable: [1], action: '  ' }])).toThrow(/action 不得为空/);
  });

  it('合法输入通过且是不可变副本（改它不影响原数组）', () => {
    const src = [{ condition: 'species' as const, current: 3702, adjustable: [3702, 39947], action: 'a' }];
    const out = buildEmptyCondition(src);
    expect(out[0]).not.toBe(src[0]);
    out[0]!.adjustable.push(4530);
    expect(src[0]!.adjustable).toHaveLength(2);
  });
});

describe('注册与边界', () => {
  it('独立注册表硬校验通过，两个工具都带源前缀', () => {
    const registry = new ToolRegistry();
    registry.register({ manifest, tools });
    expect(registry.listTools().map((t) => t.name))
      .toEqual(['string_resolve_ids', 'string_interaction_partners']);
    expect(manifest.tier).toBe('T1');
    expect(manifest.docs).toBeTruthy();
  });
  it('白名单是常量，含三个独立输入值（3702 / 39947 / 4530）', () => {
    expect(Object.keys(SPECIES).map(Number).sort()).toEqual([3702, 39947, 4530]);
    expect(Object.isFrozen(SPECIES)).toBe(true);
  });
  it('描述不含 network / enrichment 的能力暗示', () => {
    for (const t of tools) {
      expect(t.description).not.toContain('网络图可以');
    }
    expect(interactionPartners.description).toContain('不返回网络图');
  });
});

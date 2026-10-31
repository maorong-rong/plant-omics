import { describe, expect, it } from 'vitest';

import { describeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import { RAW_BODY_LIMIT_BYTES, createFetcher, retryDelayMs } from '../src/core/http.js';
import type { HttpResult } from '../src/core/types.js';

/**
 * HTTP 层的单元测试。
 *
 * 审查 R08 点名的空白：这个文件是全仓最容易出错的（重试/超时/取消/限流），
 * 却一行测试都没有。下面每条都对应一个**具体会误导用户的行为**。
 */

const response = (status: number, body = '{}', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

describe('retryDelayMs（纯函数，避免用墙钟断言延迟）', () => {
  it('无 Retry-After 时用确定性退避：第 1 次 400 ms，第 2 次 1200 ms', () => {
    expect(retryDelayMs(1)).toBe(400);
    expect(retryDelayMs(2)).toBe(1_200);
    expect(retryDelayMs(3)).toBe(1_200); // 封顶
  });

  it('429/503 优先服从 Retry-After（秒 → 毫秒）', () => {
    expect(retryDelayMs(1, 429, '2')).toBe(2_000);
    expect(retryDelayMs(1, 503, '1')).toBe(1_000);
  });

  it('Retry-After 再长也不超过 10 s 上限（否则一次工具调用能挂死会话）', () => {
    expect(retryDelayMs(1, 429, '60')).toBe(10_000);
  });

  it('非 429/503 时忽略 Retry-After', () => {
    expect(retryDelayMs(1, 500, '30')).toBe(400);
  });
});

describe('createFetcher', () => {
  it('5xx 会重试，成功后返回真实尝试次数', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 3 ? response(503, 'down') : response(200, '{"ok":true}');
    }) as unknown as typeof fetch;

    const fetchJson = createFetcher({ timeoutMs: 500, retries: 2 }, fetchImpl);
    const result = await fetchJson<{ ok: boolean }>('https://example.org/x');

    expect(result.status).toBe(200);
    expect(result.data.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it('4xx 不重试：只发一次请求就抛', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(404, 'not found');
    }) as unknown as typeof fetch;

    const fetchJson = createFetcher({ timeoutMs: 500, retries: 2 }, fetchImpl);
    await expect(fetchJson('https://example.org/x')).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it('超时抛「上游请求超时」，不是「无法连接」', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    const fetchJson = createFetcher({ timeoutMs: 30, retries: 0 }, fetchImpl);
    await expect(fetchJson('https://example.org/x')).rejects.toThrow(/超时/);
  });

  it('调用方取消时报「已取消」，且不再重试', async () => {
    let calls = 0;
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        calls += 1;
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    const controller = new AbortController();
    const fetchJson = createFetcher({ timeoutMs: 5_000, retries: 2 }, fetchImpl);
    const pending = fetchJson('https://example.org/x', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/取消/);
    expect(calls).toBe(1);
  });

  it('返回非 JSON 时明确说是「不是合法 JSON」，而不是当成空数据', async () => {
    const fetchImpl = (async () => response(200, '<html>oops</html>')) as unknown as typeof fetch;
    const fetchJson = createFetcher({ timeoutMs: 500, retries: 0 }, fetchImpl);
    await expect(fetchJson('https://example.org/x')).rejects.toThrow(/不是合法 JSON/);
  });

  it('总时长上限真的生效：剩余预算不够退避时不再硬等', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(503, 'down');
    }) as unknown as typeof fetch;

    // 单次 30 ms 超时、总上限 50 ms：第 2 次要等 400 ms，必然超预算
    const fetchJson = createFetcher({ timeoutMs: 30, retries: 2, maxTotalMs: 50 }, fetchImpl);
    await expect(fetchJson('https://example.org/x')).rejects.toThrow(/上限/);
    expect(calls).toBe(1);
  });
});

describe('正文分类（均为模拟响应，非真实上游证据）', () => {
  it('零长度正文与空对象可区分，保持原有data兼容行为', async () => {
    const empty = await createFetcher({}, (async () => response(200, '')) as typeof fetch)('https://example.org/x');
    const object = await createFetcher({}, (async () => response(200, '{}')) as typeof fetch)('https://example.org/x');
    expect(empty).toMatchObject({ data: {}, bodyKind: 'empty', status: 200 });
    expect(object).toMatchObject({ data: {}, bodyKind: 'json', status: 200 });
  });

  it.each(['{}', '[]', 'null', '0', 'false', '""'])('合法JSON %s 保持解析值并标记json', async (body) => {
    const result = await createFetcher({}, (async () => response(200, body)) as typeof fetch)('https://example.org/x');
    expect(result.bodyKind).toBe('json');
    expect(result.data).toEqual(JSON.parse(body));
  });

  it.each([' ', '\n\t', '<html>oops</html>', '{'])('非空无效JSON %j 失败且不重试', async (body) => {
    let calls = 0;
    const fake = (async () => { calls++; return response(200, body); }) as typeof fetch;
    await expect(createFetcher({ retries: 2 }, fake)('https://example.org/x')).rejects.toThrow(/不是合法 JSON/);
    expect(calls).toBe(1);
  });

  it.each([404, 429, 503])('空体HTTP %i 仍失败，不进入成功分类', async (status) => {
    let calls = 0;
    const fake = (async () => { calls++; return response(status, ''); }) as typeof fetch;
    await expect(createFetcher({ retries: 0 }, fake)('https://example.org/x'))
      .rejects.toMatchObject({ meta: { status, attempts: 1 } });
    expect(calls).toBe(1);
  });

  it('旧fixture缺标记保持未知，不等于empty', () => {
    const legacy: HttpResult = { data: {}, url: 'https://example.org/x', status: 200, durationMs: 0, attempts: 1 };
    expect(legacy.bodyKind).toBeUndefined();
    expect(legacy.bodyKind === 'empty').toBe(false);
  });
});

describe('响应类型及模拟429（非真实上游证据）', () => {
  it('GET成功响应保留content-type', async () => {
    const fake = (async () => response(200, '{"ok":true}', { 'content-type': 'application/json' })) as typeof fetch;
    expect((await createFetcher({}, fake)('https://example.org/x')).contentType).toBe('application/json');
  });
  it('HTML404不能解释为生物学不存在', async () => {
    const fake = (async () => response(404, '<html>fallback</html>', { 'content-type': 'text/html' })) as typeof fetch;
    await expect(createFetcher({}, fake)('https://example.org/x')).rejects.toMatchObject({
      meta: { status: 404, contentType: 'text/html' },
    });
    await expect(createFetcher({}, fake)('https://example.org/x')).rejects.toThrow(/无法据此判断基因是否存在/);
  });
  it('模拟429超过总预算时不重复请求并保留限流状态', async () => {
    let calls = 0;
    const fake = (async () => { calls++; return response(429, '{"message":"slow"}', { 'retry-after': '60' }); }) as typeof fetch;
    await expect(createFetcher({ maxTotalMs: 100, retries: 2 }, fake)('https://example.org/x'))
      .rejects.toMatchObject({ meta: { status: 429, attempts: 1, retryAfter: '60' } });
    expect(calls).toBe(1);
  });
});

/**
 * 上游原文不得进入模型可见的错误文本。
 *
 * 为什么需要这条：`describeError()` 是把 `error.message` 直接拼给模型的唯一出口
 * （两个出口都用它：`src/mcp/server.ts`、`src/service/http.ts`）。因此「错误消息由谁生成」
 * 直接决定上游正文会不会进上下文——若有人图省事写成
 * `new UpstreamError(上游原文, …)`，上游的整页 HTML 就会原样进上下文。
 *
 * 每条用例都**先证明哨兵真的在响应里**：`bodySnippet` 必须含哨兵。
 * 少了这半句，断言就是空转——响应里没有哨兵时，怎么拼都不会出现，
 * 测试会一直绿，等于没测。
 *
 * 2026-10-30 止血：本组用例覆盖的五条路径，上游可控文本**全部**不进模型可见文本。
 * 此前唯一例外（400 + JSON 的 `message`）已按负责人决定去掉，理由见最后一个用例的注释。
 * 注意 `AGENTS.md` 的规则文本尚未随之更新，规则变更单独走授权。
 */
describe('错误文本不得带出上游原文（哨兵断言）', () => {
  const SENTINEL = '哨兵_SENTINEL_ZZZ9';

  /** 造一个固定返回某状态与正文的 fetcher；retries=0 保证只发一次。 */
  const failingWith = (status: number, body: string, contentType: string) =>
    createFetcher({ timeoutMs: 500, retries: 0 }, (async () =>
      response(status, body, { 'content-type': contentType })) as typeof fetch);

  const captureError = async (fetchJson: ReturnType<typeof createFetcher>) => {
    try {
      await fetchJson('https://example.org/x');
    } catch (error) {
      return error as { message: string; meta: { bodySnippet?: string; rawBody?: string; rawBodyTruncated?: boolean } };
    }
    throw new Error('本用例要求上游失败，但 fetchJson 没有抛错');
  };

  /**
   * 断言分两半，缺一不可：
   *   ① 哨兵确实被收进了 `bodySnippet` 与 `rawBody`（证明这次响应里真有哨兵）；
   *   ② 模型可见的错误文本里没有哨兵。
   *
   * 2026-10-30 起 `rawBody` 也进 `meta`（给源层做严格结构判定）。它携带**完整**上游正文，
   * 所以"不进模型可见文本"这条比只靠 `bodySnippet` 时更值得钉：唯一出口 `describeError()`
   * 只拼 message 与元数据，不拼 `rawBody`。
   */
  const expectLeakFree = async (status: number, body: string, contentType: string) => {
    const error = await captureError(failingWith(status, body, contentType));
    expect(error.meta.bodySnippet, `HTTP ${status} 的响应正文应被收进 bodySnippet`).toContain(SENTINEL);
    expect(error.meta.rawBody, `HTTP ${status} 的响应正文应被原样收进 rawBody`).toContain(SENTINEL);
    expect(describeError(error)).not.toContain(SENTINEL);
    return error;
  };

  it('502 纯文本正文含哨兵：错误文本只有分类文案，不带正文', async () => {
    const error = await expectLeakFree(502, `upstream said ${SENTINEL}`, 'text/plain');
    expect(error.message).toMatch(/上游后端暂时不可用/);
  });

  /**
   * 5xx 文案不许替上游下结论（2026-10-30，ENSP-04）。
   *
   * 旧文案写「通常是对面接口服务在重启或过载，不是本工具配置问题」——两半都观测不到：
   * 重启/过载是本机看不到的因果，而"不是本工具配置问题"是排除性结论。
   * 同一份规则见 AGENTS §十一（HTTP 5xx/DNS/代理错误不足以确定"上游重启"或排除本机配置原因）。
   */
  it('5xx 文案只写观测到的状态与"未验证"，不断言上游原因', async () => {
    const error = await expectLeakFree(503, `upstream said ${SENTINEL}`, 'text/plain');
    expect(error.message).toMatch(/上游后端暂时不可用（HTTP 503/);
    expect(error.message).toMatch(/未验证/);
    expect(error.message).not.toMatch(/重启|过载|不是本工具配置问题|与本工具无关/);
  });

  it('500 HTML 错误页含哨兵：不带出 HTML', async () => {
    await expectLeakFree(500, `<html><body>${SENTINEL}</body></html>`, 'text/html');
  });

  it('404 HTML 兜底页含哨兵：不带出页面内容', async () => {
    await expectLeakFree(404, `<html>${SENTINEL}</html>`, 'text/html');
  });

  it('400 的 JSON 里非 message 字段含哨兵：不带出该字段', async () => {
    await expectLeakFree(400, JSON.stringify({ error: SENTINEL, detail: SENTINEL }), 'application/json');
  });

  /**
   * 400 + JSON 里的 `message` 字段**也不进错误文本**（2026-10-30 止血后的口径）。
   *
   * 历史：这里曾有一条已知例外——上游 `message` 截 180 字符进错误文本，理由是
   * 「参数哪里不对只有对面知道」。该例外已按负责人决定去掉：上游可控文本进模型上下文
   * 就是注入面，对面可以往 `message` 里塞指令。上游原文仍在 `meta.bodySnippet`，只给程序看。
   *
   * 本用例现在钉两件事，都是**上界**：
   *   ① 上游 message 的**开头**（旧例外会带出来的那一段）不得出现在模型可见文本里；
   *   ② 正文**深处**的哨兵同样不得出现（除非有人把窗口扩成整段正文，否则不会红）。
   * 也就是说：例外被去掉它照样通过；谁把 `message` 或整段正文重新接回错误文本，它才会红。
   *
   * 有效性验证（隔离副本，未改共享工作区）：正常实现下整个文件 33/33 通过；
   * 把 `error.meta.bodySnippet` 故意拼进 `describeError()` 后，本组 5 例全部失败。
   */
  it('400 的 JSON message 也不进错误文本：开头与深处都不出现', async () => {
    const head = '参数错误：';
    const deepSentinel = '深处哨兵_DEEP_SENTINEL';
    // 位置为什么是这里：哨兵要落在 `bodySnippet` 的 300 字符窗口内（否则上一行断言
    // 会空转），同时落在**旧例外**取不到的深处（旧的只取前 180 字符）。
    // `{"message":"` 占 12 字符，故正文偏移 = 12 + 188 = 200，既 < 300 也 > 180。
    // 注意：旧例外的 180 字符窗口**今天已不存在**（已按负责人决定去掉），
    // 「200 > 180」只是历史位置说明；本用例现在钉的两件事都只是上界。
    const padding = 'x'.repeat(188);
    const error = await captureError(
      failingWith(400, JSON.stringify({ message: `${head}${padding}${deepSentinel}` }), 'application/json'),
    );
    expect(error.meta.bodySnippet).toContain(deepSentinel);
    const visible = describeError(error);
    expect(visible).not.toContain(deepSentinel);
    expect(visible, '上游 message 的开头（旧例外会带出的那段）也不得进模型可见文本').not.toContain(head);
    expect(visible).toMatch(/上游返回 HTTP 400/);
  });
});

/**
 * `rawBody`：给源层做**严格结构判定**用的未经处理原体（2026-10-30，ENSP-02）。
 *
 * 为什么必须与 `bodySnippet` 并存：`snippet()` 会把空白压平成一行，上游若在 JSON 字符串里
 * 塞了非法换行，压平后反而合法化，源层就会把畸形响应读成"查无"。只有未处理的原体才能
 * 严格 `JSON.parse`。
 *
 * 为什么必须有上限与截断标记：上游正文实测可达 1.9 MB（Ensembl Plants variation 50 kb 区间）。
 * 截断后**必须**置 `rawBodyTruncated`，源层见到它要放弃判定——不能只靠"截断后恰好解析失败"兜住。
 */
describe('上游响应原体（rawBody）', () => {
  const failingWith = (status: number, body: string, contentType = 'application/json') =>
    createFetcher({ timeoutMs: 500, retries: 0 }, (async () =>
      response(status, body, { 'content-type': contentType })) as typeof fetch);

  const captureError = async (fetchJson: ReturnType<typeof createFetcher>) => {
    try {
      await fetchJson('https://example.org/x');
    } catch (error) {
      return error as { message: string; meta: { bodySnippet?: string; rawBody?: string; rawBodyTruncated?: boolean } };
    }
    throw new Error('本用例要求上游失败，但 fetchJson 没有抛错');
  };

  it('小正文原样保留：不压平、不裁掉换行（snippet 会压平，rawBody 不会）', async () => {
    const raw = '{\n  "error": "No valid lookup found for symbol NO_SUCH_GENE_ZZZ\\n"\n}';
    const error = await captureError(failingWith(400, raw));
    // 逐字符相等 = 未经处理。若有人把这里改成 `snippet(body)`，本断言立刻红。
    expect(error.meta.rawBody).toBe(raw);
    expect(error.meta.rawBodyTruncated).toBeUndefined();
    // 对照：片段是压平过的，正是它会把畸形 JSON"洗"成合法。
    expect(error.meta.bodySnippet).not.toContain('\n');
  });

  it('超 4 KB 截断并显式标记，落下的部分不超字节上限', async () => {
    const raw = `{"error":"${'A'.repeat(6_000)}"}`;
    const error = await captureError(failingWith(400, raw));
    expect(error.meta.rawBodyTruncated).toBe(true);
    expect(utf8Bytes(error.meta.rawBody!)).toBeLessThanOrEqual(RAW_BODY_LIMIT_BYTES);
    expect(raw.startsWith(error.meta.rawBody!)).toBe(true);
  });

  it('截断按字符边界：不切出坏编码，也不多截', async () => {
    const raw = `{"error":"${'中'.repeat(2_000)}"}`; // 3 字节/字，远超 4 KB
    const error = await captureError(failingWith(400, raw));
    expect(error.meta.rawBodyTruncated).toBe(true);
    expect(error.meta.rawBody).not.toContain('\uFFFD');
    expect(raw.startsWith(error.meta.rawBody!)).toBe(true);
    // 边界效率：4291 → 4288 字节（4096 向下取到 3 的倍数 + 11 字节头部），不该退到 4000 以下。
    expect(utf8Bytes(error.meta.rawBody!)).toBeGreaterThan(RAW_BODY_LIMIT_BYTES - 4);
  });

  it('重试后仍失败：原体随最后一次尝试交给调用方', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(503, `{"try":${calls}}`);
    }) as typeof fetch;
    const error = await captureError(createFetcher({ timeoutMs: 500, retries: 1 }, fetchImpl));
    expect(calls).toBe(2);
    expect(error.meta.rawBody).toBe('{"try":2}');
  });
});

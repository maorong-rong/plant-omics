import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { validateProbe } from '../src/sources/strawberry/probe.js';

// Script is JS, intentionally not part of the TS compilation inputs.
// @ts-expect-error No declaration file for the standalone CLI script.
import { businessFailure, main, probe, runProbe } from '../scripts/probe.mjs';

// Real captured status; all negative mutations below are SYNTHETIC, not upstream observations.
const captured = JSON.parse(readFileSync(new URL('../src/sources/strawberry/fixtures/genes-status.json', import.meta.url), 'utf8'));
const normal = () => structuredClone(captured.payload);
const manifest = { id: 'strawberry', tier: 'T1', apiBase: 'https://example.invalid/api', probe: { path: '/genes/status' } };
const bundle = { manifest, validateProbe };
const registry = { listSources: () => [bundle] };
const response = (payload: unknown, status = 200) => async () => new Response(JSON.stringify(payload), { status });

/**
 * 子进程用例的显式预算（2026-10-28 加固）。
 *
 * 这两条用例起 node 子进程跑 `scripts/probe.mjs`。默认的 10s 全局 testTimeout 在机器被
 * 打包/安装/并发测试占满时可能不够，表现为随机变红而看不出原因。这里给它们单独的、
 * 不低于原默认值的预算：断言一条没放宽，只是把"要等多久"写明白。
 *
 * 子进程自身也设 timeout，这样真挂住时得到明确 error，而不是静默拖到用例超时。
 */
const CHILD_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 45_000;

describe('probe offline synthetic cases', () => {
  it('accepts captured normal status without fixing the observed example count in the validator', async () => {
    expect(captured.capture.status).toBe(200);
    expect(captured.capture.contentType).toContain('application/json');
    expect(normal().examples).toHaveLength(60);
    expect(() => validateProbe(normal())).not.toThrow();
    expect(() => validateProbe({ ...normal(), examples: normal().examples.slice(0, 1) })).not.toThrow();
    expect((await probe(bundle, { fetch: response(normal()) })).ok).toBe(true);
  });

  const invalid: [string, unknown][] = [
    ['disabled', { ...normal(), enabled: false }],
    ['unavailable', { ...normal(), available: false }],
    ['missing fields', {}], ['null', null], ['top array', []],
    ['wrong enabled type', { ...normal(), enabled: 'true' }],
    ['wrong available type', { ...normal(), available: 1 }],
    ['wrong examples type', { ...normal(), examples: {} }],
    ['missing examples', { enabled: true, available: true }],
    ['wrong row type', { ...normal(), examples: [null] }],
    ...['species', 'version', 'geneId'].flatMap((key): [string, unknown][] => [
      [`wrong ${key} type`, { ...normal(), examples: [{ ...normal().examples[0], [key]: 1 }] }],
      [`blank ${key}`, { ...normal(), examples: [{ ...normal().examples[0], [key]: '  ' }] }],
    ]),
  ];
  it.each(invalid)('rejects synthetic %s', async (_label, payload) => {
    expect(() => validateProbe(payload)).toThrow();
    const result = await probe(bundle, { fetch: response(payload) });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.note).toContain('源级断言失败');
  });

  it.each(['<html>synthetic fallback</html>', '{invalid'])('rejects synthetic JSON-format failure %s', async (body) => {
    const result = await probe(bundle, { fetch: async () => new Response(body) });
    expect(result.ok).toBe(false);
    expect(result.note).toContain('不是合法 JSON');
  });

  it('rejects synthetic HTTP429 before business validation', async () => {
    const validator = vi.fn();
    const fetch = vi.fn(async () => new Response(JSON.stringify(normal()), { status: 429, headers: { 'Retry-After': '1' } }));
    const result = await probe({ manifest, validateProbe: validator }, { fetch });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(validator).not.toHaveBeenCalled();
  });

  it('retains WheatOmics business envelope success and failure behavior', async () => {
    const wheat = { manifest: { ...manifest, id: 'wheatomics' } };
    for (const payload of [{ success: false }, { code: 500 }, { code: '429' }]) {
      expect(businessFailure(payload)).toBeTruthy();
      expect((await probe(wheat, { fetch: response(payload) })).ok).toBe(false);
    }
    for (const payload of [{ success: true, data: [] }, { code: 200 }, { code: '200' }, { code: '0' }]) {
      expect((await probe(wheat, { fetch: response(payload) })).ok).toBe(true);
    }
  });

  it('aggregates failures, writes through injected writer and returns CLI code 1', async () => {
    const writer = vi.fn();
    const stdout = vi.fn();
    expect(await main({ args: ['--json'], registry, fetch: response({}), writer, stdout, stderr: vi.fn() })).toBe(1);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.mock.calls[0]![0]).results[0].ok).toBe(false);
    expect((await runProbe({ registry, fetch: response(normal()) })).results[0].ok).toBe(true);
    expect(await main({ args: ['--source', 'missing'], registry, fetch: response(normal()), writer, stderr: vi.fn() })).toBe(2);
  });

  it('import is inert even when fetch and file writes are forbidden', () => {
    const url = pathToFileURL(resolve('scripts/probe.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      fs.writeFileSync = () => { throw Error('unexpected write'); };
      syncBuiltinESMExports();
      globalThis.fetch = () => { throw Error('unexpected network'); };
      await import(${JSON.stringify(url)});
    `], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }, TEST_TIMEOUT_MS);

  it.each(['disabled', 'unavailable', 'missing', 'format', '429'])('real isolated node CLI harness exits 1 for synthetic %s (no network/write)', (kind) => {
    const url = pathToFileURL(resolve('scripts/probe.mjs')).href;
    const payload = kind === 'disabled' ? { ...normal(), enabled: false }
      : kind === 'unavailable' ? { ...normal(), available: false } : {};
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { main } from ${JSON.stringify(url)};
      const validateProbe = ${validateProbe.toString()};
      const registry = { listSources: () => [{ manifest: ${JSON.stringify(manifest)}, validateProbe }] };
      const fetch = async () => new Response(${JSON.stringify(kind === 'format' ? '<html>synthetic</html>' : JSON.stringify(payload))},
        { status: ${kind === '429' ? 429 : 200}, headers: { 'Retry-After': '1' } });
      globalThis.fetch = () => { throw Error('real network forbidden'); };
      process.exitCode = await main({ args: [], registry, fetch, writer: () => {}, stdout: () => {}, stderr: (s) => process.stderr.write(s) });
    `], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('1/1 个源实测失败');
    expect(result.status).toBe(1);
  }, TEST_TIMEOUT_MS);
});

/**
 * probe 的重试与留痕（2026-10-30 加，同日按实测补）。
 *
 * 实测依据：① 连接层——本机直连 Ensembl Plants 出现过**连续 5 次 `UND_ERR_CONNECT_TIMEOUT`、
 * 第 6 次才成功**；② 5xx——同一端点一次返回 **500 HTML**，隔 3 秒复测即 200（偶发）。
 * 不带重试会把链路抖动或偶发 5xx 记成"源挂了/部分失败"；但只留最后结果又会掩盖"被重试拖长"。
 * 所以这里同时钉两件事：**重试策略** 与 **每次尝试都要留痕（trail）**。
 * 全部离线：`fetch` 与 `sleep` 都注入，不发真网络、不真等待。
 */
describe('probe 重试与尝试留痕', () => {
  const transportFailure = () => {
    const error = new TypeError('fetch failed');
    (error as { cause?: unknown }).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
    throw error;
  };
  const ok200 = () => new Response(JSON.stringify(normal()), { status: 200, headers: { 'content-type': 'application/json' } });
  const html500 = () => new Response('<html>error</html>', { status: 500, headers: { 'content-type': 'text/html' } });

  it('连续 5 次连接失败、第 6 次成功 → ok=true，逐次明细列出前 5 次失败与第 6 次 200', async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      if (calls < 6) transportFailure();
      return ok200();
    };
    const slept: number[] = [];
    const result = await probe(bundle, { fetch, sleep: async (ms: number) => { slept.push(ms); } });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(6);
    expect(calls).toBe(6);
    // 结论句只指出"第几次取得数据"，证据在逐次明细里
    expect(result.note).toContain('→ 取得数据（第 6 次尝试）');
    expect(result.note).toContain('attempt 1: CONNECT_TIMEOUT(UND_ERR_CONNECT_TIMEOUT)');
    expect(result.note).toContain('attempt 6: HTTP 200');
    // 指数退避且封顶 4 s：证明重试之间有等待，不是无脑连打（那会加重上游负担）。
    expect(slept).toEqual([500, 1_000, 2_000, 4_000, 4_000]);
    // 每次尝试都要有独立耗时——只有累计耗时就分不清哪一次卡住
    expect(result.trail).toHaveLength(6);
    expect(result.trail.every((t) => typeof t.ms === 'number')).toBe(true);
  });

  it('一次就 200 时不加噪声：正文不出现逐次明细', async () => {
    const result = await probe(bundle, { fetch: async () => ok200(), sleep: async () => {} });
    expect(result.attempts).toBe(1);
    expect(result.note).not.toContain('尝试明细');
    expect(result.trail).toEqual([expect.objectContaining({ n: 1, status: 200 })]);
  });

  it('偶发 5xx 会重试：先 500 HTML、第 2 次 200 → ok，两次都在明细里', async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return calls === 1 ? html500() : ok200();
    };
    const result = await probe(bundle, { fetch, sleep: async () => {} });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.trail).toEqual([
      expect.objectContaining({ n: 1, status: 500 }),
      expect.objectContaining({ n: 2, status: 200 }),
    ]);
    expect(result.note).toContain('attempt 1: HTTP 500');
    expect(result.note).toContain('attempt 2: HTTP 200');
    expect(result.note).toContain('→ 取得数据（第 2 次尝试）');
  });

  it('5xx 到上限仍失败 → 3 次尝试、明细列全三个状态码、结论写"未取得数据"', async () => {
    const fetch = vi.fn(async () => html500());
    const result = await probe(bundle, { fetch, sleep: async () => {} });

    expect(fetch).toHaveBeenCalledTimes(3); // 5xx 默认上限 3，低于连接层的 6
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.attempts).toBe(3);
    expect(result.trail.map((t) => t.status)).toEqual([500, 500, 500]);
    expect(result.note).toContain('attempt 3: HTTP 500');
    expect(result.note).toContain('本次未取得数据');
    // 回归钉：这一行曾经写成"第 3 次尝试才成功"，而那次实际拿到的是 500。
    expect(result.note).not.toContain('才成功');
  });

  /**
   * 真实观测的复刻（2026-10-30 Ensembl Plants）：**前 2 次本机连接层失败 + 第 3 次拿到 500 HTML**。
   * 两类失败叠在一条记录里，正是"第 N 次才成功"这种单句输出会骗人的地方——第 3 次并没有成功。
   */
  it('【真实形态】2 次连接失败 + 第 3 次 500 HTML → 明细逐条列出，结论是"未取得数据"', async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      if (calls <= 2) transportFailure();
      return html500();
    };
    // 5xx 额度设为 1：保留"2 次连接失败 + 第 3 次拿到 500 即止"这个当天真实形态。
    // （额度分开计之后，默认 3 次会让那个 500 再被试两次——那是另一种更完整的行为，
    //   由上面「连接失败不许吃掉 5xx 额度」那条用例单独钉。）
    const result = await probe(bundle, { fetch, statusAttempts: 1, sleep: async () => {} });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.note).toContain('attempt 1: CONNECT_TIMEOUT(UND_ERR_CONNECT_TIMEOUT)');
    expect(result.note).toContain('attempt 2: CONNECT_TIMEOUT');
    expect(result.note).toContain('attempt 3: HTTP 500');
    expect(result.note).toContain('text/html'); // 指明拿到的是 HTML 错误页，不是数据
    expect(result.note).toContain('本次未取得数据');
    expect(result.note).toContain('不作源可用性判断');
    expect(result.note).not.toContain('才成功');
  });

  it('混合轨迹：先"200 但读体失败"、再"连接失败" → 汇总不得说"均未连上"（须由轨迹归纳）', async () => {
    // 2026-10-30 审查复现：明细第一条是"已收到响应头、正文未读完"，汇总却写"两次均未连上"。
    // 现在汇总由 trace 归纳生成，不许另算。
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => { throw Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }); },
        };
      }
      return transportFailure();
    };
    const result = await probe(bundle, { fetch, attempts: 2, sleep: async () => {} });

    expect(result.ok).toBe(false);
    expect(result.trail.map((t: { kind?: string }) => t.kind)).toEqual(['body-read-fail', 'connect-fail']);
    // 汇总必须与明细一致
    expect(result.note).toContain('已收到响应头但正文未读完 1 次（状态码 200）');
    expect(result.note).toContain('连接未建立 1 次');
    expect(result.note).not.toContain('均未连上');
    expect(result.note).toContain('本次未取得数据');
  });

  it('全部尝试停在连接层 → 结论只到"连接层失败"，不写成源挂了，且保留 cause code', async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return transportFailure();
    };
    const result = await probe(bundle, { fetch, attempts: 3, sleep: async () => {} });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0); // 从没拿到状态码 → 不许编一个
    expect(result.attempts).toBe(3);
    expect(calls).toBe(3);
    expect(result.note).toContain('连接层失败');
    expect(result.note).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(result.note).toMatch(/attempt 3: CONNECT_TIMEOUT/);
    expect(result.note).not.toMatch(/源挂了|源不可用|上游宕机|不支持/);
    expect(result.trail.filter((t) => t.kind === 'connect-fail')).toHaveLength(3);
  });

  it('连接失败后成功时，cause code 不丢（后续成功也要能看到前几次为什么失败）', async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      if (calls === 1) transportFailure();
      return ok200();
    };
    const result = await probe(bundle, { fetch, sleep: async () => {} });
    expect(result.ok).toBe(true);
    expect(result.trail[0]).toEqual(expect.objectContaining(
      { n: 1, kind: 'connect-fail', cause: 'UND_ERR_CONNECT_TIMEOUT' },
    ));
    expect(result.note).toContain('attempt 1: CONNECT_TIMEOUT(UND_ERR_CONNECT_TIMEOUT)');
  });

  it('读正文失败 ≠ 没连上：状态码已拿到时，结论不许写成"连接层失败"', async () => {
    // 2026-10-30 审查复现：`response.text()` 抛错原来和 fetch 抛错共用同一个 catch，
    // 于是"连上了但正文没读完"被写成"均未连上"——替上游下了错结论。
    const brokenBody = () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => { throw Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }); },
    });
    const result = await probe(bundle, { fetch: async () => brokenBody(), attempts: 2, sleep: async () => {} });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(200); // 状态码拿到了，不许编成 0
    expect(result.note).toContain('读取响应正文失败');
    expect(result.note).toContain('已收到响应头 HTTP 200');
    expect(result.note).not.toContain('连接层失败');
    // 三分类：这条属"已收头未读完"，不许与"连接未建立"混
    expect(result.note).toContain('原因未确定（链路中断 / 本机取消 / 上游未给完 均未排除）');
    expect(result.note).not.toContain('没给完，');
    expect(result.trail.every((t: { kind?: string }) => t.kind === 'body-read-fail')).toBe(true);
    expect(result.note).toContain('正文未读完');
  });

  it('--attempts / --status-attempts 只收正整数：0 与小数一律 exit 2（不再静默夹成 1）', async () => {
    // 2026-10-30 审查复现：`--attempts 0` 与 `--attempts 1.5` 原来会被夹成 1 接受。
    const writer = vi.fn();
    const noopFetch = async () => new Response('{}');
    for (const args of [['--attempts', '0'], ['--attempts', '1.5'], ['--status-attempts', '0'], ['--status-attempts', '2.5']]) {
      const stderr = vi.fn();
      expect(await main({ args, registry, fetch: noopFetch, writer, stdout: vi.fn(), stderr }), args.join(' ')).toBe(2);
      expect(stderr.mock.calls[0]![0]).toMatch(/需要正整数/);
    }
    // 合法值照常接受
    const stderr = vi.fn();
    expect(await main({ args: ['--attempts', '2', '--status-attempts', '1'], registry, fetch: noopFetch, writer, stdout: vi.fn(), stderr })).toBe(1); // 该 fetch 返回 {} → 业务断言失败
  });

  it('连接失败不许吃掉 5xx 的额度：2 次超时后拿到 500，仍要再试一次并成功', async () => {
    // 2026-10-30 实测踩到：旧口径用总尝试次数当 5xx 额度，两次连接超时把 3 次额度吃光，
    // 那个偶发 500 一次都没被试第二次，整轮探活报失败。现在两份额度分开计。
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      if (calls <= 2) transportFailure();
      return calls === 3 ? html500() : ok200();
    };
    const result = await probe(bundle, { fetch, statusAttempts: 2, sleep: async () => {} });

    expect(calls).toBe(4); // 2 次连接失败 + 1 次 500 + 1 次 200
    expect(result.ok).toBe(true);
    expect(result.note).toContain('attempt 4: HTTP 200');
    expect(result.trail.map((t: { status?: number }) => t.status)).toEqual([undefined, undefined, 500, 200]);
  });

  it('429 与 4xx 一律只发一次（429 是上游要求降速，替它重试等于加重限流）', async () => {
    for (const status of [429, 404, 403]) {
      const fetch = vi.fn(async () => new Response('{}', { status, headers: { 'Retry-After': '1' } }));
      const slept: number[] = [];
      const result = await probe(bundle, { fetch, sleep: async (ms: number) => { slept.push(ms); } });

      expect(fetch, `HTTP ${status}`).toHaveBeenCalledTimes(1);
      expect(result.attempts).toBe(1);
      expect(result.status).toBe(status);
      expect(slept).toEqual([]);
    }
  });

  it('--attempts 1 / --status-attempts 1 可分别关掉重试；非法值返回 2', async () => {
    const failing = vi.fn(async () => { return transportFailure(); });
    expect((await probe(bundle, { fetch: failing, attempts: 1, sleep: async () => {} })).attempts).toBe(1);
    expect(failing).toHaveBeenCalledTimes(1);

    const five = vi.fn(async () => html500());
    const one = await probe(bundle, { fetch: five, statusAttempts: 1, sleep: async () => {} });
    expect(five).toHaveBeenCalledTimes(1);
    expect(one.attempts).toBe(1);

    const writer = vi.fn();
    const stderr = vi.fn();
    const noop = async () => new Response('{}');
    expect(await main({ args: ['--attempts', 'x'], registry, fetch: noop, writer, stdout: vi.fn(), stderr })).toBe(2);
    expect(stderr.mock.calls[0]![0]).toContain('--attempts 需要正整数');
    expect(await main({ args: ['--attempts'], registry, fetch: noop, writer, stdout: vi.fn(), stderr })).toBe(2);
    expect(await main({ args: ['--status-attempts', '0x'], registry, fetch: noop, writer, stdout: vi.fn(), stderr })).toBe(2);
    expect(stderr.mock.calls[2]![0]).toContain('--status-attempts 需要正整数');
  });
});

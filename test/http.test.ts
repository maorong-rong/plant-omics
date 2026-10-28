import { describe, expect, it } from 'vitest';

import { createFetcher, retryDelayMs } from '../src/core/http.js';

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

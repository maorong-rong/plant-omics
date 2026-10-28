import { describe, expect, it, vi } from 'vitest';
import { InvalidArgumentError, UpstreamError, UpstreamShapeError, describeError } from '../src/core/errors.js';
import { provenance, utf8Bytes } from '../src/core/format.js';
import { fetchPrepared, finishResult, MAX_REQUEST_BYTES, prepareRequest, withRequestEvidence } from '../src/core/request.js';
import type { Fetcher } from '../src/core/types.js';

const url = 'https://example.org/a?q=x';
const prepared = () => prepareRequest({ url, sourceName: '源', presentation: { top: 8 } });
const response = () => ({ data: {}, url, status: 200, durationMs: 3, attempts: 1 });

describe('完整请求预算', () => {
  it('300字符以上的请求在provenance中保持原样', () => {
    const request = `GET https://example.org/?q=${'a'.repeat(700)}`;
    expect(provenance({ sourceName: 'S', request, status: 200, durationMs: 0 })).toContain(request);
  });
  it('按最终URL编码字节预检，不按原始中文字符数', () => {
    const u = new URL(url); u.searchParams.set('q', '中'.repeat(200));
    expect(() => prepareRequest({ url: u.href, sourceName: 'S' })).toThrow(InvalidArgumentError);
  });
  it('精确边界可过，多1字节失败', () => {
    const prefix = 'GET https://example.org/?q=';
    const u = `https://example.org/?q=${'a'.repeat(MAX_REQUEST_BYTES - utf8Bytes(prefix))}`;
    expect(utf8Bytes(prepareRequest({ url: u, sourceName: 'S' }).request)).toBe(MAX_REQUEST_BYTES);
    expect(() => prepareRequest({ url: u + 'a', sourceName: 'S' })).toThrow(/尚未联网/);
  });
  it('本地呈现参数也完整计预算，不静默丢掉', () => {
    const p = prepareRequest({ url, sourceName: 'S', presentation: { keyword: '中文', top: 30 } });
    expect(p.request).toContain('"keyword":"中文"');
    expect(p.request).toContain('"top":30');
    expect(Object.isFrozen(p)).toBe(true);
    expect(() => prepareRequest({ url, sourceName: 'S', presentation: { q: '文'.repeat(600) } })).toThrow();
  });
  it('拒绝URL凭据及fragment，不能把秘密或未发送片段写入证据', () => {
    expect(() => prepareRequest({ url: 'https://u:p@example.org/', sourceName: 'S' })).toThrow();
    expect(() => prepareRequest({ url: url + '#x', sourceName: 'S' })).toThrow();
  });
  it('完整错误证据可见，不把HTML响应正文带进模型', async () => {
    const http = vi.fn(async () => { throw new UpstreamError('HTML兜底', { url, status: 404,
      contentType: 'text/html', bodySnippet: '<html>private</html>' }); });
    const p = prepared();
    try { await fetchPrepared({ http: http as Fetcher }, p); throw new Error('should fail'); }
    catch (e) {
      const shown = describeError(e);
      expect(shown).toContain(p.request); expect(shown).toContain('text/html');
      expect(shown).not.toContain('<html>');
    }
  });
  it('正文可截，完整尾注与本地参数不可截，总字节<=4096', () => {
    const p = prepared();
    const out = finishResult({ body: '中'.repeat(5000), res: response(), prepared: p, sourceId: 's', extra: '版本未知' });
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
    expect(out.text).toContain(p.request); expect(out.meta.request).toBe(p.request);
    expect(out.text).toContain('已按 4 KB 上限截断');
  });
  it('异常版本元数据明确失败，不删版本或请求凑预算', () => {
    expect(() => finishResult({ body: 'ok', res: response(), prepared: prepared(), sourceId: 's',
      extra: '文'.repeat(1000) })).toThrow(/出处超过/);
  });
  it('响应URL与预检不一致明确失败', () => {
    expect(() => finishResult({ body: 'x', res: { ...response(), url: url + 'y' },
      prepared: prepared(), sourceId: 's' })).toThrow(/不一致/);
  });
});

describe('取数后结构错误证据', () => {
  it('完整边界保留同一错误实例和UpstreamShapeError类型', async () => {
    const p = prepared();
    const failure = new UpstreamShapeError('模拟字段漂移', { url });
    const http = (async () => response()) as Fetcher;
    await expect(withRequestEvidence({ http }, async scoped => {
      await fetchPrepared(scoped, p); throw failure;
    })).rejects.toBe(failure);
    expect(failure).toBeInstanceOf(UpstreamShapeError);
    expect(failure.meta.request).toBe(p.request);
    expect(describeError(failure)).toContain('"top":8');
  });
  it('并发复用调用方ctx时两份呈现参数不串用', async () => {
    const ctx = { http: (async () => response()) as Fetcher };
    const run = (top: number) => withRequestEvidence(ctx, async scoped => {
      const p = prepareRequest({ url, sourceName: 'S', presentation: { top } });
      await fetchPrepared(scoped, p);
      await Promise.resolve();
      throw new UpstreamShapeError('模拟并发漂移', { url });
    });
    const outcomes = await Promise.allSettled([run(3), run(19)]);
    outcomes.forEach((outcome, i) => {
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.reason.meta.request).toContain(`"top":${i === 0 ? 3 : 19}`);
      }
    });
  });
  it('未取数的参数错误不附旧证据，异URL错误不错误归因', async () => {
    const ctx = { http: (async () => response()) as Fetcher };
    const unrelated = new UpstreamShapeError('其他URL', { url: url + 'other' });
    await expect(withRequestEvidence(ctx, async scoped => {
      await fetchPrepared(scoped, prepared()); throw unrelated;
    })).rejects.toBe(unrelated);
    expect(unrelated.meta.request).toBeUndefined();
    const noRequest = new UpstreamShapeError('无请求', { url });
    await expect(withRequestEvidence(ctx, async () => { throw noRequest; })).rejects.toBe(noRequest);
    expect(noRequest.meta.request).toBeUndefined();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import type { Fetcher } from '../src/core/types.js';
import { lookupGene } from '../src/sources/ensemblplants/tools.js';

/**
 * `rawBody` 落地前的**预演**：用注入的 Fetcher 直接构造带 `meta.rawBody` 的 UpstreamError，
 * 模拟"公共层已按负责人规格实现"后的行为。
 *
 * 目的：证明源层**不需要再改一行**就能满足 ENSP-02。等 core 真正落地后，
 * 把这里的注入桩换成 `createFetcher` + `Response` 即为真实链路回放。
 */

const sp = 'arabidopsis_thaliana';
const read = (name: string) => JSON.parse(readFileSync(new URL(`../src/sources/ensemblplants/fixtures/${name}`, import.meta.url), 'utf8'));
const neg = read('lookup-symbol-neg.json');

const MAX_RAW_BODY = 4096;

/** 模拟 http.ts 按规格填充 meta：rawBody + 截断标记。 */
function errorWithRawBody(url: string, status: number, body: string, contentType = 'application/json') {
  const truncated = body.length > MAX_RAW_BODY;
  return new UpstreamError('上游失败', {
    url, status, contentType,
    bodySnippet: body.slice(0, 300),
    ...(truncated ? { rawBody: body.slice(0, MAX_RAW_BODY), rawBodyTruncated: true } : { rawBody: body }),
  } as never);
}

function ctxThrowing(error: UpstreamError) {
  return { http: (async (url: string) => { throw errorWithRawBody(url, 400, (error.meta as never as { rawBody?: string }).rawBody ?? ''); }) as Fetcher };
}

describe('rawBody 落地预演（模拟公共层已实现）', () => {
  it('合法查无 + 完整原体 → 返回"未找到"，保留 400 出处', async () => {
    const body = JSON.stringify(neg.payload);
    const http = (async (url: string) => { throw errorWithRawBody(url, 400, body); }) as Fetcher;
    const out = await lookupGene.run({ species: sp, symbol: 'NO_SUCH_GENE_ZZZ' }, { http });
    expect(out.raw).toMatchObject({ found: false });
    expect(out.text).toContain('上游明确未找到');
    expect(out.meta.status).toBe(400);
    // 出处完整
    expect(out.meta.request).toContain('lookup/symbol/arabidopsis_thaliana/NO_SUCH_GENE_ZZZ');
  });

  it('畸形原体（字符串内非法换行）→ 保持抛错，不判查无', async () => {
    const body = '{"error":"No valid lookup found for symbol NO_SUCH_GENE_ZZZ\n"}';
    const http = (async (url: string) => { throw errorWithRawBody(url, 400, body); }) as Fetcher;
    await expect(lookupGene.run({ species: sp, symbol: 'NO_SUCH_GENE_ZZZ' }, { http }))
      .rejects.toBeInstanceOf(UpstreamError);
  });

  it('原体超 4 KB 被截断（rawBodyTruncated）→ 降级抛错，不判查无', async () => {
    const base = JSON.stringify(neg.payload);
    const huge = base.replace('}', `,"pad":"${'A'.repeat(5000)}"}`);
    expect(huge.length).toBeGreaterThan(MAX_RAW_BODY);
    const http = (async (url: string) => { throw errorWithRawBody(url, 400, huge); }) as Fetcher;
    await expect(lookupGene.run({ species: sp, symbol: 'NO_SUCH_GENE_ZZZ' }, { http }))
      .rejects.toBeInstanceOf(UpstreamError);
  });

  it('【显式降级】rawBodyTruncated=true 时，即使原体本身可解析也不得判查无', async () => {
    // 构造一个"截断标记为真、但文本恰好是完整合法 JSON"的情形：
    // 只靠 JSON.parse 会通过，只有显式检查 rawBodyTruncated 才能拦住。
    const body = JSON.stringify(neg.payload);
    const http = (async (url: string) => {
      throw new UpstreamError('上游失败', { url, status: 400, contentType: 'application/json',
        bodySnippet: body.slice(0, 300), rawBody: body, rawBodyTruncated: true } as never);
    }) as Fetcher;
    await expect(lookupGene.run({ species: sp, symbol: 'NO_SUCH_GENE_ZZZ' }, { http }))
      .rejects.toBeInstanceOf(UpstreamError);
  });

  it('玉米旧编号查无 + 完整原体 → 返回代次提示（ENSP-06 生效）', async () => {
    const body = JSON.stringify({ error: "ID 'Zm00001d027624' not found" });
    const http = (async (url: string) => { throw errorWithRawBody(url, 400, body); }) as Fetcher;
    const out = await lookupGene.run({ species: 'zea_mays', id: 'Zm00001d027624' }, { http });
    expect(out.text).toContain('Zm-B73-REFERENCE-NAM-5.0');
    expect(out.text).toContain('Zm00001eb');
    expect((out.raw as never as { stale_id_hint?: string }).stale_id_hint).toBeTruthy();
    expect(utf8Bytes(out.text)).toBeLessThanOrEqual(4096);
  });
});

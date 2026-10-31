import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../src/core/errors.js';
import { createFetcher } from '../src/core/http.js';
import type { Fetcher } from '../src/core/types.js';
import { lookupGene } from '../src/sources/ensemblplants/tools.js';

/**
 * `rawBody` 落地后的**真实链路三条回放**（负责人 2026-10-30 指定）。
 *
 * 与 `ensemblplants-rawbody-readiness.test.ts` 的区别：这里走**真实公共 HTTP 链**
 * （`createFetcher` + `Response` 桩），不使用任何测试内补丁——
 * `rawBody` / `rawBodyTruncated` 由 `src/core/http.ts` 真正填写。
 *
 * 这是"删桩重跑"后的版本：core 落地前这里曾用补桩模拟，现已移除。
 */

const sp = 'arabidopsis_thaliana';

/** 真实公共链路，不做任何补丁。 */
function realChain(status: number, body: string, contentType = 'application/json'): Fetcher {
  return createFetcher({ retries: 0 }, async () => new Response(body, {
    status, headers: { 'content-type': contentType },
  })) as Fetcher;
}

describe('rawBody 落地后的真实链路回放（三条 + 两条边界）', () => {
  it('① 畸形原体（字符串内非法换行）→ 抛错，绝不判查无', async () => {
    const http = realChain(400, '{"error":"No valid lookup found for symbol NO_SUCH_GENE_ZZZ\n"}');
    await expect(lookupGene.run({ species: sp, symbol: 'NO_SUCH_GENE_ZZZ' }, { http }))
      .rejects.toBeInstanceOf(UpstreamError);
  });

  it('② 合法查无 + 完整原体 → 返回"未找到"，保留 400 出处与完整请求', async () => {
    const body = JSON.stringify({ error: 'No valid lookup found for symbol NO_SUCH_GENE_ZZZ' });
    const out = await lookupGene.run({ species: sp, symbol: 'NO_SUCH_GENE_ZZZ' }, { http: realChain(400, body) });
    expect(out.raw).toMatchObject({ found: false });
    expect(out.text).toContain('上游明确未找到');
    expect(out.text).toContain('不代表该基因在其他库');
    expect(out.meta.status).toBe(400);
    expect(out.meta.request).toContain('lookup/symbol/arabidopsis_thaliana/NO_SUCH_GENE_ZZZ');
  });

  it('③ 玉米旧编号 → 给出 NAM-5.0 与 Zm00001eb 代次提示', async () => {
    const body = JSON.stringify({ error: "ID 'Zm00001d027624' not found" });
    const out = await lookupGene.run({ species: 'zea_mays', id: 'Zm00001d027624' },
      { http: realChain(400, body) });
    expect(out.text).toContain('Zm-B73-REFERENCE-NAM-5.0');
    expect(out.text).toContain('Zm00001eb');
    expect(out.text).toContain('已实测旧编号');
    expect((out.raw as never as { stale_id_hint?: string }).stale_id_hint).toBeTruthy();
  });

  it('④ 超 4 KB 被截断（core 置 rawBodyTruncated）→ 抛错，不判查无', async () => {
    const body = JSON.stringify({ error: 'No valid lookup found for symbol NO_SUCH_GENE_ZZZ', pad: 'A'.repeat(5000) });
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(4096);
    await expect(lookupGene.run({ species: sp, symbol: 'NO_SUCH_GENE_ZZZ' }, { http: realChain(400, body) }))
      .rejects.toBeInstanceOf(UpstreamError);
  });

  it('⑤ 503 HTML → 报"本次失败"，不判查无、不写"源不可用"', async () => {
    const http = realChain(503, '<html><body><h1>503 Service Unavailable</h1></body></html>', 'text/html');
    await expect(lookupGene.run({ species: sp, symbol: 'FT' }, { http })).rejects.toBeInstanceOf(UpstreamError);
  });
});

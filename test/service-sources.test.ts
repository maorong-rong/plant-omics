import { readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { parseServiceConfig } from '../src/service/config.js';
import { createService, type RunningService } from '../src/service/http.js';
import { registry } from '../src/sources/index.js';

/**
 * 六源业务回放，**穿过 HTTP MCP 链路**（服务端 → Streamable HTTP → 客户端）。
 *
 * 为什么必须有这一层：薄插件之后，工具不再由插件执行，唯一路径是
 * 服务端 `tools/call`。只测 `invokeTool` 直调证明不了传输、鉴权与生命周期没问题。
 *
 * 全部离线：把 `globalThis.fetch` 换成 fixture 路由，产品 HTTP 层照常解析。
 */

const running: RunningService[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const service of running.splice(0)) await service.close().catch(() => {});
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;

/** fixture 的 URL 前缀 → payload；同时把发往本机服务的请求原样透传。 */
function fixtureRouter(routes: Array<{ match: string; file: string }>) {
  const payloads = routes.map((route) => ({
    match: route.match,
    body: JSON.parse(readFileSync(new URL(`../src/sources/${route.file}`, import.meta.url), 'utf8')),
  }));
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const text = String(input);
    // 客户端自己也要用 fetch 连本服务，必须放行，否则测的就不是链路了
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(text)) return originalFetch(input, init);
    const hit = payloads.find((entry) => text.includes(entry.match));
    if (!hit) return new Response('unrouted', { status: 599, headers: { 'content-type': 'text/plain' } });
    const raw = hit.body as { capture?: { payload?: unknown; contentType?: string }; data?: unknown; payload?: unknown; success?: unknown };
    // 两种快照形态：{capture,payload}（多数源）与带业务信封的整包（wheatomics）
    const body = raw.capture?.payload ?? (raw.success !== undefined ? raw : raw.payload ?? raw.data ?? raw);
    const contentType = raw.capture?.contentType ?? 'application/json';
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': contentType } });
  };
}

async function startService() {
  const config = parseServiceConfig({ PLANTOMICS_HUB_HOST: '127.0.0.1', PLANTOMICS_HUB_PORT: '0' } as NodeJS.ProcessEnv);
  const instance = await createService({ registry, config }).start();
  running.push(instance);
  const client = new Client({ name: 'six-source-replay', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(instance.url)));
  return client;
}

describe('六源业务回放（HTTP MCP，全离线）', () => {
  it('wheatomics：已知基因检索，保留均值/标准差写法', async () => {
    globalThis.fetch = fixtureRouter([{ match: 'searchid=VRN1', file: 'wheatomics/fixtures/known-search.json' }]);
    const client = await startService();
    const result = await client.callTool({ name: 'wheatomics_search_known_genes', arguments: { searchid: 'VRN1', limit: 5 } });
    expect(result.isError).toBeFalsy();
    const text = String((result.content?.[0] as { text?: string })?.text ?? '');
    expect(text).toContain('VRN1');
    expect(text).toContain('GET https://');
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(4096);
  });

  it('strawberry：目录查询，出处保留完整请求', async () => {
    globalThis.fetch = fixtureRouter([{ match: '/strawberry/api/v1/catalog', file: 'strawberry/fixtures/catalog.json' }]);
    const client = await startService();
    const result = await client.callTool({ name: 'strawberry_catalog', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = String((result.content?.[0] as { text?: string })?.text ?? '');
    expect(text).toContain('/strawberry/api/v1/catalog');
  });

  it('gwh：基因组精确查询，隐私投影不出现联系人键', async () => {
    globalThis.fetch = fixtureRouter([{ match: '/gwh/api/public/genome/1', file: 'gwh/fixtures/genome.json' }]);
    const client = await startService();
    const result = await client.callTool({ name: 'gwh_assembly_lookup', arguments: { entity: 'genome', id: '1' } });
    expect(result.isError).toBeFalsy();
    const text = String((result.content?.[0] as { text?: string })?.text ?? '');
    expect(text).toContain('/gwh/api/public/genome/1');
    expect(text).not.toMatch(/contactEmail|contactName/);
  });

  it('icg：物种查询，不提供通用推荐', async () => {
    globalThis.fetch = fixtureRouter([{ match: '/icg/api/json/species/ICG00115', file: 'icg/fixtures/species.json' }]);
    const client = await startService();
    const result = await client.callTool({ name: 'icg_lookup', arguments: { entity: 'species', id: 'ICG00115' } });
    expect(result.isError).toBeFalsy();
    const text = String((result.content?.[0] as { text?: string })?.text ?? '');
    expect(text).toContain('/icg/api/json/species/ICG00115');
  });

  it('ic4r：基因查询，出处为绝对 URL', async () => {
    globalThis.fetch = fixtureRouter([{ match: '/ic4r/api/json/gene/IC4R-OSJ01G000600', file: 'ic4r/fixtures/gene.json' }]);
    const client = await startService();
    const result = await client.callTool({ name: 'ic4r_gene', arguments: { locus: 'IC4R-OSJ01G000600' } });
    expect(result.isError).toBeFalsy();
    const text = String((result.content?.[0] as { text?: string })?.text ?? '');
    expect(text).toContain('IC4R-OSJ01G000600');
  });

  it('gramene：search 的 text/plain 正文经 HTTP 链路解析', async () => {
    globalThis.fetch = fixtureRouter([{ match: 'data.gramene.org/v69/search', file: 'gramene/fixtures/search.json' }]);
    const client = await startService();
    const result = await client.callTool({ name: 'gramene_search', arguments: { q: 'Oryza', rows: 2 } });
    expect(result.isError).toBeFalsy();
    const text = String((result.content?.[0] as { text?: string })?.text ?? '');
    expect(text).toContain('本次返回');
    expect(text).toContain('q=Oryza');
  });

  it('上游错误经 HTTP 链路仍为 isError 且带完整请求', async () => {
    // 本机服务的请求要放行，只有上游返回 503
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(String(input))) return originalFetch(input, init);
      return new Response('boom', { status: 503, headers: { 'content-type': 'text/plain' } });
    };
    const client = await startService();
    const result = await client.callTool({ name: 'ic4r_gene', arguments: { locus: 'IC4R-OSJ01G000600' } });
    expect(result.isError).toBe(true);
    const text = String((result.content?.[0] as { text?: string })?.text ?? '');
    expect(text).toContain('GET https://');
  });
});

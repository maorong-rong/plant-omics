import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

import { describe, expect, it, afterEach } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createService, type RunningService } from '../src/service/http.js';
import { registry } from '../src/sources/index.js';
import { parseServiceConfig } from '../src/service/config.js';
import { DEFAULT_SET_TOOLS_SOFT_MAX, SUBSET_TOOLS_HARD_MAX } from '../src/service/budget.js';

/**
 * `GET /catalog` 验收（契约 `docs/catalog契约.md` §六 八条，2026-11-01）。
 *
 * 重点不是"字段齐"，而是三条一致性：**集合逐一相等**（不是数量相等）、
 * **三处数字同源**（/catalog、/healthz、注册表）、**阈值只有一个来源**（不在 catalog 里写死 80/40）。
 * 第 4 条负控（改常量后 /catalog 必须跟着变）在 catalog-unit 里用注入实现，见文件末尾说明。
 */

const running: RunningService[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function start() {
  const config = parseServiceConfig({ PLANTOMICS_HUB_HOST: '127.0.0.1', PLANTOMICS_HUB_PORT: '0' } as NodeJS.ProcessEnv);
  const instance = await createService({ registry, config }).start();
  running.push(instance);
  return instance;
}

async function getCatalog(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(new URL('/catalog', url).toString(), { headers });
  const text = await response.text();
  return { response, text, json: response.ok ? JSON.parse(text) : undefined };
}

describe('GET /catalog：字段与类型', () => {
  it('#1 200、字段类型齐全；#7 Date 与 generatedAt 相差 < 2 s', async () => {
    const instance = await start();
    const { response, json } = await getCatalog(instance.url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);

    expect(typeof json.version).toBe('string');
    expect(json.version.length).toBeGreaterThan(0);
    expect(Number.isNaN(new Date(json.generatedAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(String(response.headers.get('date'))).getTime())).toBe(false);
    const drift = Math.abs(new Date(json.generatedAt).getTime() - new Date(String(response.headers.get('date'))).getTime());
    expect(drift, `generatedAt 与 Date 相差 ${drift} ms`).toBeLessThan(2000);

    expect(json.totals).toMatchObject({
      sources: expect.any(Number), tools: expect.any(Number), metaTools: expect.any(Number),
    });
    expect(json.budget.defaultSetSoftMax).toBe(DEFAULT_SET_TOOLS_SOFT_MAX);
    expect(json.budget.subsetToolsHardMax).toBe(SUBSET_TOOLS_HARD_MAX);
    expect(json.budget.defaultSetOverSoftMax).toBe(json.budget.defaultSetTools > json.budget.defaultSetSoftMax);
    expect(json.budget.subsetToolsHardMaxTokens).toBe(SUBSET_TOOLS_HARD_MAX * json.budget.estTokensPerTool);

    for (const source of json.sources) {
      expect(typeof source.id).toBe('string');
      expect(typeof source.name).toBe('string');
      expect(typeof source.tier).toBe('string');
      expect(source.toolCount).toBe(source.tools.length);
      expect(source.coverage.length).toBeGreaterThan(0);
      expect(source.coverage).not.toContain('支持全部物种');
      expect(typeof source.homepage).toBe('string');
    }
  });
});

describe('GET /catalog：三条一致性铁律', () => {
  it('#2 union(sources[].tools) + metaTools 与 tools/list 集合逐一相等（不是数量相等）', async () => {
    const instance = await start();
    const { json } = await getCatalog(instance.url);

    // 走真实 MCP 链路拿 tools/list，而不是拿注册表自比（自比会掩盖漏注册）
    const client = new Client({ name: 'catalog-check', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(instance.url)));
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    await client.close();

    const fromSources: string[] = json.sources.flatMap((s: { tools: string[] }) => s.tools);
    const toolSet = new Set(listed);
    for (const name of fromSources) expect(toolSet.has(name), `sources[] 里的 ${name} 不在 tools/list`).toBe(true);

    // 元工具 = 全集减去源工具名；逐个比对集合，不是比数量
    const sourceToolSet = new Set(fromSources);
    const metaFromList = listed.filter((name) => !sourceToolSet.has(name));
    expect(metaFromList.length, '元工具数必须等于 totals.metaTools').toBe(json.totals.metaTools);
    expect(new Set([...fromSources, ...metaFromList])).toEqual(toolSet);
    // 元工具不得混进任何 sources[]（把 hub_* 塞进某个源数组凑数 = 断言失败）
    for (const name of listed.filter((n) => n.startsWith('hub_'))) {
      expect(sourceToolSet.has(name), `${name} 是元工具，不该出现在 sources[].tools`).toBe(false);
    }
    // sources[] 里也不许出现不存在的工具名（多了=重复），两边逐一相等才算铁律
    expect(fromSources.length + metaFromList.length).toBe(listed.length);
  });

  it('#3 /catalog 的 totals 与 /healthz 同源', async () => {
    const instance = await start();
    const { json } = await getCatalog(instance.url);
    const health = await (await fetch(new URL('/healthz', instance.url).toString())).json();

    expect(json.totals.sources).toBe(health.sources);
    expect(json.totals.tools).toBe(health.tools);
    expect(json.totals.metaTools).toBe(health.metaTools);
    expect(json.version).toBe(health.version);
  });

  it('#4 阈值只有一个来源：catalog 里不出现字面量 80 / 40', async () => {
    // 负控（把 SUBSET_TOOLS_HARD_MAX 改成 81 看 /catalog 是否跟着报 81）由
    // test/catalog-unit.test.ts 用注入常量完成——那边能改值，这里只能查源码没有第二处字面量。
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/service/catalog.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\b80\b/);
    expect(code).not.toMatch(/\b40\b/);
    expect(code).toContain('SUBSET_TOOLS_HARD_MAX');
    expect(code).toContain('DEFAULT_SET_TOOLS_SOFT_MAX');
  });
});

describe('GET /catalog：边界与禁止项', () => {
  it('#5 响应不含 token / 环境变量值', async () => {
    const instance = await start();
    const { text } = await getCatalog(instance.url);
    // 注意 estTokensPerTool 是"token 数"的字段名，不是凭据——不能一刀切禁 "token" 字样。
    expect(text.toLowerCase()).not.toContain('bearer');
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(text).not.toContain('PLANTOMICS_HUB_TOKEN');
    expect(text).not.toMatch(/PLANTOMICS_[A-Z_]+/);
    // 结构层：不许出现凭据类字段
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) { keys.push(k); walk(val); }
      }
    };
    walk(JSON.parse(text));
    for (const key of keys) expect(/token|secret|password|authorization/i.test(key) && !/tokens/i.test(key)).toBe(false);
  });

  it('#6 POST /catalog → 405 且带 allow: GET, HEAD', async () => {
    const instance = await start();
    const response = await fetch(new URL('/catalog', instance.url).toString(), { method: 'POST', body: '{}' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  /**
   * RFC 9110 §9.3.2：HEAD 与 GET 同语义，只是响应不带内容。
   * 用原始 http 请求而不是 fetch：fetch 对 HEAD 会按规范丢弃 body，
   * 即服务端真的写了 body 也看不出来；原始响应才能证明线上没有 body 字节。
   */
  it('#6b HEAD /catalog → 200、无 body，响应头与 GET 一致', async () => {
    const instance = await start();
    const probe = (method: 'GET' | 'HEAD') => new Promise<{
      status: number; headers: IncomingHttpHeaders; body: string;
    }>((resolve) => {
      const target = new URL(instance.url);
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: '/catalog',
        method,
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      });
      request.on('error', () => resolve({ status: -1, headers: {}, body: '' }));
      request.end();
    });

    const get = await probe('GET');
    const head = await probe('HEAD');
    expect(get.status).toBe(200);
    expect(head.status).toBe(200);
    expect(head.body, 'HEAD 响应必须没有 body 字节').toBe('');
    for (const name of ['content-type', 'cache-control', 'etag']) {
      expect(head.headers[name], `${name} 必须与 GET 一致`).toBe(get.headers[name]);
    }
  });

  it('#8 带不带 x-plantomics-sources，输出完全相同（本端点不看订阅头）', async () => {
    const instance = await start();
    const plain = await getCatalog(instance.url);
    const withHeader = await getCatalog(instance.url, { 'x-plantomics-sources': 'icg,scod' });
    expect(withHeader.response.status).toBe(200);
    // generatedAt 每次都会变，比较时剔除；其余必须逐字节相同
    const body = (text: string) => text.replace(/"generatedAt":"[^"]+"/, '"generatedAt":"<t>"');
    expect(body(withHeader.text)).toBe(body(plain.text));
  });
});

/**
 * ETag 与 304（契约 §二：`ETag: "<内容哈希>"`）。
 *
 * 2026-11-03 检索负责人实测的 M2：ETag 每次都变、304 从未发生。根因是 `generatedAt`
 * 是"本次响应的时刻"，被算进了哈希。下面几条把"内容哈希"钉住：同内容同 ETag、命中返 304 空体、
 * 不命中的 If-None-Match 不许被误判成 304。
 *
 * 2026-11-04：`If-None-Match` 以前只做逐字比较，`W/"…"` 与 `*` 都拿不到 304。按 RFC 9110 §13.1.2
 * 改为弱比较并认 `*`，三条命中用例（强校验器 / 弱校验器 / `*`）分别钉住这三种写法。
 */
describe('GET /catalog：ETag 是内容哈希，能命中 304', () => {
  it('同一注册表状态下两次请求 ETag 相同', async () => {
    const instance = await start();
    const first = await getCatalog(instance.url);
    const second = await getCatalog(instance.url);
    expect(first.response.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(second.response.headers.get('etag'), '内容没变，ETag 就必须一样，否则 304 永远不会发生')
      .toBe(first.response.headers.get('etag'));
  });

  it('强校验器命中 → 304 且空体，缓存头仍在', async () => {
    const instance = await start();
    const first = await getCatalog(instance.url);
    const etag = first.response.headers.get('etag') ?? '';
    const hit = await fetch(new URL('/catalog', instance.url).toString(), { headers: { 'if-none-match': etag } });
    expect(hit.status).toBe(304);
    expect(await hit.text(), '304 不许带响应体').toBe('');
    // 缓存端要靠这两个头续期 / 复核，304 也必须有
    expect(hit.headers.get('etag')).toBe(etag);
    expect(hit.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('弱校验器 W/"…" 命中 → 304（代理把强 ETag 降级后仍要能命中）', async () => {
    const instance = await start();
    const first = await getCatalog(instance.url);
    const etag = first.response.headers.get('etag') ?? '';
    // 列表形态一起钉住：任一校验器命中即 304，且 W/ 前缀不参与比较
    for (const value of [`W/${etag}`, `"deadbeefdeadbeefdeadbeefdeadbeef", W/${etag}`]) {
      const hit = await fetch(new URL('/catalog', instance.url).toString(), { headers: { 'if-none-match': value } });
      expect(hit.status, `If-None-Match: ${value} 应命中 304`).toBe(304);
      expect(await hit.text(), '304 不许带响应体').toBe('');
      expect(hit.headers.get('etag')).toBe(etag);
      expect(hit.headers.get('cache-control')).toBe('public, max-age=60');
    }
  });

  it('`*` 命中 → 304（资源存在即命中，不再看校验器）', async () => {
    const instance = await start();
    const first = await getCatalog(instance.url);
    const etag = first.response.headers.get('etag') ?? '';
    const hit = await fetch(new URL('/catalog', instance.url).toString(), { headers: { 'if-none-match': '*' } });
    expect(hit.status).toBe(304);
    expect(await hit.text(), '304 不许带响应体').toBe('');
    expect(hit.headers.get('etag')).toBe(etag);
    expect(hit.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('负控：不匹配的 If-None-Match 必须回 200 带体，不许误判成 304', async () => {
    const instance = await start();
    const misses = ['"deadbeefdeadbeefdeadbeefdeadbeef"', 'W/"deadbeefdeadbeefdeadbeefdeadbeef"'];
    for (const value of misses) {
      const miss = await getCatalog(instance.url, { 'if-none-match': value });
      expect(miss.response.status, `If-None-Match: ${value} 不匹配时不许回 304`).toBe(200);
      expect(miss.text.length).toBeGreaterThan(0);
    }
  });
});

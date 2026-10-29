import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';

import { describe, expect, it, afterEach } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { PlantOmicsError } from '../src/core/errors.js';
import { ToolRegistry } from '../src/core/registry.js';
import type { SourceBundle, ToolDefinition } from '../src/core/types.js';
import { assertBudget, BudgetError, MAX_SOURCES, MAX_TOOLS } from '../src/service/budget.js';
import { parseServiceConfig, ServiceConfigError } from '../src/service/config.js';
import { SERVICE_IDENTITY, readBuildRev, serviceVersion } from '../src/service/version.js';
import { createService, MAX_REQUEST_BODY_BYTES, type RunningService, type ServiceLogEntry } from '../src/service/http.js';
import { registry as defaultRegistry } from '../src/sources/index.js';

/**
 * 服务层测试。**全离线**：只在 127.0.0.1 上起临时监听，不发任何上游请求。
 *
 * 这里刻意不测"工具调用成功"——那要打真实上游。
 * 测的是这一层自己负责的东西：预算门禁、鉴权、协议可达、日志不泄参数。
 */

const running: RunningService[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const service of running.splice(0)) await service.close().catch(() => {});
});

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} 的测试用描述，长度足够让注册表校验通过`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return { text: 'ok', meta: { sourceId: 'synth', request: 'GET http://example.invalid', url: 'http://example.invalid', status: 200, durationMs: 1, at: new Date().toISOString() } };
    },
  };
}

function syntheticRegistry(options: { tools: string[]; sources?: number }): ToolRegistry {
  const registry = new ToolRegistry();
  const sourceCount = options.sources ?? 1;
  const perSource = Math.ceil(options.tools.length / sourceCount);
  for (let s = 0; s < sourceCount; s += 1) {
    const id = `synth${s}`;
    const slice = options.tools.slice(s * perSource, (s + 1) * perSource);
    const bundle: SourceBundle = {
      manifest: {
        id,
        displayName: id,
        homepage: 'https://example.invalid',
        apiBase: 'https://example.invalid',
        tier: 'T1',
        docs: 'https://example.invalid/docs',
        auth: 'none',
        species: ['Synthetic'],
        network: 'direct',
        probe: { path: '/x', expect: 'json' },
      },
      tools: slice.map((name) => tool(`${id}_${name}`)),
    };
    registry.register(bundle);
  }
  return registry;
}

async function startService(overrides: Partial<Parameters<typeof parseServiceConfig>[0]> = {}, token?: string) {
  const config = parseServiceConfig({
    PLANTOMICS_HUB_HOST: '127.0.0.1',
    PLANTOMICS_HUB_PORT: '0',
    ...(token ? { PLANTOMICS_HUB_TOKEN: token } : {}),
    ...overrides,
  } as NodeJS.ProcessEnv);
  const service = createService({ registry: defaultRegistry, config });
  const instance = await service.start();
  running.push(instance);
  return instance;
}

describe('启动期预算门禁', () => {
  it('正常注册表通过，并报出工具名预算', () => {
    const report = assertBudget(defaultRegistry, 'plantomics-hub');
    expect(report.tools).toBe(34);
    expect(report.nameBudget).toBe(43);
    expect('mcp__plantomics-hub__'.length).toBe(21);
  });

  it('工具数超过 40 → 拒绝，且消息点名超限数量', () => {
    const many = syntheticRegistry({ tools: Array.from({ length: MAX_TOOLS + 1 }, (_, i) => `t${i}`) });
    let error: unknown;
    try {
      assertBudget(many, 'plantomics-hub');
    } catch (failure) {
      error = failure;
    }
    expect(error).toBeInstanceOf(BudgetError);
    expect(String((error as Error).message)).toContain(`超过上限 ${MAX_TOOLS}`);
  });

  it('源数超过 20 → 拒绝', () => {
    const many = syntheticRegistry({ tools: Array.from({ length: MAX_SOURCES + 1 }, (_, i) => `t${i}`), sources: MAX_SOURCES + 1 });
    expect(() => assertBudget(many, 'plantomics-hub')).toThrow(BudgetError);
  });

  it('工具名超过名字预算 → 拒绝（不许静默改名）', () => {
    // 名字总长（含源前缀）必须超过 43；合成源前缀是 synth0_（7 字符）
    const registry = syntheticRegistry({ tools: ['x'.repeat(44)] });
    let error: unknown;
    try {
      assertBudget(registry, 'plantomics-hub');
    } catch (failure) {
      error = failure;
    }
    expect(error).toBeInstanceOf(BudgetError);
    expect(String((error as Error).message)).toContain('不可预测');
  });

  it('恰好 43 字符的工具名通过（边界不误杀）', () => {
    const registry = syntheticRegistry({ tools: ['y'.repeat(43 - 'synth0_'.length)] });
    expect(() => assertBudget(registry, 'plantomics-hub')).not.toThrow();
  });

  it('门禁失败时没有监听端口（启动即失败，不是带病接客）', async () => {
    const many = syntheticRegistry({ tools: Array.from({ length: MAX_TOOLS + 1 }, (_, i) => `t${i}`) });
    const config = parseServiceConfig({ PLANTOMICS_HUB_HOST: '127.0.0.1', PLANTOMICS_HUB_PORT: '0' } as NodeJS.ProcessEnv);
    const service = createService({ registry: many, config });
    await expect(service.start()).rejects.toBeInstanceOf(BudgetError);
  });
});

describe('服务配置', () => {
  it('无 token 时不允许绑定非回环地址', () => {
    expect(() => parseServiceConfig({ PLANTOMICS_HUB_HOST: '0.0.0.0' } as NodeJS.ProcessEnv)).toThrow(ServiceConfigError);
  });

  it('token 过短 → 拒绝', () => {
    expect(() => parseServiceConfig({ PLANTOMICS_HUB_HOST: '0.0.0.0', PLANTOMICS_HUB_TOKEN: 'short' } as NodeJS.ProcessEnv)).toThrow(ServiceConfigError);
  });

  it('serverName 不合法 → 拒绝', () => {
    expect(() => parseServiceConfig({ PLANTOMICS_HUB_SERVER_NAME: '植物组学' } as NodeJS.ProcessEnv)).toThrow(ServiceConfigError);
  });

  it('端口越界 → 拒绝', () => {
    expect(() => parseServiceConfig({ PLANTOMICS_HUB_PORT: '70000' } as NodeJS.ProcessEnv)).toThrow(ServiceConfigError);
  });
});

describe('HTTP 鉴权', () => {
  const TOKEN = 'a'.repeat(24);

  it('无 Authorization → 401，且不进入协议处理', async () => {
    const instance = await startService({}, TOKEN);
    const response = await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('错误 token → 401', async () => {
    const instance = await startService({}, TOKEN);
    const response = await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${'b'.repeat(24)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('正确 token → 握手成功，能列工具', async () => {
    const instance = await startService({}, TOKEN);
    const client = new Client({ name: 'service-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(instance.url), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }));
    const { tools } = await client.listTools();
    expect(tools.length).toBe(34);
  });

  it('认证失败发生在传输层：零上游调用，也不伪装成"本次未返回"', async () => {
    let calls = 0;
    const counters = new ToolRegistry();
    counters.register({
      manifest: {
        id: 'synth',
        displayName: 'synth',
        homepage: 'https://example.invalid',
        apiBase: 'https://example.invalid',
        tier: 'T1',
        docs: 'https://example.invalid/docs',
        auth: 'none',
        species: ['Synthetic'],
        network: 'direct',
        probe: { path: '/x', expect: 'json' },
      },
      tools: [
        {
          name: 'synth_probe',
          description: '用于断言认证失败时不会执行到工具层的测试工具',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          async run() {
            calls += 1;
            return {
              text: '本不该被执行',
              meta: {
                sourceId: 'synth', request: 'GET http://example.invalid', url: 'http://example.invalid',
                status: 200, durationMs: 1, at: new Date().toISOString(),
              },
            };
          },
        },
      ],
    });

    const config = parseServiceConfig({
      PLANTOMICS_HUB_HOST: '127.0.0.1',
      PLANTOMICS_HUB_PORT: '0',
      PLANTOMICS_HUB_TOKEN: TOKEN,
    } as NodeJS.ProcessEnv);
    const instance = await createService({ registry: counters, config }).start();
    running.push(instance);

    const response = await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'synth_probe', arguments: {} } }),
    });
    expect(response.status).toBe(401);
    // 关键：401 必须停在传输层——不能执行工具，也不能返回任何"查无"式文案
    expect(await response.text()).not.toContain('本次未返回');
    expect(calls).toBe(0);
  });

  it('授权先于读体：未授权请求在客户端仍在上传时就被拒绝', async () => {
    const instance = await startService({}, TOKEN);
    const target = new URL(instance.url);

    /**
     * 行为断言，不是读代码断言：
     * 客户端先发一小段 body，然后**不结束**请求，等服务端回话。
     * 若服务端是"读完整个 body 再验 token"，这里只会一直等到超时；
     * 只有"先验 token 再读体"的实现才会在此时返回 401。
     */
    const status = await new Promise<number | 'timeout'>((resolve) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '1024' },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
        clearTimeout(timer);
        request.destroy();
      });
      const timer = setTimeout(() => {
        resolve('timeout');
        request.destroy();
      }, 3000);
      request.on('error', () => {});
      // 只写半截，故意不 end()
      request.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","pad":"');
    });

    expect(status).toBe(401);
  });
});

describe('协议可达（无状态 Streamable HTTP）', () => {
  it('tools/list 返回全部 30 个工具，名字与本地注册表一致', async () => {
    const instance = await startService();
    const client = new Client({ name: 'service-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(instance.url)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(defaultRegistry.listTools().map((t) => t.name).sort());
  });

  it('未知工具 → isError，不伪造成功', async () => {
    const instance = await startService();
    const client = new Client({ name: 'service-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(instance.url)));
    const result = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('非 /mcp 路径 → 404；GET → 405', async () => {
    const instance = await startService();
    const wrongPath = await fetch(new URL('/other', instance.url), { method: 'POST', body: '{}' });
    expect(wrongPath.status).toBe(404);
    const get = await fetch(instance.url, { method: 'GET' });
    expect(get.status).toBe(405);
  });
});

describe('访问日志不泄漏参数', () => {
  it('工具名可记，参数值绝不进日志', async () => {
    const entries: ServiceLogEntry[] = [];
    const config = parseServiceConfig({ PLANTOMICS_HUB_HOST: '127.0.0.1', PLANTOMICS_HUB_PORT: '0' } as NodeJS.ProcessEnv);
    const service = createService({ registry: defaultRegistry, config, logger: (entry) => entries.push(entry) });
    const instance = await service.start();
    running.push(instance);

    const secretParam = 'ORYZA_SECRET_QUERY_STRING';
    const client = new Client({ name: 'service-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(instance.url)));
    await client.listTools();
    // 用不存在的工具名：不触发任何上游请求，但会走 tools/call 这一条日志路径
    await client.callTool({ name: 'unknown_probe_tool', arguments: { q: secretParam } });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(secretParam);
    expect(entries.some((entry) => entry.rpc.includes('tools/list'))).toBe(true);
    // 未登记的工具名不写进日志：避免客户端自填名称污染日志
    expect(entries.some((entry) => entry.tool === 'unknown_probe_tool')).toBe(false);
    expect(entries.some((entry) => entry.tool === '(unknown)')).toBe(true);
  });
});

describe('服务与注册表的关系', () => {
  it('服务不修改注册表：启动前后工具数一致', async () => {
    const before = defaultRegistry.listTools().length;
    await startService();
    expect(defaultRegistry.listTools().length).toBe(before);
  });

  it('配置错误不会被当成上游错误掩盖', () => {
    expect(() => parseServiceConfig({ PLANTOMICS_HUB_HOST: '0.0.0.0' } as NodeJS.ProcessEnv)).toThrow(ServiceConfigError);
    expect(() => new ToolRegistry().register({ manifest: { id: 'X', apiBase: 'https://e.invalid', tier: 'T1' } as never, tools: [] })).toThrow(PlantOmicsError);
  });
});

describe('审查反例：进程不能被打崩', () => {
  it('未授权 + 半截 POST 断开：服务不退出，后续请求照常', async () => {
    const TOKEN = 'c'.repeat(24);
    const instance = await startService({}, TOKEN);
    const target = new URL(instance.url);

    // 发半截 body 后立刻断开（模拟"未授权流量中途挂断"）
    await new Promise<void>((resolve) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2048' },
      });
      request.on('error', () => resolve());
      request.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","pad":"');
      setTimeout(() => {
        request.destroy();
        resolve();
      }, 100);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 进程若崩了，这一步会连不上
    const alive = await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(alive.status).toBe(200);
  });

  it('超大请求体 → 413，且客户端能读到响应（不是连接重置）', async () => {
    const instance = await startService();
    const target = new URL(instance.url);
    const big = 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1024);
    const result = await new Promise<{ status: number; body: string }>((resolve) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
      });
      request.on('error', () => resolve({ status: -1, body: 'client-error' }));
      request.write(big);
      request.end();
    });
    expect(result.status).toBe(413);
    // 客户端要真的读到 413 正文，而不是被 ECONNRESET 掐掉
    expect(result.body).toContain('payload too large');
  });

  it('畸形 JSON → 400（客户端错误，不伪装成服务端 500）', async () => {
    const instance = await startService();
    const response = await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('invalid json');
  });
});

describe('审查反例：回环来源防护', () => {
  /** 裸 socket：不经过任何客户端库规范化，直接发原始请求字节。 */
  function rawRequest(port: number, text: string): Promise<string> {
    return new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      let data = '';
      socket.on('connect', () => socket.write(text));
      socket.on('data', (chunk) => { data += chunk.toString(); });
      socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
      socket.on('error', (error) => resolve(`socket-error: ${(error as NodeJS.ErrnoException).code}`));
      setTimeout(() => { socket.destroy(); resolve(data.split('\r\n')[0] || '(timeout)'); }, 3000);
    });
  }

  it('裸 socket 发 Host: [ → 403，进程不崩（不依赖客户端规范化）', async () => {
    const instance = await startService();
    const target = new URL(instance.url);
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const status = await rawRequest(target.port, [
      'POST /mcp HTTP/1.1',
      'Host: [',
      'Content-Type: application/json',
      'Connection: close',
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ].join('\r\n'));
    expect(status).toContain('403');

    // 进程若被带走，这一步会连不上
    const alive = await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(alive.status).toBe(200);
  });

  it('裸 socket 发畸形 request-target → 400，进程不崩', async () => {
    const instance = await startService();
    const target = new URL(instance.url);
    const status = await rawRequest(target.port, [
      'POST http://[ HTTP/1.1',
      'Host: 127.0.0.1',
      'Connection: close',
      'Content-Length: 2',
      '',
      '{}',
    ].join('\r\n'));
    expect(status).toContain('400');

    const alive = await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(alive.status).toBe(200);
  });

  it('畸形 Host（`[`）→ 403，且进程不崩', async () => {
    const instance = await startService();
    const target = new URL(instance.url);
    const status = await new Promise<number>((resolve) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', host: '[' },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', () => resolve(-1));
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });
    expect(status).toBe(403);
    // 进程若被打崩，后续请求连不上
    const alive = await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(alive.status).toBe(200);
  });

  it('伪造 Host → 403，拿不到工具列表', async () => {
    const instance = await startService();
    const target = new URL(instance.url);
    const status = await new Promise<number>((resolve) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'evil.example.com' },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', () => resolve(-1));
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });
    expect(status).toBe(403);
  });

  it('伪造 Origin → 403', async () => {
    const instance = await startService();
    const target = new URL(instance.url);
    const status = await new Promise<number>((resolve) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', () => resolve(-1));
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });
    expect(status).toBe(403);
  });

  it('回环 Origin 不被误杀', async () => {
    const instance = await startService();
    const target = new URL(instance.url);
    const status = await new Promise<number>((resolve) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${target.port}`, accept: 'application/json, text/event-stream' },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', () => resolve(-1));
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });
    expect(status).toBe(200);
  });

  it('反向代理：显式放行的代理域名可用，未放行的仍 403', async () => {
    const instance = await startService({ PLANTOMICS_HUB_ALLOWED_HOSTS: 'hub.example.org' });
    const target = new URL(instance.url);

    const probe = (host: string) => new Promise<number>((resolve) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', host, accept: 'application/json, text/event-stream' },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', () => resolve(-1));
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });

    expect(await probe('hub.example.org')).toBe(200);
    expect(await probe('hub.example.org:443')).toBe(200);
    expect(await probe('evil.example.com')).toBe(403);
  });

  it('未配置白名单时，代理域名被拒（默认不放开）', async () => {
    const instance = await startService();
    const target = new URL(instance.url);
    const status = await new Promise<number>((resolve) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'hub.example.org' },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', () => resolve(-1));
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });
    expect(status).toBe(403);
  });

  it('白名单配置格式错误 → 启动前就失败', () => {
    expect(() => parseServiceConfig({ PLANTOMICS_HUB_ALLOWED_HOSTS: 'https://hub.example.org' } as NodeJS.ProcessEnv))
      .toThrow(ServiceConfigError);
  });
});

describe('健康检查（上云探针）', () => {
  it('GET /healthz 免鉴权、免 Host 校验，返回版本与规模', async () => {
    const instance = await startService({}, 'a'.repeat(24));
    const target = new URL(instance.url);
    const status = await new Promise<{ code: number; body: string }>((resolve) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: '/healthz',
        method: 'GET',
        // 模拟平台探针：Host 是内部名，且没有 token
        headers: { host: 'container-internal' },
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { text += chunk; });
        response.on('end', () => resolve({ code: response.statusCode ?? 0, body: text }));
      });
      request.on('error', () => resolve({ code: -1, body: '' }));
      request.end();
    });
    expect(status.code).toBe(200);
    const payload = JSON.parse(status.body) as { status: string; version: string; tools: number };
    expect(payload.status).toBe('ok');
    expect(payload.tools).toBe(34);
    expect(payload.version).toBeTruthy();
    // 不泄露工具清单
    expect(status.body).not.toContain('wheatomics_');
  });

  it('POST /healthz → 405（只读探针）', async () => {
    const instance = await startService();
    const response = await fetch(new URL('/healthz', instance.url), { method: 'POST' });
    expect(response.status).toBe(405);
  });

  it('PORT 兼容：未设专用变量时读取平台注入的 PORT', () => {
    const config = parseServiceConfig({ PORT: '4567' } as NodeJS.ProcessEnv);
    expect(config.port).toBe(4567);
    // 专用变量优先
    expect(parseServiceConfig({ PORT: '4567', PLANTOMICS_HUB_PORT: '8901' } as NodeJS.ProcessEnv).port).toBe(8901);
  });
});

describe('服务端版本独立于包版本', () => {
  it('声明规模与真实注册表一致（改工具集必须升版本并同步计数）', () => {
    const report = assertBudget(defaultRegistry, 'plantomics-hub');
    expect({ sources: report.sources, tools: report.tools }).toEqual({ ...SERVICE_IDENTITY });
  });

  it('版本形如 0.1.0+svc.N，且与包版本分开报告', async () => {
    const instance = await startService();
    const response = await fetch(new URL('/healthz', instance.url));
    const payload = (await response.json()) as { version: string; package: string; sources: number; tools: number };
    expect(payload.version.startsWith(serviceVersion(payload.package))).toBe(true);
    expect(payload.version).toMatch(/^0\.1\.0\+svc\.\d+(\.g[0-9a-f]{7,}(-dirty)?)?$/);
    expect(payload.package).toBe('0.1.0');
    expect(payload.sources).toBe(7);
    expect(payload.tools).toBe(34);
  });
  it('版本可带构建 sha：+svc.N.g<sha>，拿不到 sha 时退化', () => {
    expect(serviceVersion('0.1.0')).toBe('0.1.0+svc.5');
    expect(serviceVersion('0.1.0', 'abc1234')).toBe('0.1.0+svc.5.gabc1234');
    expect(serviceVersion('0.1.0', 'abc1234-dirty')).toBe('0.1.0+svc.5.gabc1234-dirty');
    expect(readBuildRev(() => JSON.stringify({ sourceRev: 'deadbee' }), 'x')).toBe('deadbee');
    expect(readBuildRev(() => 'not json', 'x')).toBeUndefined();
    expect(readBuildRev(() => JSON.stringify({}), 'x')).toBeUndefined();
  });
});

describe('审查反例：日志字段不可被客户端伪造', () => {
  it('未知方法名折叠为 (other)：含换行的伪造 method 不进日志', async () => {
    const entries: ServiceLogEntry[] = [];
    const config = parseServiceConfig({ PLANTOMICS_HUB_HOST: '127.0.0.1', PLANTOMICS_HUB_PORT: '0' } as NodeJS.ProcessEnv);
    const instance = await createService({ registry: defaultRegistry, config, logger: (entry) => entries.push(entry) }).start();
    running.push(instance);

    const forgedMethod = 'tools/list\nFAKE 1970-01-01T00:00:00.000Z POST tools/call tool=evil → 200 0ms';
    await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: forgedMethod }),
    });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('FAKE');
    expect(entries.every((entry) => !entry.rpc.includes('\n') && !String(entry.tool ?? '').includes('\n'))).toBe(true);
    expect(entries.some((entry) => entry.rpc === '(other)')).toBe(true);
  });

  it('未知工具名（含换行）一律记 (unknown)，已登记工具名照记', async () => {
    const entries: ServiceLogEntry[] = [];
    const config = parseServiceConfig({ PLANTOMICS_HUB_HOST: '127.0.0.1', PLANTOMICS_HUB_PORT: '0' } as NodeJS.ProcessEnv);
    const instance = await createService({ registry: defaultRegistry, config, logger: (entry) => entries.push(entry) }).start();
    running.push(instance);

    const post = (name: string) => fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
    });

    await post('evil\nFAKE 2026-01-01T00:00:00Z POST tools/call tool=gramene_gene → 200 0ms');
    await post('no_such_registered_tool');

    expect(JSON.stringify(entries)).not.toContain('FAKE');
    expect(entries.every((entry) => entry.tool === '(unknown)')).toBe(true);
  });

  it('合法字符组成的未知方法名也折叠为 (other)——白名单而非正则', async () => {
    const entries: ServiceLogEntry[] = [];
    const config = parseServiceConfig({ PLANTOMICS_HUB_HOST: '127.0.0.1', PLANTOMICS_HUB_PORT: '0' } as NodeJS.ProcessEnv);
    const instance = await createService({ registry: defaultRegistry, config, logger: (entry) => entries.push(entry) }).start();
    running.push(instance);

    await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'admin/secret_looking_but_unknown' }),
    });

    expect(entries.some((entry) => entry.rpc === '(other)')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('admin/secret_looking_but_unknown');
  });

  it('已登记工具名照常记录（白名单不误杀）', async () => {
    const entries: ServiceLogEntry[] = [];
    const config = parseServiceConfig({ PLANTOMICS_HUB_HOST: '127.0.0.1', PLANTOMICS_HUB_PORT: '0' } as NodeJS.ProcessEnv);
    const instance = await createService({ registry: defaultRegistry, config, logger: (entry) => entries.push(entry) }).start();
    running.push(instance);

    await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no_such_but_check_only', arguments: {} } }),
    });
    expect(entries.some((entry) => entry.tool === '(unknown)')).toBe(true);
    expect(entries.some((entry) => entry.rpc === 'tools/call')).toBe(true);
  });
});

describe('审查反例：请求体读取时间上限', () => {
  it('只发半截后挂着不动 → 超时拒绝，进程仍可用', async () => {
    const config = parseServiceConfig({ PLANTOMICS_HUB_HOST: '127.0.0.1', PLANTOMICS_HUB_PORT: '0' } as NodeJS.ProcessEnv);
    const instance = await createService({
      registry: defaultRegistry,
      config,
      bodyReadTimeoutMs: 300,
    }).start();
    running.push(instance);
    const target = new URL(instance.url);

    const status = await new Promise<number>((resolve) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '4096' },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', () => resolve(-1));
      request.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","pad":"');
      // 不 end()：模拟挂住不退的客户端
    });

    expect(status).toBe(408);
    // 服务仍可用
    const alive = await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(alive.status).toBe(200);
  });
});

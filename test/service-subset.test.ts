import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { parseServiceConfig } from '../src/service/config.js';
import { createService, type RunningService } from '../src/service/http.js';
import { resolveSubset, SOURCE_SUBSET_HEADER } from '../src/service/subset.js';
import { createRegistry, parseSourceList, registry as defaultRegistry } from '../src/sources/index.js';

/**
 * 按请求选源（`x-plantomics-sources`）。
 *
 * 全离线：只在 127.0.0.1 起临时监听，**不调任何上游工具**——这里测的是"这条连接能看见哪些工具"，
 * 不是"工具能不能取到数"。
 *
 * 三条硬要求（负责人给的口径）：
 * 1. 指定子集 → 只返回该子集的工具；
 * 2. 未知 id → 报错，不许静默变成零工具；
 * 3. 不指定 → 行为与加这个功能之前完全一致。
 */

const running: RunningService[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const service of running.splice(0)) await service.close().catch(() => {});
});

async function start(registry = defaultRegistry): Promise<RunningService> {
  const config = parseServiceConfig({
    PLANTOMICS_HUB_HOST: '127.0.0.1',
    PLANTOMICS_HUB_PORT: '0',
  } as NodeJS.ProcessEnv);
  const instance = await createService({ registry, config }).start();
  running.push(instance);
  return instance;
}

async function connect(instance: RunningService, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'subset-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(instance.url), { requestInit: { headers } }),
  );
  clients.push(client);
  return client;
}

async function toolNames(headers: Record<string, string> = {}): Promise<string[]> {
  const instance = await start();
  const client = await connect(instance, headers);
  const { tools } = await client.listTools();
  return tools.map((entry) => entry.name).sort();
}

const metaNames = defaultRegistry.listMetaTools().map((tool) => tool.name).sort();

describe('按请求选源：指定子集', () => {
  it('只要 icg：只返回 icg 工具 + 元工具', async () => {
    const names = await toolNames({ [SOURCE_SUBSET_HEADER]: 'icg' });
    expect(names).toEqual([...metaNames, 'icg_lookup', 'icg_species_list'].sort());
    expect(names.every((name) => name.startsWith('icg_') || name.startsWith('hub_'))).toBe(true);
    expect(names).not.toContain('wheatomics_search_known_genes');
  });

  it('多源用逗号/分号/空白切都行，结果一致', async () => {
    const comma = await toolNames({ [SOURCE_SUBSET_HEADER]: 'icg,scod' });
    const semicolon = await toolNames({ [SOURCE_SUBSET_HEADER]: 'icg; scod' });
    expect(comma).toEqual(semicolon);
    expect(comma).toHaveLength(metaNames.length + 2 + 2);
    expect(comma).toContain('scod_gene_region');
  });

  it('子集里调未启用的工具 → isError 且点名未知工具，不是伪造成功', async () => {
    const instance = await start();
    const client = await connect(instance, { [SOURCE_SUBSET_HEADER]: 'icg' });
    const result = await client.callTool({ name: 'wheatomics_search_known_genes', arguments: { query: 'x' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(text).toContain('未知工具');
    expect(text).toContain('icg_lookup');
    // 「可用工具」列表必须是子集，不能把全集工具列出来诱使模型去调
    const available = text.split('可用工具：')[1] ?? '';
    expect(available).toContain('icg_species_list');
    expect(available).not.toContain('wheatomics_');
  });
});

describe('按请求选源：未知 id 必须报错', () => {
  it('完全未知的 id → HTTP 400，点名 id，不返回空清单', async () => {
    const instance = await start();
    const response = await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SOURCE_SUBSET_HEADER]: 'nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string; detail?: string };
    expect(payload.error).toBe('invalid source subset');
    expect(payload.detail).toContain('nope');
    expect(payload.detail).toContain('未知的源 id');
    expect(payload.detail).toContain('wheatomics'); // 报错里给出已登记源，便于改
  });

  it('拼错一个字母也算未知（不许当成零工具放过）', async () => {
    const instance = await start();
    const response = await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SOURCE_SUBSET_HEADER]: 'icgg' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { detail?: string }).detail).toContain('icgg');
  });

  it('源存在但本服务未启用 → 400，并说明本服务启用了哪些', async () => {
    const restricted = createRegistry({ enabled: ['icg'] });
    const instance = await start(restricted);

    const allowed = await connect(instance, { [SOURCE_SUBSET_HEADER]: 'icg' });
    expect((await allowed.listTools()).tools.map((tool) => tool.name).sort())
      .toEqual([...metaNames, 'icg_lookup', 'icg_species_list'].sort());

    const response = await fetch(instance.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SOURCE_SUBSET_HEADER]: 'wheatomics' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { detail?: string };
    expect(payload.detail).toContain('未在本服务启用');
    expect(payload.detail).toContain('icg');
  });
});

describe('按请求选源：不指定时行为不变', () => {
  it('不带请求头 → 工具清单与服务端注册表逐项相同', async () => {
    const names = await toolNames();
    expect(names).toEqual(defaultRegistry.listTools().map((tool) => tool.name).sort());
    expect(names).toHaveLength(37);
  });

  it('只有分隔符/空白 → 当作没指定（退回全集，不是空集）', async () => {
    for (const value of ['', '   ', ',', ' , ; ']) {
      const names = await toolNames({ [SOURCE_SUBSET_HEADER]: value });
      expect(names).toHaveLength(37);
    }
  });

  it('/healthz 仍报服务端全集，不受子集影响', async () => {
    const instance = await start();
    const health = await fetch(`${instance.url.replace(/\/mcp$/, '')}/healthz`, {
      headers: { [SOURCE_SUBSET_HEADER]: 'icg' },
    });
    expect(health.status).toBe(200);
    const payload = (await health.json()) as { sources: number; tools: number; metaTools: number };
    expect(payload.sources).toBe(8);
    expect(payload.tools).toBe(37);
    expect(payload.metaTools).toBe(2);
  });

  it('子集请求不会污染默认注册表', async () => {
    await toolNames({ [SOURCE_SUBSET_HEADER]: 'icg' });
    expect(defaultRegistry.listSources()).toHaveLength(8);
    expect(defaultRegistry.listTools()).toHaveLength(37);
  });
});

describe('按请求选源：握手 instructions 随子集变化（有意设计，锁住它）', () => {
  it('子集请求的 initialize 文案写明本次启用的源数与工具数', async () => {
    const instance = await start();
    const subsetClient = await connect(instance, { [SOURCE_SUBSET_HEADER]: 'icg' });
    const subsetInstructions = subsetClient.getInstructions() ?? '';
    expect(subsetInstructions).toContain('本次请求启用 1 个源、4 个工具');
    expect(subsetInstructions).toContain('只启用了部分源');

    const fullClient = await connect(instance);
    const fullInstructions = fullClient.getInstructions() ?? '';
    expect(fullInstructions).toContain('本次请求启用 8 个源、37 个工具');
    expect(fullInstructions).not.toContain('只启用了部分源');
  });

  it('同一服务上不带头的下一条请求仍拿到全集（证明不是权限隔离）', async () => {
    const instance = await start();
    const subsetClient = await connect(instance, { [SOURCE_SUBSET_HEADER]: 'icg' });
    expect((await subsetClient.listTools()).tools).toHaveLength(4);

    const plainClient = await connect(instance);
    expect((await plainClient.listTools()).tools).toHaveLength(37);
  });
});

describe('resolveSubset 单元约束', () => {
  it('未指定返回 base 本身（同一对象，不是副本）', () => {
    expect(resolveSubset(defaultRegistry, undefined).registry).toBe(defaultRegistry);
    expect(resolveSubset(defaultRegistry, '  ').registry).toBe(defaultRegistry);
    expect(resolveSubset(defaultRegistry, undefined).requested).toBeUndefined();
  });

  it('指定时返回新注册表，且 requested 记录点名清单', () => {
    const resolution = resolveSubset(defaultRegistry, 'icg, scod');
    expect(resolution.registry).not.toBe(defaultRegistry);
    expect(resolution.requested).toEqual(['icg', 'scod']);
    expect(resolution.registry.listSources().map((bundle) => bundle.manifest.id)).toEqual(['icg', 'scod']);
  });

  it('重复 id 不重复注册工具', () => {
    const resolution = resolveSubset(defaultRegistry, 'icg,icg');
    expect(resolution.registry.listTools().filter((tool) => tool.name.startsWith('icg_'))).toHaveLength(2);
  });

  it('parseSourceList 把空串/纯分隔符判为未指定', () => {
    expect(parseSourceList(undefined)).toBeUndefined();
    expect(parseSourceList(' ; , ')).toBeUndefined();
    expect(parseSourceList('a;b,c d')).toEqual(['a', 'b', 'c', 'd']);
  });
});

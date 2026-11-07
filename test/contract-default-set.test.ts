import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpServer } from '../src/mcp/server.js';
import { DEFAULT_SET_SOURCES } from '../src/service/budget.js';
import { buildCatalog } from '../src/service/catalog.js';
import { parseServiceConfig } from '../src/service/config.js';
import { createService, type RunningService } from '../src/service/http.js';
import { registry } from '../src/sources/index.js';

/**
 * P1「契约单一真相」的离线契约测试（stdout / HTTP 各一次）。
 *
 * 断言：默认会话的 `tools/list` 条数 == `/catalog.budget.defaultSetTools` ==
 * `hub_status` 正文里的「默认推荐集：N 个工具」。
 *
 * 刻意不 import `defaultSetToolCount` 来和 `/catalog` 自比：三个读数分别走三条
 * 运行时路径（协议 / HTTP 字段 / 文本正文），任何一处另写一份数字都会让这条红。
 * 唯一允许的例外是 P1/0.1.2 的预期值 41——它是本阶段的验收目标，P2b 真过滤到 35 时
 * 改这一处常量即可（三处读数仍须相等）。
 */

const EXPECTED_DEFAULT_SET_TOOLS = 41;

const running: RunningService[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const service of running.splice(0)) await service.close().catch(() => {});
});

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((entry): entry is TextContent => entry.type === 'text')
    .map((entry) => entry.text)
    .join('\n');
}

/** 与 `scripts/status-report.mjs` 同一段正文口径：只认「默认推荐集：N 个工具」。 */
function defaultSetFromStatus(text: string): number {
  const match = /默认推荐集：\s*(\d+)\s*个工具/.exec(text);
  if (!match) throw new Error('hub_status 正文里找不到「默认推荐集：N 个工具」');
  return Number(match[1]);
}

async function stdioReadings(): Promise<{ toolsList: number; hubStatus: number }> {
  const server = createMcpServer(registry);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract-default-set-stdio', version: '0.0.0' });
  clients.push(client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = (await client.listTools()).tools;
    const status = await client.callTool({ name: 'hub_status', arguments: {} });
    expect(status.isError).toBeFalsy();
    return { toolsList: tools.length, hubStatus: defaultSetFromStatus(textOf(status)) };
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

describe('P1 默认集契约：三处读数必须相同', () => {
  it('DEFAULT_SET_SOURCES 是默认集的唯一清单，P1/0.1.2 覆盖全部已登记源', () => {
    expect(new Set(DEFAULT_SET_SOURCES)).toEqual(
      new Set(registry.listSources().map((bundle) => bundle.manifest.id)),
    );
  });

  it('stdio：tools/list == /catalog.defaultSetTools == hub_status == 41', async () => {
    const catalog = buildCatalog(registry, { version: '0.1.1+svc.test' });
    const stdio = await stdioReadings();

    expect(stdio.toolsList).toBe(EXPECTED_DEFAULT_SET_TOOLS);
    expect(catalog.budget.defaultSetTools).toBe(stdio.toolsList);
    expect(stdio.hubStatus).toBe(stdio.toolsList);
  });

  it('HTTP：tools/list == /catalog.defaultSetTools == hub_status == 41', async () => {
    const config = parseServiceConfig({
      PLANTOMICS_HUB_HOST: '127.0.0.1',
      PLANTOMICS_HUB_PORT: '0',
      PLANTOMICS_HUB_TOKEN: '',
      PLANTOMICS_HUB_LOG: 'quiet',
    } as NodeJS.ProcessEnv);
    const service = await createService({ registry, config, logger: () => {} }).start();
    running.push(service);

    const response = await fetch(new URL('/catalog', service.url));
    expect(response.status).toBe(200);
    const catalog = (await response.json()) as { budget: { defaultSetTools: number } };

    const client = new Client({ name: 'contract-default-set-http', version: '0.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const tools = (await client.listTools()).tools;
    const status = await client.callTool({ name: 'hub_status', arguments: {} });
    expect(status.isError).toBeFalsy();

    expect(tools.length).toBe(EXPECTED_DEFAULT_SET_TOOLS);
    expect(catalog.budget.defaultSetTools).toBe(tools.length);
    expect(defaultSetFromStatus(textOf(status))).toBe(tools.length);
  });
});

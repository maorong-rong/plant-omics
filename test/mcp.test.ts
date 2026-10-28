import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../src/core/registry.js';
import type { ToolDefinition } from '../src/core/types.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createRegistry } from '../src/sources/index.js';

/**
 * 端到端协议测试：走完整的 initialize → tools/list → tools/call 握手。
 *
 * 审查 R08 指出原版只测了「列工具 / 未知工具 / 缺参数」，**没有一次成功取数**。
 * 这里补上成功路径（用假工具，仍然全程离线），并检查只读注解与未知参数拦截。
 */
async function connect(registry = createRegistry()) {
  const server = createMcpServer(registry);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'plant-omics-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { registry, server, client };
}

const echoTool: ToolDefinition = {
  name: 'demo_echo',
  description: '演示用的回显工具：原样返回传入的 q，用于验证 tools/call 的成功路径。',
  parameters: {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
    additionalProperties: false,
  },
  async run(args) {
    return {
      text: `echo:${String(args.q)}`,
      meta: { sourceId: 'demo', request: 'GET /echo', url: 'https://example.org/echo', status: 200, durationMs: 1, at: '' },
    };
  },
};

function demoRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    manifest: {
      id: 'demo',
      displayName: '演示源',
      homepage: 'https://example.org',
      apiBase: 'https://example.org/api',
      tier: 'T1',
      docs: 'https://example.org/api/docs',
      auth: 'none',
      species: ['Arabidopsis thaliana'],
      network: 'direct',
      probe: { path: '/ping' },
    },
    tools: [echoTool],
  });
  return registry;
}

describe('MCP 协议层', () => {
  it('握手后能列出全部工具，inputSchema 是 object，且带只读注解', async () => {
    const { client, server } = await connect();
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(6);
      expect(listed.tools.map((tool) => tool.name)).toContain('wheatomics_search_known_genes');
      for (const tool of listed.tools) {
        expect(tool.description?.length ?? 0).toBeGreaterThan(10);
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('**成功取数**能穿过协议层拿到文本（原先缺这条）', async () => {
    const { client, server } = await connect(demoRegistry());
    try {
      const result = await client.callTool({ name: 'demo_echo', arguments: { q: 'VRN1' } });
      expect(result.isError).toBeFalsy();
      const first = result.content?.[0];
      expect(first && 'text' in first ? first.text : '').toBe('echo:VRN1');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('调用未知工具返回 isError，而不是把连接搞崩', async () => {
    const { client, server } = await connect();
    try {
      const result = await client.callTool({ name: 'wheatomics_not_exist', arguments: {} });
      expect(result.isError).toBe(true);
      const first = result.content?.[0];
      expect(first && 'text' in first ? first.text : '').toContain('未知工具');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('缺必填参数时返回 isError 且提示参数名', async () => {
    const { client, server } = await connect();
    try {
      const result = await client.callTool({ name: 'wheatomics_search_known_genes', arguments: {} });
      expect(result.isError).toBe(true);
      const first = result.content?.[0];
      expect(first && 'text' in first ? first.text : '').toContain('searchid');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('传已改名的旧参数（since_days）会被明确拒绝，不是静默忽略', async () => {
    const { client, server } = await connect();
    try {
      const result = await client.callTool({
        name: 'wheatomics_search_papers',
        arguments: { q: 'drought', since_days: 30 },
      });
      expect(result.isError).toBe(true);
      const first = result.content?.[0];
      expect(first && 'text' in first ? first.text : '').toContain('未知参数');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

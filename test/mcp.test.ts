import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../src/core/registry.js';
import type { ToolDefinition } from '../src/core/types.js';
import { invokeTool } from '../src/core/invoke.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createRegistry } from '../src/sources/index.js';
import { UpstreamError, describeError } from '../src/core/errors.js';
import type { Fetcher } from '../src/core/types.js';
import { readFileSync } from 'node:fs';

/**
 * 0.1.0 薄插件不再执行工具，DSH 侧不再是"第二个工具执行出口"。
 * 这里保留一个**测试用直调**，只为校验工具本身的文本、错误与预算语义
 * （与 MCP 出口共用同一个 invokeTool 入口）；它不代表插件仍注册工具。
 */
async function callDirect(registry: ToolRegistry, name: string, args: Record<string, unknown>): Promise<string> {
  const tool = registry.getTool(name);
  if (!tool) throw new Error(`测试里找不到工具 ${name}`);
  try {
    const result = await invokeTool(tool, args, {});
    return result.text;
  } catch (error) {
    // 与两个出口一致：错误文本同样带完整请求（describeError 的职责）
    throw new Error(describeError(error));
  }
}

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
      expect(listed.tools).toHaveLength(34);
      expect(listed.tools.map((tool) => tool.name)).toContain('strawberry_catalog');
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

describe('两个出口的完整请求证据（离线模拟HTTP错误）', () => {
  it('超过300字符但未超预算的完整ID请求，MCP与DSH错误都不省略', async () => {
    const bundle = createRegistry({ enabled: ['wheatomics'] }).getSource('wheatomics')!;
    const original = bundle.tools.find(t => t.name === 'wheatomics_convert_gene_ids')!;
    let seen = '';
    const http = (async (url: string) => {
      seen = url;
      throw new UpstreamError('模拟404', { url, status: 404, contentType: 'text/html' });
    }) as Fetcher;
    const registry = new ToolRegistry();
    registry.register({ manifest: bundle.manifest, tools: [{ ...original,
      run: (args, ctx) => original.run(args, { ...ctx, http }) }] });
    const ids = Array.from({ length: 20 }, (_, i) => `TraesCS6B01G${String(i).padStart(6, '0')}.1`).join(',');
    const args = { ids, gene_version: 'IWGSCv1_result' };
    const { client, server } = await connect(registry);
    try {
      const result = await client.callTool({ name: original.name, arguments: args });
      const text = JSON.stringify(result.content);
      expect(result.isError).toBe(true);
      expect(seen.length).toBeGreaterThan(300);
      expect(text).toContain(seen);
      // 0.1.0 薄插件不再执行工具：DSH 侧回放已移除；工具错误原文由 MCP/服务出口覆盖。
    } finally { await client.close(); await server.close(); }
  });
  it('超预算输入在两个出口均失败且零联网', async () => {
    const bundle = createRegistry({ enabled: ['wheatomics'] }).getSource('wheatomics')!;
    const original = bundle.tools.find(t => t.name === 'wheatomics_convert_gene_ids')!;
    let calls = 0;
    const http = (async () => { calls++; throw new Error('不应联网'); }) as Fetcher;
    const registry = new ToolRegistry();
    registry.register({ manifest: bundle.manifest, tools: [{ ...original,
      run: (args, ctx) => original.run(args, { ...ctx, http }) }] });
    const args = { ids: Array.from({ length: 100 }, (_, i) => `TraesCS6B01G${i}.1`).join(','), gene_version: 'IWGSCv1_result' };
    const { client, server } = await connect(registry);
    try {
      const result = await client.callTool({ name: original.name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('尚未联网');
      // 0.1.0 薄插件不再执行工具：DSH 侧回放已移除；工具错误原文由 MCP/服务出口覆盖。
      expect(calls).toBe(0);
    } finally { await client.close(); await server.close(); }
  });
});

describe('五个Strawberry工具穿过两个出口（真实fixture，离线）', () => {
  const cases: [string, string, Record<string, unknown>, string][] = [
    ['catalog', 'catalog.json', {}, '目录模块'],
    ['gene_lookup', 'gene-lookup.json', { geneId: 'BCIN_01g00010' }, 'Botrytis cinerea'],
    ['expression', 'expression.json', { geneId: 'FvesChr1G00279070.1' }, 'batch-corrected TPM'],
    ['synteny', 'synteny.json', { geneId: 'Fxa1Ag00001', sourceAssembly: 'fxa_benihoppe', targetAssembly: 'fxa_camarosa' }, '共线不等于'],
    ['tf_members', 'tf-matches.json', { family: 'ERF', pageSize: 2 }, '上游total=10677'],
  ];
  it.each(cases)('%s的MCP文本和DSH渲染均保留完整请求', async (suffix, file, args, expected) => {
    const bundle = createRegistry({ enabled: ['strawberry'] }).getSource('strawberry')!;
    const original = bundle.tools.find(t => t.name === `strawberry_${suffix}`)!;
    const captured = JSON.parse(readFileSync(new URL(`../src/sources/strawberry/fixtures/${file}`, import.meta.url), 'utf8'));
    let used = '';
    const http = (async (url: string) => {
      used = url;
      return { data: captured.payload, url, status: 200, attempts: 1, durationMs: 1, contentType: 'application/json' };
    }) as Fetcher;
    const registry = new ToolRegistry();
    registry.register({ ...bundle, tools: [{ ...original, run: (a, c) => original.run(a, { ...c, http }) }] });
    const { client, server } = await connect(registry);
    try {
      const result = await client.callTool({ name: original.name, arguments: args });
      const mcp = JSON.stringify(result.content);
      expect(result.isError).toBeFalsy(); expect(mcp).toContain(expected); expect(mcp).toContain(used);
      expect(mcp).not.toContain('"capture"');
      expect(new TextEncoder().encode(mcp).length).toBeLessThanOrEqual(4200);
    } finally { await client.close(); await server.close(); }
  });
});

describe('Strawberry结构漂移的两出口完整证据（模拟反例）', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['catalog', { module: 'genome' }, '"module":"genome"'],
    ['gene_lookup', { geneId: 'BCIN_01g00010', includeSequence: true }, '"includeSequence":true'],
    ['expression', { geneId: 'FvesChr1G00279070.1', top: 3 }, '"top":3'],
    ['synteny', { geneId: 'Fxa1Ag00001', sourceAssembly: 'fxa_benihoppe', targetAssembly: 'fxa_camarosa', maxBlocks: 2 }, '"maxBlocks":2'],
    ['tf_members', { family: 'ERF', pageSize: 2 }, '"maxShown":20'],
  ];
  it.each(cases)('%s字段漂移时两出口均展示真实URL及本地参数', async (suffix, args, local) => {
    const bundle = createRegistry({ enabled: ['strawberry'] }).getSource('strawberry')!;
    const original = bundle.tools.find(t => t.name === `strawberry_${suffix}`)!;
    let used = ''; let calls = 0;
    const http = (async (url: string) => {
      used = url; calls++;
      return { data: {}, url, status: 200, attempts: 1, durationMs: 1, contentType: 'application/json' };
    }) as Fetcher;
    const registry = new ToolRegistry();
    registry.register({ ...bundle, tools: [{ ...original, run: (a,c) => original.run(a, { ...c, http }) }] });
    const { client, server } = await connect(registry);
    try {
      const result = await client.callTool({ name: original.name, arguments: args });
      expect(result.isError).toBe(true);
      const first = result.content?.[0];
      const text = first && 'text' in first ? String(first.text) : '';
      expect(text).toContain(`request=GET ${used}`);
      expect(text).toContain(local);
      // 0.1.0 薄插件不再执行工具：DSH 侧回放已移除，结构漂移由 MCP 出口覆盖。
      expect(calls).toBe(1);
    } finally { await client.close(); await server.close(); }
  });
});

describe('GWH/ICG双出口集成（离线真实fixture与模拟漂移）', () => {
  const cases: [string, string, string, Record<string, unknown>, string][] = [
    ['gwh', 'gwh_assembly_lookup', 'genome', { entity: 'genome', id: '1' }, 'Taraxacum'],
    ['gwh', 'gwh_assembly_lookup', 'assembly', { entity: 'assembly', id: 'GWHAAAA00000000' }, 'GWHAAAA00000000'],
    ['gwh', 'gwh_project_sample_lookup', 'bioproject', { entity: 'project', id: 'PRJCA000437' }, 'PRJCA000437'],
    ['gwh', 'gwh_project_sample_lookup', 'biosample', { entity: 'sample', id: 'SAMC012932' }, 'SAMC012932'],
    ['icg', 'icg_lookup', 'species', { entity: 'species', id: 'ICG00115' }, 'Zea mays'],
    ['icg', 'icg_lookup', 'project', { entity: 'project', id: 'ICG00115-1' }, 'ICG00115-1'],
    ['icg', 'icg_lookup', 'gene', { entity: 'gene', id: 'ICG00115-1-EF1a' }, 'TGGGCCTACTGGTCTTACTACTGA'],
    ['icg', 'icg_lookup', 'publication', { entity: 'publication', id: '24810581' }, '24810581'],
    ['icg', 'icg_species_list', 'species-list', { offset: 0, limit: 3 }, 'recordsTotal=540'],
    ['gwh', 'gwh_assembly_lookup', 'genome-missing', { entity: 'genome', id: '999999999' }, '未找到'],
    ['icg', 'icg_lookup', 'not-found', { entity: 'project', id: 'ICG00115-Pro-1' }, '未找到'],
  ];
  it.each(cases)('%s/%s/%s两出口成功及漂移失败', async (source, name, file, args, expected) => {
    const bundle = createRegistry({ enabled: [source] }).getSource(source)!;
    const original = bundle.tools.find(t => t.name === name)!;
    const captured = JSON.parse(readFileSync(new URL(`../src/sources/${source}/fixtures/${file}.json`, import.meta.url), 'utf8'));
    let drift = false;
    const http = (async (url: string) => {
      expect(url).toBe(captured.capture.url);
      return { data: drift ? {} : captured.payload, url, status: captured.capture.status, durationMs: 1, attempts: 1, contentType: captured.capture.contentType };
    }) as Fetcher;
    const isolated = new ToolRegistry();
    isolated.register({ ...bundle, tools: [{ ...original, run: (a,c) => original.run(a, { ...c, http }) }] });
    const { client, server } = await connect(isolated);
    try {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).toBeFalsy();
      const first = response.content?.[0];
      const text = first && 'text' in first ? String(first.text) : '';
      const value = await callDirect(isolated, name, args);
      for (const rendered of [text, value]) {
        expect(rendered).toContain(expected);
        expect(rendered).toContain(`GET ${captured.capture.url}`);
        expect(new TextEncoder().encode(rendered).length).toBeLessThanOrEqual(4096);
        expect(rendered).not.toMatch(/contactEmail|contactName|"capture"|"payload"/);
      }
      drift = true; // 明确模拟：不是上游真实反例。
      const failure = await client.callTool({ name, arguments: args });
      expect(failure.isError).toBe(true);
      const errorFirst = failure.content?.[0];
      const errorText = errorFirst && 'text' in errorFirst ? String(errorFirst.text) : '';
      expect(errorText).toContain(`request=GET ${captured.capture.url}`);
      expect(errorText).not.toContain('未找到');
      await expect(callDirect(isolated, name, args)).rejects.toThrow(`request=GET ${captured.capture.url}`);
    } finally { await client.close(); await server.close(); }
  });
});

describe('IC4R双出口回放（绝对URL、防御性数组解包、序列整块省略）', () => {
  const ic4r = () => createRegistry({ enabled: ['ic4r'] }).getSource('ic4r')!;
  function harness(source: ReturnType<typeof ic4r>, name: string, payload: unknown, captureUrl: string) {
    const original = source.tools.find(t => t.name === name)!;
    const seen: string[] = [];
    const http = (async (url: string) => {
      seen.push(url);
      expect(url).toBe(captureUrl);
      return { data: payload, url, status: 200, durationMs: 1, attempts: 1, contentType: 'application/json;charset=UTF-8' };
    }) as Fetcher;
    const isolated = new ToolRegistry();
    isolated.register({ ...source, tools: [{ ...original, run: (a, c) => original.run(a, { ...c, http }) }] });
    return { isolated, seen, call: (args: Record<string, unknown>) => callDirect(isolated, name, args) };
  }
  const fixtureOf = (file: string) =>
    JSON.parse(readFileSync(new URL(`../src/sources/ic4r/fixtures/${file}.json`, import.meta.url), 'utf8'));

  it('gene_list 走绝对URL（不在 apiBase 下）且两出口一致', async () => {
    const f = fixtureOf('gene-list');
    expect(f.capture.url).toContain('/ic4r/genes/view?');
    expect(f.capture.url).not.toContain('/api/json');
    const { isolated, call, seen } = harness(ic4r(), 'ic4r_gene_list', f.payload, f.capture.url);
    const args = { chromosome: '1', start: 0, length: 2 };
    const { client, server } = await connect(isolated);
    try {
      const res = await client.callTool({ name: 'ic4r_gene_list', arguments: args });
      expect(res.isError).toBeFalsy();
      const text = res.content?.[0] && 'text' in res.content[0] ? String(res.content[0].text) : '';
      const value = await call(args);
      for (const rendered of [text, value]) {
        expect(rendered).toContain('recordsTotal=6534');
        expect(rendered).toContain('draw=1');
        expect(rendered).toContain(`GET ${f.capture.url}`);
        expect(new TextEncoder().encode(rendered).length).toBeLessThanOrEqual(4096);
      }
      expect(seen[0]).toBe(f.capture.url);
    } finally { await client.close(); await server.close(); }
  });

  it('ic4r_gene 按 locus 回放：两出口同一份文本与出处', async () => {
    const f = fixtureOf('gene');
    expect(f.capture.url).toContain('/ic4r/api/json/gene/IC4R-OSJ01G000600');
    const { isolated, call, seen } = harness(ic4r(), 'ic4r_gene', f.payload, f.capture.url);
    const args = { locus: 'IC4R-OSJ01G000600' };
    const { client, server } = await connect(isolated);
    try {
      const res = await client.callTool({ name: 'ic4r_gene', arguments: args });
      expect(res.isError).toBeFalsy();
      const text = res.content?.[0] && 'text' in res.content[0] ? String(res.content[0].text) : '';
      const value = await call(args);
      for (const rendered of [text, value]) {
        expect(rendered).toContain('IC4R-OSJ01G000600');
        expect(rendered).toContain('40S Ribosomal');
        expect(rendered).toContain(`GET ${f.capture.url}`);
        expect(new TextEncoder().encode(rendered).length).toBeLessThanOrEqual(4096);
      }
      expect(seen[0]).toBe(f.capture.url);
    } finally { await client.close(); await server.close(); }
  });

  it('单元素数组包裹按防御性兼容解包（明确模拟，非上游实测形态）', async () => {
    const f = fixtureOf('gene-list-array-wrap');
    expect(f.capture.simulated).toBe(true);
    expect(Array.isArray(f.payload)).toBe(true);
    const { isolated, call } = harness(ic4r(), 'ic4r_gene_list', f.payload, f.capture.url);
    const args = { chromosome: '1', start: 0, length: 2 };
    const { client, server } = await connect(isolated);
    try {
      const res = await client.callTool({ name: 'ic4r_gene_list', arguments: args });
      expect(res.isError).toBeFalsy();
      const text = res.content?.[0] && 'text' in res.content[0] ? String(res.content[0].text) : '';
      const value = await call(args);
      for (const rendered of [text, value]) {
        expect(rendered).toContain('recordsTotal=6534');
        expect(rendered).toContain(`GET ${f.capture.url}`);
      }
    } finally { await client.close(); await server.close(); }
  });

  it('多元素数组仍按结构漂移失败（不为未验证形态放宽）', async () => {
    const f = fixtureOf('gene-list-array-wrap');
    const multi = [f.payload[0], f.payload[0]];
    const { isolated, call } = harness(ic4r(), 'ic4r_gene_list', multi, f.capture.url);
    const args = { chromosome: '1', start: 0, length: 2 };
    const { client, server } = await connect(isolated);
    try {
      const res = await client.callTool({ name: 'ic4r_gene_list', arguments: args });
      expect(res.isError).toBe(true);
      const text = res.content?.[0] && 'text' in res.content[0] ? String(res.content[0].text) : '';
      expect(text).toContain(`request=GET ${f.capture.url}`);
      await expect(call(args)).rejects.toThrow(`request=GET ${f.capture.url}`);
    } finally { await client.close(); await server.close(); }
  });

  it('lncRNA 长序列整块省略且不截半条，两出口一致', async () => {
    const f = fixtureOf('lncrna');
    const sequence = String(f.payload.sequence);
    expect(sequence.length).toBeGreaterThan(1280);
    const { isolated, call } = harness(ic4r(), 'ic4r_lncrna', f.payload, f.capture.url);
    const args = { accession: 'IC4R-OSJ01Lnc000600.1' };
    const { client, server } = await connect(isolated);
    try {
      const res = await client.callTool({ name: 'ic4r_lncrna', arguments: args });
      expect(res.isError).toBeFalsy();
      const text = res.content?.[0] && 'text' in res.content[0] ? String(res.content[0].text) : '';
      const value = await call(args);
      for (const rendered of [text, value]) {
        expect(rendered).toContain('整条未展示');
        expect(rendered).toContain('不是上游没有序列');
        expect(rendered).not.toContain(sequence.slice(0, 40));
        expect(rendered).not.toContain(sequence.slice(-40));
        expect(rendered).toContain(`GET ${f.capture.url}`);
        expect(new TextEncoder().encode(rendered).length).toBeLessThanOrEqual(4096);
      }
    } finally { await client.close(); await server.close(); }
  });
});

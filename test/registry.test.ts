import { describe, expect, it } from 'vitest';

import { createRegistry, enabledSourcesFromEnv, registry } from '../src/sources/index.js';
import { ToolRegistry } from '../src/core/registry.js';
import type { SourceBundle } from '../src/core/types.js';

const goodManifest = {
  id: 'demo',
  displayName: '演示源',
  homepage: 'https://example.org',
  apiBase: 'https://example.org/api',
  tier: 'T1' as const,
  docs: 'https://example.org/api/docs',
  auth: 'none' as const,
  species: ['Arabidopsis thaliana'],
  network: 'direct' as const,
  probe: { path: '/ping' },
};

const goodTool = {
  name: 'demo_ping',
  description: '演示用的探活工具，返回上游 /ping 的结果，用于验证注册表规则。',
  parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
  async run() {
    return { text: 'pong', meta: { sourceId: 'demo', url: '', status: 200, durationMs: 0 } };
  },
};

describe('注册表硬校验', () => {
  it('默认注册表装配七源32工具+2元工具并保留源级断言', () => {
    const built = createRegistry();
    expect(built.listSources().map((bundle) => bundle.manifest.id)).toEqual(['wheatomics', 'strawberry', 'gwh', 'icg', 'ic4r', 'gramene', 'scod']);
    expect(built.listTools()).toHaveLength(34);
    const source = built.getSource('strawberry');
    expect(typeof source?.validateProbe).toBe('function');
    expect(() => source?.validateProbe?.({})).toThrow();
    for (const id of ['gwh', 'icg', 'ic4r', 'gramene', 'scod']) {
      const check = built.getSource(id)?.validateProbe;
      expect(typeof check).toBe('function');
      expect(() => check!({})).toThrow();
    }
    // 导出的单例与工厂结果一致（避免两处装配漂移）
    expect(registry.listTools().map((t) => t.name)).toEqual(built.listTools().map((t) => t.name));
  });

  it('工具名必须以源 id 为前缀', () => {
    const reg = new ToolRegistry();
    const bundle: SourceBundle = {
      manifest: goodManifest,
      tools: [{ ...goodTool, name: 'other_ping' }],
    };
    expect(() => reg.register(bundle)).toThrow(/必须以源 id 前缀/);
  });

  it('同一批里工具重名直接抛（原写法测的其实是"源 id 重复"，测错了分支）', () => {
    const reg = new ToolRegistry();
    expect(() => reg.register({ manifest: goodManifest, tools: [goodTool, { ...goodTool }] })).toThrow(/工具名重复/);
  });

  it('T3 源不许挂工具（没有可编程入口就别写代码）', () => {
    const reg = new ToolRegistry();
    expect(() =>
      reg.register({ manifest: { ...goodManifest, tier: 'T3' }, tools: [goodTool] }),
    ).toThrow(/T3/);
  });

  it('T1/T2 源不许空手进来', () => {
    const reg = new ToolRegistry();
    expect(() => reg.register({ manifest: goodManifest, tools: [] })).toThrow(/没有任何工具/);
  });

  it('T1 源必须给出文档地址', () => {
    const reg = new ToolRegistry();
    const { docs: _docs, ...withoutDocs } = goodManifest;
    expect(() =>
      reg.register({ manifest: { ...withoutDocs, tier: 'T1' }, tools: [goodTool] }),
    ).toThrow(/必须给出 docs/);
  });

  it('apiBase 不许带尾斜杠', () => {
    const reg = new ToolRegistry();
    expect(() =>
      reg.register({ manifest: { ...goodManifest, apiBase: 'https://example.org/api/' }, tools: [goodTool] }),
    ).toThrow(/尾斜杠|以 \//);
  });
});

/**
 * 「各团队独立入口、边做边积累」在代码上的落点：
 * 同一份仓库，别人只启用自己关心的源，不该被迫全量加载。
 */
describe('按需启用源子集', () => {
  it('不传 enabled = 全部启用', () => {
    expect(createRegistry().listSources()).toHaveLength(7);
  });

  it('传 enabled = 只启用指定的源', () => {
    const built = createRegistry({ enabled: ['wheatomics'] });
    expect(built.listSources().map((bundle) => bundle.manifest.id)).toEqual(['wheatomics']);
    expect(built.listTools().filter((t) => !t.name.startsWith('hub_'))).toHaveLength(11);
  });

  it('空数组按「全启用」处理，不当成「一个都不要」', () => {
    expect(createRegistry({ enabled: [] }).listTools()).toHaveLength(34);
    expect(createRegistry({ enabled: ['  '] }).listTools()).toHaveLength(34);
    expect(createRegistry({ enabled: ['strawberry'] }).listTools().filter((t) => !t.name.startsWith('hub_'))).toHaveLength(5);
  });

  it('IC4R子集仅暴露六个约定工具', () => {
    expect(createRegistry({ enabled: ['ic4r'] }).listTools().map(t => t.name).filter((n) => !n.startsWith('hub_'))).toEqual([
      'ic4r_gene', 'ic4r_annotation', 'ic4r_circrna', 'ic4r_lncrna', 'ic4r_id_convert', 'ic4r_gene_list',
    ]);
  });

  it('Gramene子集仅暴露四个约定工具', () => {
    expect(createRegistry({ enabled: ['gramene'] }).listTools().map(t => t.name).filter((n) => !n.startsWith('hub_'))).toEqual([
      'gramene_search', 'gramene_gene', 'gramene_expression', 'gramene_taxonomy',
    ]);
  });

  it('GWH/ICG子集仅暴露四个约定工具', () => {
    expect(createRegistry({ enabled: ['gwh', 'icg'] }).listTools().map(t => t.name).filter((n) => !n.startsWith('hub_'))).toEqual([
      'gwh_assembly_lookup', 'gwh_project_sample_lookup', 'icg_lookup', 'icg_species_list',
    ]);
  });

  it('未知 id 直接抛，并在错误里列出可用源', () => {
    expect(() => createRegistry({ enabled: ['wheatomic'] })).toThrow(/未知的源 id：wheatomic/);
    expect(() => createRegistry({ enabled: ['wheatomic'] })).toThrow(/已登记的源：wheatomics/);
  });

  it('从环境变量解析启用清单（逗号/分号/空白都认）', () => {
    expect(enabledSourcesFromEnv({ PLANTOMICS_SOURCES: 'a,b' } as NodeJS.ProcessEnv)).toEqual(['a', 'b']);
    expect(enabledSourcesFromEnv({ PLANTOMICS_SOURCES: 'a; b  c' } as NodeJS.ProcessEnv)).toEqual(['a', 'b', 'c']);
  });

  it('环境变量为空 / 未设 = undefined（走全启用）', () => {
    expect(enabledSourcesFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(enabledSourcesFromEnv({ PLANTOMICS_SOURCES: '   ' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('元工具入口（检索层备用）', () => {
  const mk = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    description: '元工具：测试注册表入口，不对应任何数据库',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return { text: 'ok', meta: { sourceId: 'meta', request: 'local', url: 'local', status: 200, durationMs: 1, at: new Date().toISOString() } };
    },
    ...extra,
  });

  it('注册后出现在 listTools，并单独列在 listMetaTools；源数不变', () => {
    const r = new ToolRegistry();
    const beforeSources = r.listSources().length;
    r.registerMetaTool(mk('hub_find_sources') as never);
    expect(r.listTools().map((t) => t.name)).toContain('hub_find_sources');
    expect(r.listMetaTools().map((t) => t.name)).toEqual(['hub_find_sources']);
    expect(r.listSources().length).toBe(beforeSources);
  });

  it('不以 hub_ 开头 → 抛错（元工具必须靠前缀区分）', () => {
    const r = new ToolRegistry();
    expect(() => r.registerMetaTool(mk('find_sources') as never)).toThrow(/hub_/);
  });

  it('重复注册同名元工具 → 抛错', () => {
    const r = new ToolRegistry();
    r.registerMetaTool(mk('hub_find_sources') as never);
    expect(() => r.registerMetaTool(mk('hub_find_sources') as never)).toThrow(/重复/);
  });


  it('命名空间必须是 hub_[a-z0-9_]*：大写或连字符一律拒绝', () => {
    const r = new ToolRegistry();
    expect(() => r.registerMetaTool(mk('hub_FindSources') as never)).toThrow(/hub_\[a-z0-9_\]/);
    expect(() => r.registerMetaTool(mk('hub_find-sources') as never)).toThrow(/hub_\[a-z0-9_\]/);
  });

  it('名字超过 43 字符 → 拒绝（宿主会截断加哈希，工具名不可预测）', () => {
    const r = new ToolRegistry();
    const long = 'hub_' + 'a'.repeat(45);
    expect(() => r.registerMetaTool(mk(long) as never)).toThrow(/不可预测/);
  });

  it('名字恰好 43 字符 → 通过（边界不误杀）', () => {
    const r = new ToolRegistry();
    const exact = 'hub_' + 'a'.repeat(39);
    expect(exact.length).toBe(43);
    expect(() => r.registerMetaTool(mk(exact) as never)).not.toThrow();
  });

  it('元工具消息不进源清单（getSource 查不到）', () => {
    const r = new ToolRegistry();
    r.registerMetaTool(mk('hub_status') as never);
    expect(r.getSource('hub')).toBeUndefined();
    expect(r.getTool('hub_status')).toBeTruthy();
  });

  it('描述过短 / 非 object schema → 抛错（与源工具同一套下限）', () => {
    const r = new ToolRegistry();
    expect(() => r.registerMetaTool(mk('hub_x', { description: 'short' }) as never)).toThrow(/description/);
    expect(() => r.registerMetaTool(mk('hub_y', { parameters: { type: 'string' } }) as never)).toThrow(/object/);
  });
});

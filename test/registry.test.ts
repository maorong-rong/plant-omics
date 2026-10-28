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
  it('默认注册表装配四源15工具并保留源级断言', () => {
    const built = createRegistry();
    expect(built.listSources().map((bundle) => bundle.manifest.id)).toEqual(['wheatomics', 'strawberry', 'gwh', 'icg']);
    expect(built.listTools()).toHaveLength(15);
    const source = built.getSource('strawberry');
    expect(typeof source?.validateProbe).toBe('function');
    expect(() => source?.validateProbe?.({})).toThrow();
    for (const id of ['gwh', 'icg']) {
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
    expect(createRegistry().listSources()).toHaveLength(4);
  });

  it('传 enabled = 只启用指定的源', () => {
    const built = createRegistry({ enabled: ['wheatomics'] });
    expect(built.listSources().map((bundle) => bundle.manifest.id)).toEqual(['wheatomics']);
    expect(built.listTools()).toHaveLength(6);
  });

  it('空数组按「全启用」处理，不当成「一个都不要」', () => {
    expect(createRegistry({ enabled: [] }).listTools()).toHaveLength(15);
    expect(createRegistry({ enabled: ['  '] }).listTools()).toHaveLength(15);
    expect(createRegistry({ enabled: ['strawberry'] }).listTools()).toHaveLength(5);
  });

  it('GWH/ICG子集仅暴露四个约定工具', () => {
    expect(createRegistry({ enabled: ['gwh', 'icg'] }).listTools().map(t => t.name)).toEqual([
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

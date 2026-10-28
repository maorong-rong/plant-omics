import { describe, expect, it } from 'vitest';

import { apply, inject, name } from '../src/dsh/index.js';
import { registry } from '../src/sources/index.js';

/**
 * DSH 插件的装配测试。
 *
 * 刻意**不改动本机 dsh 配置**：用一个假 ctx 验证「工具确实被注册成 DSH 要的形状」。
 * 真装进 profile 是另一回事（会动用户环境），不进自动化测试。
 *
 * 失败语义（审查 R04 之后的定案）：
 *   - 配置错误（未知源 / 筛空）→ **apply() 同步抛**（加载期失败，宿主一定看得见）
 *   - 全部注册失败 → 抛；部分失败 → 告警 + 保留可用部分（局部失效不升级成全局失效）
 *   - 拿不到 tools 服务 → 有 logger 就告警，没 logger 才抛（没有别的通道可用）
 */

interface RegisteredTool {
  name: string;
  description: string;
  parameters: { type?: string };
  output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
  execute: (args: Record<string, unknown>, exec?: { signal?: AbortSignal }) => Promise<{ text: string }>;
}

function fakeContext(options: { withLogger?: boolean; throwOn?: (toolName: string) => boolean } = {}) {
  const registered: RegisteredTool[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const { withLogger = true } = options;

  const service = {
    register: (definition: unknown) => {
      const def = definition as RegisteredTool;
      if (options.throwOn?.(def.name)) throw new Error('宿主拒收');
      registered.push(def);
    },
  };

  const ctx: Record<string, unknown> = {
    inject(names: string[], callback: (scope: unknown) => void): void {
      expect(names).toContain('tools');
      callback({ tools: service });
    },
  };

  if (withLogger) {
    ctx.logger = {
      info: (...args: unknown[]) => infos.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    };
  }

  return { ctx: ctx as never, registered, warnings, infos };
}

describe('DSH 插件出口', () => {
  it('模块导出符合 DSH 契约', () => {
    expect(name).toBe('plant-omics');
    expect(Array.isArray(inject)).toBe(true);
    expect(typeof apply).toBe('function');
  });

  it('注册的工具数与注册表一致，且都带源前缀', () => {
    const { ctx, registered } = fakeContext();
    apply(ctx);

    expect(registered).toHaveLength(registry.listTools().length);
    for (const tool of registered) {
      expect(tool.name.startsWith('wheatomics_')).toBe(true);
      expect(tool.parameters.type).toBe('object');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('每个工具都有 output.schema 与能产出 text 块的 render', () => {
    const { ctx, registered } = fakeContext();
    apply(ctx);

    for (const tool of registered) {
      expect(tool.output.schema).toBeTruthy();
      expect(tool.output.render({}, { text: '示例输出' })).toEqual([{ type: 'text', text: '示例输出' }]);
      expect(tool.output.render({}, null)).toEqual([{ type: 'text', text: '' }]);
    }
  });

  it('enabled=false 时一个都不注册', () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { enabled: false });
    expect(registered).toHaveLength(0);
  });

  it('sources 配置只启用指定源', () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { sources: ['wheatomics'] });
    expect(registered).toHaveLength(6);
  });

  it('sources 写错 id 时**抛错**，且一个都不注册（审查 R04）', () => {
    const { ctx, registered } = fakeContext();
    expect(() => apply(ctx, { sources: ['wheatomic'] })).toThrow(/未知的源 id/);
    expect(registered).toHaveLength(0);
  });

  it('部分工具注册失败时保留其余工具，但必须告警', () => {
    const { ctx, registered, warnings } = fakeContext({
      throwOn: (toolName) => toolName === 'wheatomics_gene_detail',
    });
    apply(ctx);

    expect(registered).toHaveLength(5);
    expect(warnings.join('\n')).toContain('1/6 个工具注册失败');
  });

  it('全部工具注册失败时抛错（插件等于没装，不许静默）', () => {
    const { ctx } = fakeContext({ throwOn: () => true });
    expect(() => apply(ctx)).toThrow(/6\/6 个工具注册失败/);
  });

  it('拿不到 tools 服务：有 logger 就告警，不炸宿主', () => {
    const warnings: string[] = [];
    const ctx = {
      inject(_names: string[], callback: (scope: unknown) => void): void {
        callback({});
      },
      logger: { warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')) },
    } as never;

    expect(() => apply(ctx)).not.toThrow();
    expect(warnings.join('\n')).toContain('tools');
  });

  it('拿不到 tools 服务且没有 logger 时才抛（没有别的通道可用）', () => {
    const ctx = {
      inject(_names: string[], callback: (scope: unknown) => void): void {
        callback({});
      },
    } as never;

    expect(() => apply(ctx)).toThrow(/tools 服务/);
  });
});

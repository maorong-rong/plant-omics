import { readFileSync } from 'node:fs';

import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

import { apply, inject, name } from '../src/dsh/index.js';
import { registry } from '../src/sources/index.js';

/**
 * DSH 插件出口测试 —— **薄壳形态**。
 *
 * 断言的是"插件不再提供工具"这件事本身，而不是把期望数量从 25 改成 0：
 *   1. 工具由远程 MCP 服务提供（`cordis.patch.yml` 里的 dsh-mcp-client 条目）；
 *   2. 插件若哪天又去注册工具，测试必须红——否则两套真相会悄悄回来。
 *
 * 覆盖强度声明（据实说）：本文件只覆盖"插件侧零注册 + patch 声明结构"。
 * 它**不是**双出口验证——`test/mcp.test.ts` 里改成直调 `invokeTool` 的那部分
 * 只保留业务断言，不等于"DSH 出口仍然可用"。真实链路是 服务 → MCP，
 * 由 `test/service.test.ts` 覆盖；真实宿主装载另算。
 */

interface FakeRegistered {
  name: string;
  execute: unknown;
}

function fakeContext(options: { withLogger?: boolean } = {}) {
  const registered: FakeRegistered[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const { withLogger = true } = options;

  const ctx: Record<string, unknown> = {
    // 故意提供 tools 服务：即使宿主把服务递到手上，薄插件也不该注册任何工具
    inject(names: string[], callback: (scope: unknown) => void): void {
      if (!names.includes('tools')) throw new Error(`意外注入请求：${names.join(',')}`);
      callback({ tools: { register: (def: FakeRegistered) => registered.push(def) } });
    },
    get: () => ({ register: (def: FakeRegistered) => registered.push(def) }),
  };

  if (withLogger) {
    ctx.logger = {
      info: (...args: unknown[]) => infos.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    };
  }

  return { ctx: ctx as never, registered, warnings, infos };
}

describe('DSH 插件出口（薄壳）', () => {
  it('模块导出符合宿主契约', () => {
    expect(name).toBe('plant-omics');
    expect(Array.isArray(inject)).toBe(true);
    expect(typeof apply).toBe('function');
  });

  it('不注册任何工具——即使宿主提供了 tools 服务', () => {
    const { ctx, registered } = fakeContext();
    apply(ctx);
    expect(registered).toHaveLength(0);
  });

  it('反例：注册表里有 25 个工具，插件也不转手注册（工具不属于插件）', () => {
    expect(registry.listTools().length).toBeGreaterThan(0);
    const { ctx, registered } = fakeContext();
    apply(ctx);
    expect(registered).toHaveLength(0);
  });

  it('enabled=false 时同样不注册，且不报错', () => {
    const { ctx, registered } = fakeContext();
    expect(() => apply(ctx, { enabled: false })).not.toThrow();
    expect(registered).toHaveLength(0);
  });

  it('debug=true 时留下装配痕迹（排查"装了但没反应"用）', () => {
    const { ctx, infos } = fakeContext();
    apply(ctx, { debug: true });
    expect(infos.join('\n')).toContain('不注册工具');
  });

  it('没有 logger 也不炸：薄插件不依赖日志通道', () => {
    const { ctx } = fakeContext({ withLogger: false });
    expect(() => apply(ctx, { debug: true })).not.toThrow();
  });
});

describe('cordis.patch.yml：真实 YAML 解析 + 身份一致性', () => {
  const patchText = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string };

  /**
   * 用真实 YAML 解析器解析，而不是"字符串包含就算过"。
   * 起因：`headers` 曾写成未加引号的 `!!js ... { ... }`，字符串断言全过，
   * 但宿主解析 patch 时直接报 "Nested mappings are not allowed in compact
   * mappings"，加载失败。`!!js` 是宿主的自定义标签，这里用同语义的标签兜住，
   * 目的是校验 **YAML 结构** 是否合法。
   */
  function parsePatch() {
    const doc = parseDocument(patchText, {
      customTags: [{
        tag: '!!js',
        resolve: (value: string) => String(value),
      }],
    });
    return doc;
  }

  it('YAML 语法没有错误（字符串包含不算过）', () => {
    const doc = parsePatch();
    const errors = doc.errors.map((e) => `${e.linePos?.[0]?.line ?? '?'}: ${e.message.split('\n')[0]}`);
    expect(errors).toEqual([]);
  });

  it('自身条目 name 等于真实包名（宿主对 unknown name 静默跳过）', () => {
    const doc = parsePatch();
    const entries = (doc.toJS() as Array<{ insert: Array<{ id: string; name: string }> }>)[0].insert;
    const self = entries.find((entry) => entry.id === 'plant-omics');
    expect(self, 'patch 里必须有一条本插件自身条目').toBeTruthy();
    expect(self!.name).toBe(pkg.name);
  });

  it('插入了宿主 MCP 客户端条目，指向 Streamable HTTP', () => {
    const doc = parsePatch();
    const entries = (doc.toJS() as Array<{ insert: Array<{ id: string; name: string; config?: Record<string, unknown> }> }>)[0].insert;
    const mcp = entries.find((entry) => entry.name === '@deepseek-ai/dsh-mcp-client');
    expect(mcp, 'patch 必须插入宿主 MCP 客户端条目').toBeTruthy();
    expect(mcp!.config?.transport).toBe('streamable-http');
    expect(mcp!.config?.serverName).toBe('plantomics-hub');
    expect(mcp!.config?.failOnStartupError).toBe(true);
  });

  it('token 以 Bearer 形式放进 headers，且未硬编码任何真实值', () => {
    const doc = parsePatch();
    const entries = (doc.toJS() as Array<{ insert: Array<{ name: string; config?: Record<string, unknown> }> }>)[0].insert;
    const mcp = entries.find((entry) => entry.name === '@deepseek-ai/dsh-mcp-client')!;
    const headers = String(mcp.config?.headers ?? '');
    expect(headers).toContain('Bearer ');
    expect(headers).toContain('PLANTOMICS_HUB_TOKEN');
    // 不许出现像真 token 的字面量
    expect(headers).not.toMatch(/Bearer [A-Za-z0-9_-]{16,}/);
  });

  it('不把工具注册回来：patch 里没有 tools 注册声明', () => {
    const doc = parsePatch();
    expect(JSON.stringify(doc.toJS())).not.toContain('"tools"');
  });
});

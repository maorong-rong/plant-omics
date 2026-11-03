import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { optionalIntArg, parseNumericToken } from '../src/core/shape.js';

import { DEFAULT_MAX_BYTES, truncateToBytes, utf8Bytes } from '../src/core/format.js';
import { validateArgs } from '../src/core/invoke.js';
import { ToolRegistry } from '../src/core/registry.js';
import { optionalArrayField, requireArrayField, requireStringArg, splitIds } from '../src/core/shape.js';
import { SERVER_INFO } from '../src/mcp/server.js';
import type { SourceBundle, ToolDefinition } from '../src/core/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = {
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

const tool = (name = 'demo_ping'): ToolDefinition => ({
  name,
  description: '演示用的探活工具，返回固定文本，用于验证注册表与校验规则。',
  parameters: {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: [],
    additionalProperties: false,
  },
  async run() {
    return { text: 'pong', meta: { sourceId: 'demo', request: 'GET /ping', url: '', status: 200, durationMs: 0, at: '' } };
  },
});

describe('输出字节预算（审查 R05）', () => {
  it('按 UTF-8 字节计数，不是按字符数', () => {
    expect(utf8Bytes('中文')).toBe(6);
    expect(utf8Bytes('ab')).toBe(2);
  });

  it('截断不会把多字节字符切成半个', () => {
    const { text, truncated } = truncateToBytes('中文', 4);
    expect(text).toBe('中'); // 3 字节，再放一个"文"就 6 字节超预算
    expect(truncated).toBe(true);
    expect(utf8Bytes(text)).toBeLessThanOrEqual(4);
  });

  it('未超预算时原样返回', () => {
    const { text, truncated } = truncateToBytes('中文', DEFAULT_MAX_BYTES);
    expect(text).toBe('中文');
    expect(truncated).toBe(false);
  });
});

describe('上游结构校验（审查 R03）', () => {
  it('字段缺失 → 抛契约错误，不许退化成空数组', () => {
    expect(() => requireArrayField({ items: [] }, 'records', 'https://e/x', '测试')).toThrow(/records/);
    expect(() => requireArrayField({ items: [] }, 'records', 'https://e/x', '测试')).toThrow(/契约/);
  });

  it('字段类型不对 → 抛契约错误', () => {
    expect(() => requireArrayField({ records: 'oops' }, 'records', 'https://e/x', '测试')).toThrow(/不是数组/);
  });

  it('合法空数组 → 正常返回空数组（这才是「查无结果」）', () => {
    expect(requireArrayField({ records: [] }, 'records', 'https://e/x', '测试')).toEqual([]);
  });

  it('可选字段缺失 → undefined，而不是抛', () => {
    expect(optionalArrayField({}, 'points', 'https://e/x', '测试')).toBeUndefined();
  });
});

describe('入参校验（审查 R08 / A8）', () => {
  it('对象参数被拒，不会变成 [object Object] 发出去', () => {
    expect(() => requireStringArg({ q: { a: 1 } }, 'q')).toThrow(/必须是字符串/);
  });

  it('数组参数同样被拒', () => {
    expect(() => requireStringArg({ q: ['a'] }, 'q')).toThrow(/必须是字符串/);
  });

  it('ID 超过上限直接拒，而不是拼出超长 URL', () => {
    const many = Array.from({ length: 5 }, (_, i) => `G${i}`).join(',');
    expect(() => splitIds(many, 3, 'ids')).toThrow(/最多 3 个/);
  });

  it('未知参数被拒（抓「参数改名后旧调用方还在传旧名」）', () => {
    const def = tool();
    expect(() => validateArgs(def, { q: 'x' })).not.toThrow();
    expect(() => validateArgs(def, { since_days: 1 })).toThrow(/未知参数：since_days/);
  });

  it('缺必填参数被拒', () => {
    const def: ToolDefinition = { ...tool(), parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } };
    expect(() => validateArgs(def, {})).toThrow(/缺少必填参数 q/);
  });
});

describe('注册表原子性（审查 P2）', () => {
  it('同一批里工具重名时，一个都不落库', () => {
    const reg = new ToolRegistry();
    const bundle: SourceBundle = { manifest, tools: [tool(), tool()] };
    expect(() => reg.register(bundle)).toThrow(/工具名重复/);
    // 关键：抛错之后注册表里不能留下半个源或半个工具
    expect(reg.listTools()).toHaveLength(0);
    expect(reg.listSources()).toHaveLength(0);
  });
});

describe('版本单一来源', () => {
  it('SERVER_INFO.version 与 package.json 一致', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(SERVER_INFO.version).toBe(pkg.version);
  });
});

describe('parseNumericToken：没给 / 给了空 / 给错 / 给了（AGENTS §16）', () => {
  it('缺失与空串必须分开，且都不许落成 0', () => {
    expect(parseNumericToken(undefined).kind).toBe('absent');
    expect(parseNumericToken(null).kind).toBe('absent');
    expect(parseNumericToken('').kind).toBe('empty');        // 空串不是 absent
    expect(parseNumericToken('   ').kind).toBe('empty');     // 纯空白也不是
    // 关键：'0' 必须是 value 0，与上面的 empty 分开
    expect(parseNumericToken('0')).toEqual({ kind: 'value', value: 0 });
    expect(parseNumericToken(0)).toEqual({ kind: 'value', value: 0 });
  });

  it('给错（非数字 / 布尔 / 对象）是 invalid，不是 absent', () => {
    expect(parseNumericToken('abc').kind).toBe('invalid');
    expect(parseNumericToken(true).kind).toBe('invalid');
    expect(parseNumericToken([]).kind).toBe('invalid');
    expect(parseNumericToken({}).kind).toBe('invalid');
    expect(parseNumericToken(Number.NaN).kind).toBe('invalid');
  });

  it('integer 档拒绝小数与科学计数，decimal 档接受小数', () => {
    expect(parseNumericToken('1.5', 'integer').kind).toBe('invalid');
    expect(parseNumericToken('1.5')).toEqual({ kind: 'value', value: 1.5 });
    expect(parseNumericToken('499900', 'integer')).toEqual({ kind: 'value', value: 499900 });
    expect(parseNumericToken(1.5, 'integer').kind).toBe('invalid');
    // 超长数字：过正则、Number() 得 1e+21、isFinite 仍为 true——必须按不安全整数拒掉
    expect(parseNumericToken('999999999999999999999', 'integer').kind).toBe('invalid');
    expect(parseNumericToken(1e21, 'integer').kind).toBe('invalid');
    // 边界内仍要正常：Number.MAX_SAFE_INTEGER 是合法整数
    expect(parseNumericToken(String(Number.MAX_SAFE_INTEGER), 'integer'))
      .toEqual({ kind: 'value', value: Number.MAX_SAFE_INTEGER });
  });
});

describe('optionalIntArg：纯空白也算「没给」', () => {
  it('空串与纯空白都回落到 fallback，不变成 0', () => {
    expect(optionalIntArg({ n: '' }, 'n', 7, 0, 10)).toBe(7);
    expect(optionalIntArg({ n: '   ' }, 'n', 7, 0, 10)).toBe(7);   // 旧实现这里会得到 0
    expect(optionalIntArg({ n: '0' }, 'n', 7, 0, 10)).toBe(0);     // 真的给了 0，必须是 0
    // 给错了要抛错，不能兜底成 fallback 或 0
    expect(() => optionalIntArg({ n: 'abc' }, 'n', 7, 0, 10)).toThrow();
  });
});

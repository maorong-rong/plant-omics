import { describe, expect, it } from 'vitest';

import { DEFAULT_SET_SOURCES } from '../src/service/budget.js';
import {
  MAX_SUBSCRIPTION_TOOLS,
  TOKENS_PER_TOOL,
  buildBudgetReport,
  collectCounts,
  renderStatsText,
} from '../scripts/counts.mjs';

/**
 * 预算判定测试（v2.3 源市场口径）。
 *
 * 数量事实的唯一实现在 `scripts/counts.mjs`（`stats.mjs` 已改为薄壳）。
 * 这里直接吃纯函数、注入假注册表：不读 `dist/`（`npm test` 跑在 `npm run build` 之前，
 * 干净克隆没有 dist）、不联网、不改共享文件。
 *
 * 口径要点：**全库只报数、不拦截**；唯一失败条件是**指定的订阅集** > 80。
 */

function fakeRegistry(counts: number[]) {
  return {
    listSources: () =>
      counts.map((tools, index) => ({
        // 前几个用默认集清单里的真实 id：默认集工具数按清单算，不按全库算
        manifest: { id: DEFAULT_SET_SOURCES[index] ?? `s${index}`, displayName: `S${index}`, tier: 'T1' },
        tools: Array.from({ length: tools }),
      })),
    listTools: () => Array.from({ length: counts.reduce((sum, value) => sum + value, 0) }),
    listMetaTools: () => [],
  };
}

function run(
  counts: number[],
  subscription?: { requested: string[]; sources: number; tools: number },
) {
  const report = buildBudgetReport(
    collectCounts(fakeRegistry(counts), { buildInfo: null }),
    subscription,
  );
  return { code: report.overBudget ? 1 : 0, report, text: renderStatsText(report) };
}

describe('全库只报数、不拦截（v2.3 §10.2.3）', () => {
  it('21 源、41 工具不再失败', () => {
    expect(run(Array.from({ length: 21 }, () => 1)).code).toBe(0);
    expect(run([41]).code).toBe(0);
  });

  it('全库再大也不失败（旧口径 20/40 已废止）', () => {
    const { code, report } = run(Array.from({ length: 40 }, () => 3));
    expect(report.sources).toBe(40);
    expect(report.tools).toBe(120);
    expect(code).toBe(0);
  });

  it('默认集超 40 只警示、不失败', () => {
    const { code, report, text } = run([41]);
    expect(code).toBe(0);
    expect(report.overDefaultSuggestion).toBe(true);
    expect(text).toContain('已超建议');
    expect(text).toContain('仅警示，不失败');
  });

  it('文本写明「只报数，不拦截」与唯一硬阈值', () => {
    const { text } = run([6, 5]);
    expect(text).toContain('只报数，不拦截');
    expect(text).toContain(`硬上限 ${MAX_SUBSCRIPTION_TOOLS}`);
  });
});

describe('唯一硬阈值：订阅集 ≤ 80 工具（v2.3 §10.1/§10.2.1）', () => {
  it('未指定订阅集时只报默认集，report.subscription 为 null', () => {
    const { report } = run([41]);
    expect(report.subscription).toBeNull();
    expect(report.overBudget).toBe(false);
  });

  it('订阅集等于 80 通过、81 失败', () => {
    const at = run([40, 40], { requested: ['s0', 's1'], sources: 2, tools: 80 });
    expect(at.code).toBe(0);
    const over = run([40, 41], { requested: ['s0', 's1'], sources: 2, tools: 81 });
    expect(over.code).toBe(1);
    expect(over.text).toContain('❌');
  });

  it('订阅集判定只看订阅集大小，不看全库大小', () => {
    // 全库 100 工具，但订阅集只有 10：必须通过
    const { code, report } = run([60, 40], { requested: ['s1'], sources: 1, tools: 40 });
    expect(report.tools).toBe(100);
    expect(code).toBe(0);
  });

  it('token 估算按每工具 280 折算，并给出 80 工具的代价', () => {
    const { report, text } = run([37]);
    expect(report.tokenEstimate).toBe(37 * TOKENS_PER_TOOL);
    expect(text).toContain('默认集约');
    expect(text).toContain(`${MAX_SUBSCRIPTION_TOOLS * TOKENS_PER_TOOL} token`);
    // 百分比口径归 AGENTS §10.2，脚本不另算一套
    expect(text).toContain('§10.2');
    expect(text).not.toContain('32K 的');
  });

  it('指定订阅集时，token 报的是订阅集而不是全库', () => {
    const { report, text } = run([60, 40], { requested: ['s1'], sources: 1, tools: 40 });
    expect(report.tokenEstimate).toBe(100 * TOKENS_PER_TOOL);
    expect(report.subscriptionTokens).toBe(40 * TOKENS_PER_TOOL);
    expect(text).toContain('订阅集约');
    expect(text).not.toContain('默认集约');
  });
});

describe('注册表口径自洽（防止总数与逐源数不是同一份算法）', () => {
  it('listTools 与 逐源+元工具 不一致时直接抛', () => {
    const inconsistent = {
      listSources: () => [
        { manifest: { id: 'a', displayName: 'A', tier: 'T1' }, tools: [{ name: 'a_x' }] },
      ],
      listTools: () => Array.from({ length: 7 }),
      listMetaTools: () => [],
    };
    expect(() => collectCounts(inconsistent, { buildInfo: null })).toThrow(/不自洽/);
  });

  it('元工具计入工具总数、不计入源数', () => {
    const registry = {
      listSources: () => [
        { manifest: { id: 'a', displayName: 'A', tier: 'T1' }, tools: [{ name: 'a_x' }] },
      ],
      listTools: () => [{ name: 'a_x' }, { name: 'hub_status' }],
      listMetaTools: () => [{ name: 'hub_status' }],
    };
    const counts = collectCounts(registry, { buildInfo: null });
    expect(counts.sources).toBe(1);
    expect(counts.sourceTools).toBe(1);
    expect(counts.metaTools).toBe(1);
    expect(counts.tools).toBe(2);
  });
});

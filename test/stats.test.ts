import { describe, expect, it } from 'vitest';

import { buildBudgetReport, collectCounts, renderStatsText } from '../scripts/counts.mjs';

/**
 * 预算判定测试。
 *
 * 数量事实的唯一实现在 `scripts/counts.mjs`（`stats.mjs` 已改为薄壳）。
 * 这里直接吃纯函数、注入假注册表：不读 `dist/`（`npm test` 跑在 `npm run build` 之前，
 * 干净克隆没有 dist）、不联网、不改共享文件。
 */

function fakeRegistry(counts: number[]) {
  return {
    listSources: () =>
      counts.map((tools, index) => ({
        manifest: { id: `s${index}`, displayName: `S${index}`, tier: 'T1' },
        tools: Array.from({ length: tools }),
      })),
    listTools: () => Array.from({ length: counts.reduce((sum, value) => sum + value, 0) }),
    listMetaTools: () => [],
  };
}

function run(counts: number[]) {
  const report = buildBudgetReport(collectCounts(fakeRegistry(counts), { buildInfo: null }));
  return { code: report.overBudget ? 1 : 0, report, text: renderStatsText(report) };
}

describe('数量硬阈值与容量假设分离（模拟源）', () => {
  it('每源2工具不按最低4拒绝', () => {
    const { code, report } = run([2, 2]);
    expect(code).toBe(0);
    expect(report.tools).toBe(4);
    expect(report.perSource[0]?.tools).toBe(2);
    expect(report.capacityEstimateAssumption).toEqual({
      toolsPerSourceLow: 4,
      toolsPerSourceHigh: 8,
      isMinimumRequirement: false,
      bindingConstraintToolsPerSource: 8,
    });
  });

  it('20源各2工具、总数40仍通过，不因估算过线而失败', () => {
    const { code, report } = run(Array.from({ length: 20 }, () => 2));
    expect(code).toBe(0);
    expect(report.overBudget).toBe(false);
    expect(report.sources).toBe(20);
    expect(report.tools).toBe(40);
  });

  it('21源或41工具仍非零失败', () => {
    expect(run(Array.from({ length: 21 }, () => 1)).code).toBe(1);
    expect(run([41]).code).toBe(1);
  });

  it('文本和JSON都明确假设而非最低数量要求', () => {
    const { code, text } = run([6, 5]);
    expect(code).toBe(0);
    expect(text).toContain('情景估算');
    expect(text).toContain('4不是每源最低工具数');
    expect(text).toContain('假设');
    expect(text).not.toContain('到不了 20 个源');
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

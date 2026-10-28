import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../scripts/stats.mjs', import.meta.url), 'utf8');

/** 隔离注入模拟注册表，不读旧dist、不联网、不修改共享文件。 */
function run(counts: number[], json = true) {
  let output = '';
  const process = { argv: json ? ['node', 'stats', '--json'] : ['node', 'stats'],
    stdout: { write: (text: string) => { output += text; } }, exitCode: 0 };
  const importLine = "import { createRegistry } from '../dist/sources/index.js';";
  if (!source.includes(importLine)) throw new Error('stats入口改变，需更新测试注入点');
  vm.runInNewContext(source.replace(importLine, ''), { process,
    createRegistry: () => ({
      listSources: () => counts.map((tools, i) => ({ manifest: { id: `s${i}`, displayName: `S${i}`, tier: 'T1' }, tools: Array(tools) })),
      listTools: () => Array(counts.reduce((a, b) => a + b, 0)),
    }),
  });
  return { code: process.exitCode, output, report: json ? JSON.parse(output) : undefined };
}

describe('数量硬阈值与容量假设分离（模拟源）', () => {
  it('每源2工具不按最低4拒绝', () => {
    const { code, report } = run([2, 2]);
    expect(code).toBe(0); expect(report.tools).toBe(4);
    expect(report.perSource[0].tools).toBe(2);
    expect(report.capacityEstimateAssumption).toEqual({ toolsPerSourceLow: 4, toolsPerSourceHigh: 8,
      isMinimumRequirement: false, bindingConstraintToolsPerSource: 8 });
  });
  it('20源各2工具、总数40仍通过，不因估算过线而失败', () => {
    const { code, report } = run(Array(20).fill(2));
    expect(code).toBe(0); expect(report.overBudget).toBe(false);
    expect(report.sources).toBe(20); expect(report.tools).toBe(40);
  });
  it('21源或41工具仍非零失败', () => {
    expect(run(Array(21).fill(1)).code).toBe(1);
    expect(run([41]).code).toBe(1);
  });
  it('文本和JSON都明确假设而非最低数量要求', () => {
    const { code, output } = run([6, 5], false);
    expect(code).toBe(0);
    expect(output).toContain('情景估算');
    expect(output).toContain('4不是每源最低工具数');
    expect(output).toContain('假设');
    expect(output).not.toContain('到不了 20 个源');
  });
});

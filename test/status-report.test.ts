import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  baseVersion,
  compareSemver,
  evaluateChannelVersions,
  evaluateDefaultSetConsistency,
  extractHubStatusDefaultSetTools,
  latestMarketVersion,
  main,
  renderStatusReport,
} from '../scripts/status-report.mjs';

/**
 * 现状报告（P0）测试。
 *
 * 为什么要测：这是「让机器回答三处读数一致不一致」的那条命令，**它的退出码本身就是验收判据**。
 * 测试全部离线：不读 dist、不起服务、不联网；联网/起服务那段由 `npm run status:report` 实跑取证。
 *
 * 重点锁两件事：
 *   1. 三处读数（catalog / hub_status / tools/list）不一致 → exit 1，一致 → exit 0；
 *   2. 报告正文必须同时含逐源 attempts、三通道版本、三处读数三块，缺一块就等于没交产物。
 */

const FULL_LIBRARY_READINGS = {
  catalogDefaultSetTools: 35,
  hubStatusDefaultSetTools: 41,
  toolsListCount: 41,
  catalogTotals: { sources: 10, tools: 41, sourceTools: 39, metaTools: 2, defaultSources: [] },
};

const DEFAULT_SET_ONLY_READINGS = {
  catalogDefaultSetTools: 35,
  hubStatusDefaultSetTools: 35,
  toolsListCount: 35,
  catalogTotals: { sources: 7, tools: 35, sourceTools: 33, metaTools: 2, defaultSources: [] },
};

const CHANNELS = [
  { key: 'npm', label: 'npm latest', version: '0.1.1', detail: 'registry 共登记 2 个版本', error: null },
  { key: 'market', label: 'market/index.json', version: '0.1.0', detail: '本地索引登记 1 个版本', error: null },
  {
    key: 'cloud',
    label: '云服务 /healthz',
    version: '0.1.1+svc.7.g026f3be',
    detail: 'package 0.1.1；10 源 / 41 工具（元工具 2）',
    error: null,
  },
];

function silentIo() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
}

describe('hub_status 默认集读数解析', () => {
  it('解析「已超软建议」与「在软建议内」两种措辞', () => {
    expect(extractHubStatusDefaultSetTools('默认推荐集：41 个工具，已超软建议 40 共 1 个（只警示、不拒绝）')).toBe(41);
    expect(extractHubStatusDefaultSetTools('默认推荐集：35 个工具，软建议 ≤ 40（超出只警示、不拒绝）')).toBe(35);
  });

  it('找不到读数就抛错，不猜数字', () => {
    expect(() => extractHubStatusDefaultSetTools('规模（全库，不设上限）：源 10；工具 39＋元工具 2＝41')).toThrow(
      /找不到「默认推荐集：N 个工具」/,
    );
  });
});

describe('默认集三处读数一致性', () => {
  it('35 / 41 / 41（当前已知缺口）→ 不一致，报出三处数值', () => {
    const result = evaluateDefaultSetConsistency(FULL_LIBRARY_READINGS);
    expect(result.consistent).toBe(false);
    expect(result.problems.join('\n')).toContain('/catalog.budget.defaultSetTools=35');
    expect(result.problems.join('\n')).toContain('hub_status=41');
    expect(result.problems.join('\n')).toContain('tools/list=41');
  });

  it('35 / 35 / 35（只启用默认集清单的 7 个源）→ 一致', () => {
    const result = evaluateDefaultSetConsistency(DEFAULT_SET_ONLY_READINGS);
    expect(result.consistent).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('任一读数缺失 → 不一致（不许把“没读到”当成“一致”）', () => {
    const result = evaluateDefaultSetConsistency({ ...DEFAULT_SET_ONLY_READINGS, hubStatusDefaultSetTools: undefined });
    expect(result.consistent).toBe(false);
    expect(result.problems.join('\n')).toContain('hub_status 读不到有效整数');
  });
});

describe('版本读取与比较', () => {
  it('baseVersion 去掉构建号', () => {
    expect(baseVersion('0.1.1+svc.7.g026f3be')).toBe('0.1.1');
    expect(baseVersion('')).toBeNull();
  });

  it('compareSemver 按数字段比较', () => {
    expect(compareSemver('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareSemver('0.1.0', '0.1.1')).toBeLessThan(0);
    expect(compareSemver('0.1.1', '0.1.1')).toBe(0);
  });

  it('latestMarketVersion 取登记的最高版本', () => {
    const market = { plugins: [{ name: 'plantomics-hub', versions: [{ version: '0.2.0' }, { version: '0.1.0' }] }] };
    expect(latestMarketVersion(market)).toBe('0.2.0');
    expect(latestMarketVersion({ plugins: [] })).toBeNull();
  });

  it('三通道包版本：0.1.1 / 0.1.0 / 0.1.1 → 不一致；同版本时一致', () => {
    const mismatched = evaluateChannelVersions(CHANNELS);
    expect(mismatched.consistent).toBe(false);
    expect(mismatched.note).toContain('market/index.json=0.1.0');

    const aligned = evaluateChannelVersions([
      { label: 'npm latest', version: '0.1.1', error: null },
      { label: 'market/index.json', version: '0.1.1', error: null },
      { label: '云服务 /healthz', version: '0.1.1+svc.9.gabcdef', error: null },
    ]);
    expect(aligned.consistent).toBe(true);
  });

  it('有通道读不到版本时不算一致', () => {
    const result = evaluateChannelVersions([{ label: 'npm latest', version: null, error: 'HTTP 500' }]);
    expect(result.consistent).toBe(false);
    expect(result.note).toContain('无法比较');
  });
});

describe('报告正文', () => {
  const snapshot = {
    date: '2026-11-07',
    generatedAt: '2026-11-07T04:30:00.000Z',
    gitRev: '77c31a4',
    nodeVersion: 'v24.14.0',
    sourcesSetting: null,
    readings: FULL_LIBRARY_READINGS,
    consistency: evaluateDefaultSetConsistency(FULL_LIBRARY_READINGS),
    channels: CHANNELS,
    probe: {
      date: '2026-11-07',
      results: [
        {
          id: 'wheatomics',
          url: 'https://example.invalid/expression/projects',
          status: 200,
          expected: 200,
          attempts: 1,
          ms: 452,
          ok: true,
          note: '1234 B JSON，业务信封及源级断言正常 → 取得数据（第 1 次尝试）',
        },
        {
          id: 'ensemblplants',
          url: 'https://example.invalid/lookup/id/AT1G65480',
          status: 200,
          expected: 200,
          attempts: 2,
          ms: 31356,
          ok: true,
          note: 'attempt 1: CONNECT_TIMEOUT｜attempt 2: HTTP 200 → 取得数据（第 2 次尝试）',
        },
      ],
    },
    probeError: null,
  };

  it('三块必备证据都在：逐源 attempts / 三通道版本 / 三处读数', () => {
    const text = renderStatusReport(snapshot);
    expect(text).toContain('## 逐源 attempts（源级探活）');
    expect(text).toContain('| wheatomics |');
    expect(text).toContain('| ensemblplants |');
    expect(text).toContain('31356 ms');
    expect(text).toContain('| 2 |'); // ensemblplants 的 attempts
    expect(text).toContain('## 发布三通道版本');
    expect(text).toContain('npm latest');
    expect(text).toContain('market/index.json');
    expect(text).toContain('云服务 /healthz');
    expect(text).toContain('## 默认集三处读数');
    expect(text).toContain('/catalog.budget.defaultSetTools');
    expect(text).toContain('hub_status');
    expect(text).toContain('tools/list');
  });

  it('不一致时正文标红，且点明这是 P1/P2b 的工单', () => {
    const text = renderStatusReport(snapshot);
    expect(text).toContain('**一致性检查：❌ 不一致**');
    expect(text).toContain('`npm run status:check` 在此检出上 exit 1');
    expect(text).toContain('P1/P2b');
  });

  it('一致时正文标绿，且三通道不一致只记录不闸', () => {
    const text = renderStatusReport({
      ...snapshot,
      readings: DEFAULT_SET_ONLY_READINGS,
      consistency: evaluateDefaultSetConsistency(DEFAULT_SET_ONLY_READINGS),
    });
    expect(text).toContain('**一致性检查：✅ 一致**');
    expect(text).toContain('三通道包版本：❌ 不一致');
  });

  it('探活未跑时必须写“未知”，不能编 attempts', () => {
    const text = renderStatusReport({ ...snapshot, probe: null, probeError: null });
    expect(text).toContain('没有**逐源 attempts 证据，记为未知');
  });
});

describe('CLI 退出码（验收判据）', () => {
  it('--check：35/41/41 → exit 1', async () => {
    const io = silentIo();
    const code = await main({
      argv: ['--check'],
      collectLocal: async () => FULL_LIBRARY_READINGS,
      ...io,
    });
    expect(code).toBe(1);
    expect(io.err.join('')).toContain('❌ 默认集三处读数不一致');
    expect(io.err.join('')).toContain('/catalog.budget.defaultSetTools=35');
  });

  it('--check：35/35/35 → exit 0', async () => {
    const io = silentIo();
    const code = await main({
      argv: ['--check'],
      collectLocal: async () => DEFAULT_SET_ONLY_READINGS,
      ...io,
    });
    expect(code).toBe(0);
    expect(io.out.join('')).toContain('✅ 默认集三处读数一致');
  });

  it('报告模式：生成文件、exit 0（不一致也生成，由 --check 负责报红）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'status-report-test-'));
    const outFile = path.join(dir, '现状-2026-11-07.md');
    const io = silentIo();
    try {
      const code = await main({
        argv: ['--no-probe', '--out', outFile],
        collectLocal: async () => FULL_LIBRARY_READINGS,
        collectChannelsFn: async () => CHANNELS,
        ...io,
      });
      expect(code).toBe(0);
      const text = readFileSync(outFile, 'utf8');
      expect(text).toContain('由 `npm run status:report` 生成');
      expect(text).toContain('本次以 `--no-probe` 运行');
      expect(text).toContain('**一致性检查：❌ 不一致**');
      expect(io.out.join('')).toContain('❌ 默认集三处读数不一致');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

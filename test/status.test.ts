/**
 * `hub_status` 的离线验收题集。
 *
 * 三条主线（对应契约 R1–R3 中与"体检"有关的部分）：
 *   1. **只读本地**：任何输入都不得产生网络请求（用会抛错的 fetcher 证明）；
 *   2. **数字不猜**：源数/工具数必须等于注册表实测，预算上限必须等于 budget 常量；
 *   3. **不冒充上游可用**：输出恒带"不访问上游/不承诺可用"的免责行；
 *      并且"没覆盖"要如实说没有，不许拿别的意图凑。
 *
 * 另一个重点：**目录与注册表双向一致**——本文件断言 `hub_status` 报出的规模
 * 与 `createRegistry()` 实测一致；工具级双向一致另有 catalog-consistency 测试。
 */

import { describe, expect, it } from 'vitest';

import { utf8Bytes } from '../src/core/format.js';
import { InvalidArgumentError } from '../src/core/errors.js';
import type { Fetcher, ToolDefinition } from '../src/core/types.js';
import { createRegistry } from '../src/sources/index.js';
import { MAX_SOURCES, MAX_TOOLS } from '../src/service/budget.js';
import { INTENTS, TOOL_CAPABILITIES } from '../src/retrieval/capability-catalog.js';
import { buildStatusReport, createStatusTool, type StatusSnapshot } from '../src/retrieval/status.js';
import { statusSnapshotOf } from '../src/retrieval/index.js';

/** 任何 HTTP 调用都算违规：本工具必须是纯本地。 */
const forbiddenHttp = (async (url: string) => {
  throw new Error(`hub_status 不应发起任何网络请求，但请求了 ${url}`);
}) as Fetcher;

const FIXED_VERSION = '0.1.0+svc.3.test';

function realSnapshot(): StatusSnapshot {
  const registry = createRegistry();
  return statusSnapshotOf(registry, FIXED_VERSION);
}

function statusTool(): ToolDefinition {
  return createStatusTool(realSnapshot());
}

describe('hub_status：只读本地目录', () => {
  it('无参数调用产出体检报告，且零网络请求', async () => {
    const result = await statusTool().run({}, { http: forbiddenHttp });
    expect(result.text).toContain('服务端版本：0.1.0+svc.3.test');
    expect(result.meta.sourceId).toBe('hub');
    expect(result.meta.url).toBe('local://registry+catalog');
  });

  it('六个源全部列出，且每个源的工具数与注册表一致（双向一致的下半程）', async () => {
    const registry = createRegistry();
    const result = await statusTool().run({}, { http: forbiddenHttp });
    for (const bundle of registry.listSources()) {
      expect(result.text).toContain(bundle.manifest.id);
      expect(result.raw.sources).toBe(registry.listSources().length);
      const reported = result.text.split('\n').find((line) => line.startsWith(`| ${bundle.manifest.id}`));
      expect(reported, `${bundle.manifest.id} 未出现在表格里`).toBeDefined();
      expect(reported).toContain(`| ${bundle.tools.length} |`);
    }
    // sourceTools 只数**源工具**；元工具（hub_*）单列在 metaToolNames，不混进这个数
expect(result.raw.sourceTools).toBe(registry.listTools().filter((t) => !t.name.startsWith('hub_')).length);
  });

  it('预算上限取自 budget 常量，不另写一份数字', async () => {
    const result = await statusTool().run({}, { http: forbiddenHttp });
    expect(result.raw.budget.maxSources).toBe(MAX_SOURCES);
    expect(result.raw.budget.maxTools).toBe(MAX_TOOLS);
    expect(result.text).toContain(`${MAX_SOURCES}`);
    expect(result.text).toContain(`${MAX_TOOLS}`);
  });

  it('规模是"源工具＋元工具"分开计，总数计入 40 预算', async () => {
    const snapshot = realSnapshot();
    const report = buildStatusReport(snapshot, '2026-10-29T00:00:00.000Z');
    expect(report.raw.metaTools).toBe(snapshot.metaToolNames.length);
    expect(report.raw.totalTools).toBe(report.raw.sourceTools + report.raw.metaTools);
    expect(report.text).toContain(`＋元工具 ${report.raw.metaTools}＝${report.raw.totalTools}`);
  });

  it('注入元工具后总数增加、仍不超预算时给出剩余额度', async () => {
    const base = realSnapshot();
    const withMeta: StatusSnapshot = { ...base, metaToolNames: ['hub_find_sources', 'hub_status'] };
    const report = buildStatusReport(withMeta, '2026-10-29T00:00:00.000Z');
    expect(report.raw.totalTools).toBe(report.raw.sourceTools + 2);
    expect(report.text).toContain('剩余工具额度');
    expect(report.text).not.toContain('已超预算');
  });

  it('超预算时如实标异常，绝不静默放行', () => {
    const base = realSnapshot();
    const overflow: StatusSnapshot = {
      ...base,
      metaToolNames: Array.from({ length: MAX_TOOLS }, (_, i) => `hub_fake_${i}`),
    };
    const report = buildStatusReport(overflow, '2026-10-29T00:00:00.000Z');
    expect(report.raw.totalTools).toBeGreaterThan(MAX_TOOLS);
    expect(report.text).toContain('已超预算');
  });
});

describe('hub_status：不冒充上游可用', () => {
  it('输出恒带"不是上游可用性"的免责行与完整尾注', async () => {
    const result = await statusTool().run({}, { http: forbiddenHttp });
    expect(result.text).toContain('不是上游可用性');
    expect(result.text).toContain('不访问任何上游');
    // 尾注四要素：源 / 完整调用 / 无上游请求 / 版本与时刻
    expect(result.text).toContain('源：plantomics-hub 本地目录');
    expect(result.text).toContain('hub_status()');
    expect(result.text).toContain('无上游请求');
    expect(result.text).toContain('查询时刻');
  });

  it('不输出"数据不存在/查无"这类结论', async () => {
    const result = await statusTool().run({}, { http: forbiddenHttp });
    expect(result.text).not.toContain('数据不存在');
    expect(result.text).not.toContain('查无');
  });

  it('确定性：同一快照两次产出正文逐字节相同（仅时刻可变）', () => {
    const snapshot = realSnapshot();
    const at = '2026-10-29T00:00:00.000Z';
    const first = buildStatusReport(snapshot, at).text;
    const second = buildStatusReport(snapshot, at).text;
    expect(first).toBe(second);
    expect(utf8Bytes(first)).toBeLessThanOrEqual(4 * 1024);
  });
});

describe('hub_status：意图筛选与"没有就说没有"', () => {
  it('intent=表达 只列有表达工具的源', async () => {
    const result = await statusTool().run({ intent: '表达' }, { http: forbiddenHttp });
    expect(result.text).toContain('wheatomics');
    expect(result.text).not.toContain('| gwh');
    expect(result.meta.request).toContain('intent=表达');
  });

  it('intent 用英文 id 也认（expression）', async () => {
    const result = await statusTool().run({ intent: 'expression' }, { http: forbiddenHttp });
    expect(result.text).toContain('wheatomics');
  });

  it('不存在的意图直接拒，并列出可用意图——不拿别的意图凑', async () => {
    await expect(statusTool().run({ intent: '蛋白结构预测' }, { http: forbiddenHttp }))
      .rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(statusTool().run({ intent: '蛋白结构预测' }, { http: forbiddenHttp }))
      .rejects.toThrow(/没有意图「蛋白结构预测」/);
  });

  it('空串 intent 被拒，不静默当全景', async () => {
    await expect(statusTool().run({ intent: '  ' }, { http: forbiddenHttp }))
      .rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('未知参数被 invoke 层拒绝（additionalProperties=false）', async () => {
    await expect(
      statusTool().run({ unknown_param: 1 }, { http: forbiddenHttp }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe('RETR-09：正文截断不许丢掉出处与免责行', () => {
  it('超长目录触发截断时，尾注、查询时刻、免责行必须完整保留', () => {
    const registry = createRegistry();
    const wheat = registry.listSources().find((bundle) => bundle.manifest.id === 'wheatomics');
    const snapshot: StatusSnapshot = {
      version: 'review-fixed',
      sources: [{
        id: 'wheatomics',
        // 合成超长名称，只用于边界测试，不声称真实源名如此
        displayName: '长名称'.repeat(600),
        tier: 'T1',
        toolCount: wheat?.tools.length ?? 0,
        species: ['Triticum aestivum'],
        versionNote: '未知',
      }],
      enabledTools: (wheat?.tools ?? []).map((tool) => tool.name),
      metaToolNames: [],
    };

    const report = buildStatusReport(snapshot, '2026-10-29T00:00:00.000Z');

    expect(report.text).toContain('正文已按预算截断');
    // 不可截部分逐项都在
    expect(report.text).toContain('源：plantomics-hub 本地目录｜hub_status()｜无上游请求');
    expect(report.text).toContain('查询时刻 2026-10-29T00:00:00.000Z');
    expect(report.text).toContain('本工具不访问任何上游');
    expect(report.text).toContain('不是上游可用性');
    // 尾注确实在最后一行，且整包不超预算
    expect(report.text.trimEnd().endsWith('查询时刻 2026-10-29T00:00:00.000Z')).toBe(true);
    expect(utf8Bytes(report.text)).toBeLessThanOrEqual(4 * 1024);
  });
});

describe('RETR-10：只报当前启用集，不把未启用源的能力当现状', () => {
  const full = statusSnapshotOf(createRegistry(), FIXED_VERSION);
  const wheatOnly: StatusSnapshot = {
    ...full,
    sources: full.sources.filter((source) => source.id === 'wheatomics'),
    enabledTools: full.enabledTools.filter((name) => name.startsWith('wheatomics_')),
  };

  it('单源快照不再列出别的源才有的意图（circrna/lncrna/内参/组装/样本）', () => {
    const report = buildStatusReport(wheatOnly, '2026-10-29T00:00:00.000Z');
    const ids = report.raw.intents.map((row) => row.id);
    expect(ids).toContain('gene-search');
    for (const absent of ['circrna', 'lncrna', 'reference-gene', 'assembly', 'sample', 'synteny', 'tf']) {
      expect(ids, `单源快照不应报出 ${absent}`).not.toContain(absent);
    }
    // 被过滤掉的条目要如实计数，不能假装目录里没有
    expect(report.raw.catalogEntriesNotEnabled).toBeGreaterThan(0);
    expect(report.text).toContain('因所属源未启用而不计入');
  });

  it('意图筛选只认启用集：icg 的内参基因在单源快照里 → 拒并列出可用意图', async () => {
    await expect(
      createStatusTool(wheatOnly).run({ intent: '内参' }, { http: forbiddenHttp }),
    ).rejects.toThrow(/没有意图「内参」/);
  });

  it('快照不自洽（工具数之和对不上启用清单）→ 抛错，不输出错数字', () => {
    const broken: StatusSnapshot = { ...wheatOnly, enabledTools: [...wheatOnly.enabledTools, 'fake_extra_tool'] };
    expect(() => buildStatusReport(broken, '2026-10-29T00:00:00.000Z'))
      .toThrow(/快照不自洽/);
  });
});

describe('RETR-11（实跑新发现）：元工具计数必须等于真实注册表', () => {
  it('接线后 hub_status 报的元工具数与 tools/list 实际一致（构造期取值会报成 0）', async () => {
    const registry = createRegistry();
    const tool = registry.getTool('hub_status');
    expect(tool, 'hub_status 未接线进注册表').toBeDefined();

    const result = await tool!.run({}, { http: forbiddenHttp });
    const metaCount = registry.listMetaTools().length;
    expect(metaCount).toBeGreaterThan(0); // 接线后至少 hub_find_sources + hub_status
    expect(result.raw.metaTools).toBe(metaCount);
    // 总工具数必须与 /healthz、tools/list 同一口径（业务工具 + 元工具）
    expect(result.raw.totalTools).toBe(registry.listTools().length);
    expect(result.text).toContain(`元工具 ${metaCount}＝`);
  });

  it('hub_find_sources 尾注里的规模同样取运行时值（构造期会写成 30）', async () => {
    const registry = createRegistry();
    const tool = registry.getTool('hub_find_sources');
    expect(tool, 'hub_find_sources 未接线进注册表').toBeDefined();

    const out = await tool!.run({ question: '小麦已知基因' }, { http: forbiddenHttp });
    expect(out.text).toContain(`工具 ${registry.listTools().length}`);
    expect(out.text).toContain(`源 ${registry.listSources().length}`);
  });
});

describe('hub_status：目录自洽', () => {
  it('每个源在 SOURCE_SEMANTICS 里都有语义（否则表格会写"未登记语义"）', () => {
    const report = buildStatusReport(realSnapshot(), '2026-10-29T00:00:00.000Z');
    expect(report.text).not.toContain('未登记语义');
  });

  it('意图覆盖统计与目录逐条相符（不是凭印象写的）', () => {
    const report = buildStatusReport(realSnapshot(), '2026-10-29T00:00:00.000Z');
    const expected = new Map<string, number>();
    for (const capability of TOOL_CAPABILITIES) {
      for (const intent of capability.intents) {
        expected.set(intent, (expected.get(intent) ?? 0) + 1);
      }
    }
    for (const row of report.raw.intents) {
      expect(row.toolCount).toBe(expected.get(row.id));
      expect(INTENTS.some((intent) => intent.id === row.id)).toBe(true);
    }
    // 目录里挂载的每个意图都必须在统计里出现，不许漏
    expect(report.raw.intents).toHaveLength(expected.size);
  });
});

/**
 * `hub_status`：服务状态与能力清单（体检用，**只读注册表与能力目录**）。
 *
 * 为什么需要它（与 hub_find_sources 的分工）：
 *   - `hub_find_sources` 回答"这个问题该用哪个源/工具"——**面向一个问题**；
 *   - `hub_status` 回答"现在到底有什么、缺什么、还能加多少"——**面向服务本身**。
 * 模型选错源时，排查顺序应该是：先 hub_status 看目录里有没有这个能力，
 * 再看 hub_find_sources 是不是没召回。两者混成一个工具会让"没覆盖"与"没召回"分不清。
 *
 * 三条硬约束（设计契约 §三/§五）：
 *   1. **不发任何上游请求**：纯本地。因此不走 prepareRequest/finishResult，尾注自持。
 *   2. **不报"上游可用"**：只报目录事实与预算，不探测、不承诺。返回恒带免责行。
 *   3. **不猜数字**：源数/工具数来自注入的注册表快照；预算上限来自 budget 常量，
 *      超限与否由同一份常量判定，不在本文件里另写一份数字（漂移即事故）。
 *
 * 本轮按审查 RETR-09 / RETR-10 修正两处：
 *   - **RETR-09**：正文、免责行、完整尾注**分别构造**；先按实际字节扣掉不可截部分，
 *     只截正文再拼接。原来先拼整包再截，会把出处与"未探测上游"一并砍掉。
 *   - **RETR-10**：意图覆盖、缺口、筛选**一律基于快照里实际启用的工具集**（`enabledTools`），
 *     不再读全局 `TOOL_CAPABILITIES`，避免只启用部分源时报出别的源才有的能力。
 */

import { DEFAULT_MAX_BYTES, truncateToBytes, utf8Bytes } from '../core/format.js';
import { InvalidArgumentError } from '../core/errors.js';
import { validateArgs } from '../core/invoke.js';
import { MAX_SOURCES, MAX_TOOLS } from '../service/budget.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import {
  INTENT_BY_ID,
  SOURCE_SEMANTICS,
  TOOL_CAPABILITIES,
  type IntentId,
  type SpeciesPolicy,
  type ToolCapability,
} from './capability-catalog.js';

/** 正文被截断时追加的标记；属于不可截部分，预算里已扣除。 */
const TRUNCATE_MARKER = '\n…（正文已按预算截断；来源与免责行见下）';

/** 每个源在表格里最多展示的物种数（manifest 物种数一般 ≤4，这里防异常长列表）。 */
const MAX_SPECIES_PER_ROW = 6;

export interface StatusSourceView {
  readonly id: string;
  readonly displayName: string;
  readonly tier: string;
  readonly toolCount: number;
  /** 已登记（或已实测）的物种；来源是 manifest，不推断 */
  readonly species: readonly string[];
  /** 数据版本口径；未知就照抄"未知"的说法 */
  readonly versionNote: string;
}

export interface StatusSnapshot {
  /** 服务端版本串，如 `0.1.0+svc.3.gabc1234` */
  readonly version: string;
  /** 每个源的目录事实（顺序即注册顺序） */
  readonly sources: readonly StatusSourceView[];
  /**
   * **当前注册的业务工具名**（不含元工具）。
   *
   * 存在的理由：只启用部分源时（`PLANTOMICS_SOURCES`），能力目录仍是全局的；
   * 不用这份名单求交，就会把没启用的源的能力报成"当前可用"（RETR-10）。
   */
  readonly enabledTools: readonly string[];
  /** 元工具名（如 hub_find_sources/hub_status 自身），用于分列预算 */
  readonly metaToolNames: readonly string[];
}

/**
 * `raw.sourceList` 的元素：把一个源的全部目录事实摊平成结构体。
 *
 * 为什么要有它：`raw.sources` 只是计数，前端要渲染卡片网格就得重新猜字段。
 * 但**这里只放已经存在的字段**，不新增数据来源——`semantics`/`policy` 与文本
 * 表格取自同一份 `SOURCE_SEMANTICS`，避免"界面一套说法、工具一套说法"。
 * 盲区文案同样从 `semantics` + `policy` 派生，前端不许自己写一份。
 */
export interface StatusSourceEntry {
  readonly id: string;
  readonly displayName: string;
  readonly tier: string;
  readonly toolCount: number;
  readonly species: readonly string[];
  readonly versionNote: string;
  /** 语义（承诺 / 实测 / 示例非承诺），与文本表格同一份来源 */
  readonly semantics: string;
  /** 覆盖政策；`null` 表示该源未登记政策 */
  readonly policy: SpeciesPolicy | null;
  /** 未登记语义时为 true，供界面显式提示"这个源还没登记语义" */
  readonly semanticsUnknown: boolean;
}

export interface StatusReport {
  readonly text: string;
  readonly raw: {
    version: string;
    sources: number;
    /** 逐源目录事实；顺序与文本表格一致（注册顺序，或 intent 过滤后的子集） */
    sourceList: StatusSourceEntry[];
    sourceTools: number;
    metaTools: number;
    totalTools: number;
    budget: { sources: number; maxSources: number; tools: number; maxTools: number };
    intents: Array<{ id: IntentId; label: string; toolCount: number }>;
    uncoveredSpecies: string[];
    /** 被快照过滤掉的目录条目数（有目录、但该源当前没启用） */
    catalogEntriesNotEnabled: number;
  };
}

/** 只保留"当前启用"的能力条目：目录与快照求交。 */
function enabledCapabilities(enabledTools: readonly string[]): ToolCapability[] {
  const enabled = new Set(enabledTools);
  return TOOL_CAPABILITIES.filter((capability) => enabled.has(capability.tool));
}

/** 意图 → 该意图下有多少工具（**只统计当前启用的工具**）。 */
function intentCounts(capabilities: readonly ToolCapability[]): Array<{ id: IntentId; label: string; toolCount: number }> {
  const counts = new Map<IntentId, number>();
  for (const capability of capabilities) {
    for (const intent of capability.intents) counts.set(intent, (counts.get(intent) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, toolCount]) => ({ id, label: INTENT_BY_ID.get(id)?.label ?? id, toolCount }));
}

/** 物种能否被某个 scope 承接（只在启用集内判；口径与 find_sources 同一套）。 */
function scopeCovers(scope: string, species: string): boolean {
  if (scope === '不限物种（按精确 ID）') return true;
  return scope === species || scope.includes(species);
}

/**
 * 纯函数：给定快照产出体检报告。
 *
 * **确定性**：同快照必同输出（除尾注时刻）。测试直接对比两次调用的正文是否逐字节相同。
 */
export function buildStatusReport(snapshot: StatusSnapshot, at: string): StatusReport {
  const enabled = enabledCapabilities(snapshot.enabledTools);
  const sourceToolSum = snapshot.sources.reduce((sum, source) => sum + source.toolCount, 0);
  // 快照自洽校验：源工具数之和对不上启用清单，说明装配写错了——宁可报错也不输出错数字
  if (sourceToolSum !== snapshot.enabledTools.length) {
    throw new Error(
      `hub_status 快照不自洽：sources 工具数之和 ${sourceToolSum} ≠ enabledTools ${snapshot.enabledTools.length}`,
    );
  }
  const sourceTools = snapshot.enabledTools.length;
  const metaTools = snapshot.metaToolNames.length;
  const totalTools = sourceTools + metaTools;
  const budget = {
    sources: snapshot.sources.length,
    maxSources: MAX_SOURCES,
    tools: totalTools,
    maxTools: MAX_TOOLS,
  };

  const lines: string[] = [];
  lines.push(`服务端版本：${snapshot.version}`);
  lines.push('');
  lines.push(`规模：源 ${budget.sources}/${budget.maxSources}；工具 ${sourceTools}＋元工具 ${metaTools}＝${totalTools}/${budget.maxTools}`);
  if (budget.sources > budget.maxSources || budget.tools > budget.maxTools) {
    // 不在这里"放行"：超限是启动门禁的事，这里只如实标出来
    lines.push('⚠️ 已超预算：服务启动期门禁应已拒绝监听，此进程属异常状态。');
  } else {
    lines.push(`剩余工具额度：${budget.maxTools - budget.tools}（元工具也占额度）`);
  }

  lines.push('');
  // 逐源事实只在这里算一次：文本表格与 raw.sourceList 共用，杜绝两套口径
  const entries: StatusSourceEntry[] = snapshot.sources.map((source) => {
    const registered = SOURCE_SEMANTICS[source.id];
    return {
      id: source.id,
      displayName: source.displayName,
      tier: source.tier,
      toolCount: source.toolCount,
      species: [...source.species],
      versionNote: source.versionNote,
      semantics: registered?.semantics ?? '未登记语义',
      policy: registered?.policy ?? null,
      semanticsUnknown: registered === undefined,
    };
  });

  lines.push('| 源 | 语义 | 工具数 | 物种（manifest 口径） |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of entries) {
    // example-only / any-by-id 必须显式标出来，否则读者会把它当覆盖承诺
    const policyNote = entry.policy === 'example-only' ? '（示例非承诺）'
      : entry.policy === 'any-by-id' ? '（按精确 ID，不限物种）'
        : '';
    const shown = entry.species.slice(0, MAX_SPECIES_PER_ROW);
    const species = shown.length > 0
      ? `${shown.join('、')}${entry.species.length > shown.length ? `等 ${entry.species.length} 种` : ''}`
      : '未知';
    lines.push(`| ${entry.id}（${entry.displayName}） | ${entry.semantics}${policyNote} | ${entry.toolCount} | ${species} |`);
  }

  lines.push('');
  const counts = intentCounts(enabled);
  lines.push(`意图覆盖（${counts.length} 类，共 ${counts.reduce((s, c) => s + c.toolCount, 0)} 个工具挂载，按当前启用工具统计）：`);
  lines.push(counts.map((c) => `${c.label}×${c.toolCount}`).join('、'));

  // 目录里登记了物种、但当前启用集里没有任何工具覆盖的：这是"该补源"的信号，不是"没这个数据"
  const known = new Set<string>();
  for (const source of snapshot.sources) {
    for (const species of source.species) known.add(species);
  }
  const uncovered = [...known].filter((species) =>
    !enabled.some((capability) => {
      const scope = [...(capability.speciesScope.query ?? []), ...(capability.speciesScope.target ?? [])];
      return scope.some((entry) => scopeCovers(entry, species));
    }));
  if (uncovered.length > 0) {
    lines.push('');
    lines.push(`目录里出现但当前无工具覆盖的物种：${uncovered.join('、')}（需要覆盖请走源接入流程）`);
  }

  const notEnabled = TOOL_CAPABILITIES.length - enabled.length;
  if (notEnabled > 0) {
    lines.push('');
    lines.push(`另有 ${notEnabled} 条能力目录条目因所属源未启用而不计入（目录总数 ${TOOL_CAPABILITIES.length}）。`);
  }

  lines.push('');
  lines.push('元工具：' + (snapshot.metaToolNames.length > 0 ? snapshot.metaToolNames.join('、') : '（无）'));

  // ── 不可截部分：免责行 + 完整尾注（RETR-09）────────────────────────────
  const disclaimer = '说明：以上是**本地目录与预算事实**，不是上游可用性；本工具不访问任何上游，也不代表某个源此刻能查通。';
  const tail = `——\n源：plantomics-hub 本地目录｜hub_status()｜无上游请求｜服务版本 ${snapshot.version}｜查询时刻 ${at}`;
  const tailBytes = utf8Bytes(disclaimer) + utf8Bytes(tail) + utf8Bytes(TRUNCATE_MARKER) + 3; // 3 = 三个换行

  const bodyBudget = DEFAULT_MAX_BYTES - tailBytes;
  if (bodyBudget <= 0) {
    throw new Error('hub_status 尾注与免责行已超出 4 KB 预算，无法保证出处完整');
  }
  const clipped = truncateToBytes(lines.join('\n'), bodyBudget);
  const text = [
    clipped.text,
    clipped.truncated ? TRUNCATE_MARKER : '',
    disclaimer,
    tail,
  ].filter((part) => part !== '').join('\n');
  if (utf8Bytes(text) > DEFAULT_MAX_BYTES) {
    throw new Error('hub_status 输出预算不变量被破坏');
  }

  return {
    text,
    raw: {
      version: snapshot.version,
      sources: budget.sources,
      sourceList: entries,
      sourceTools,
      metaTools,
      totalTools,
      budget,
      intents: counts,
      uncoveredSpecies: uncovered,
      catalogEntriesNotEnabled: notEnabled,
    },
  };
}

/**
 * 工厂：注入快照（版本 + 每源目录事实 + 启用工具名 + 元工具名）。
 *
 * 不用 `ctx`：`ToolContext` 只有 `http`/`signal`，往里加字段等于改公共契约，
 * 而版本与目录在装配时已知。
 */
export function createStatusTool(snapshot: StatusSnapshot): ToolDefinition {
  const tool: ToolDefinition = {
    name: 'hub_status',
    description:
      '体检用：列出本服务当前的源、每个源的语义与物种口径、工具数与意图覆盖、预算余量、已知缺口。'
      + '当用户问「你能查什么／一共几个库／为什么查不到某个物种／还能加多少」时用它；'
      + '也可用于排查「是没这个能力」还是「检索没召回」。纯本地目录事实，不访问上游，不承诺任何源此刻可用。',
    parameters: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: '可选：只看某个意图的细节（如 表达 / 变异 / 同源 / 序列）。留空给全景。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args): Promise<ToolResult> {
      validateArgs(tool, args);
      const at = new Date().toISOString();
      const intent = args.intent === undefined || args.intent === null ? undefined : String(args.intent);
      if (intent !== undefined && intent.trim() === '') {
        throw new InvalidArgumentError('参数 intent 不能为空字符串；不需要筛选请直接省略');
      }

      let effective = snapshot;
      if (intent) {
        // 只在**已启用**的能力里筛（RETR-10：别先命中未启用源再报空）
        const needle = intent.trim().toLowerCase();
        const candidates = enabledCapabilities(snapshot.enabledTools);
        const matched = candidates.filter((capability) => {
          const label = capability.intents
            .map((id) => INTENT_BY_ID.get(id)?.label ?? id)
            .join(' ');
          return capability.intents.some((id) => id.toLowerCase().includes(needle))
            || label.toLowerCase().includes(needle);
        });
        if (matched.length === 0) {
          // 与 find_sources 同一原则：没有就说没有，不拿别的意图凑
          throw new InvalidArgumentError(
            `没有意图「${intent}」的工具。当前可用意图：${intentCounts(candidates).map((c) => c.label).join('、')}`,
          );
        }
        const sourceIds = new Set(matched.map((capability) => capability.sourceId));
        const perSource = new Map<string, number>();
        for (const capability of matched) {
          perSource.set(capability.sourceId, (perSource.get(capability.sourceId) ?? 0) + 1);
        }
        effective = {
          ...snapshot,
          // 工具数必须跟着收窄，否则会与 enabledTools 对不上（快照自洽校验会抛错）
          sources: snapshot.sources
            .filter((source) => sourceIds.has(source.id))
            .map((source) => ({ ...source, toolCount: perSource.get(source.id) ?? 0 })),
          enabledTools: matched.map((capability) => capability.tool),
        };
      }

      const report = buildStatusReport(effective, at);
      return {
        text: report.text,
        raw: report.raw,
        meta: {
          sourceId: 'hub',
          request: `LOCAL hub_status(${intent ? `intent=${intent.trim()}` : ''})`,
          url: 'local://registry+catalog',
          status: 200,
          durationMs: 1,
          at,
        },
      };
    },
  };
  return tool;
}

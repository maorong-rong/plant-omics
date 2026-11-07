#!/usr/bin/env node
/**
 * 数量事实的唯一实现：源数、工具数、逐源工具数、构建信息。
 *
 * 为什么要有这个脚本：数字写在 Markdown 里就一定会过期。2026-10-30 一天之内就翻车两次——
 * README 写「0.1.0 = 8 源 37 工具」而 npm 上装出来是 7/34，`market/index.json` 又写 8/37。
 * 根治办法不是「记得改」，而是：**一处生成、多处灌入、对不上就非零退出**。
 *
 * 两个口径必须分开，不能混成一个数：
 *
 * | 口径 | 读什么 | 代表什么 | 联网 |
 * |---|---|---|---|
 * | 源码口径（默认） | 本地 `dist/` 的注册表 | **当前源码**能力，README 与落地页用它 | 否 |
 * | 发布口径（`--published`） | `market/index.json` 指向的 npm tarball | **装上能拿到什么**，市场索引用它 | 是 |
 *
 * 用法：
 *   npm run build && node scripts/counts.mjs            # 人读摘要
 *   node scripts/counts.mjs --json                      # 机器读产物（site/ 与市场措辞取数用）
 *   node scripts/counts.mjs --write                     # 重写 README 标记块
 *   node scripts/counts.mjs --check                     # 离线校验（进 npm run check）
 *   node scripts/counts.mjs --published                 # 联网校验发布包与市场描述（不进 npm test）
 *
 * 设计约束：
 * - **本文件顶层不 import `dist/`**：`npm test` 在 `npm run build` 之前跑，干净克隆没有 dist。
 *   所有对 dist 的读取都在函数里用动态 import，方便测试注入假注册表。
 * - 只有这一份算法：`stats.mjs`（预算判定）与 README/市场校验都从这里取数，不许各算各的。
 * - 退出码：校验不过 → 1（§五 断言铁律，不用 warn 糊过去）。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

/**
 * 预算口径（v2.3「源市场」制，2026-10-31 本涛确认；沿革见 AGENTS.md §10.4）。
 *
 * **硬阈值只有一个：单次订阅集 ≤ 80 工具。** 全库源数、全库工具数、每源工具数都不设硬上限。
 * 为什么：上下文成本由「用户这次装了哪些源」决定，不由库房总量决定——
 * 按全库 40 拦会逼着把源做粗，与「按需装」的产品形态冲突。
 *
 * 常量命名按职责分开，别再让一个名字背两种含义（名字错比数字错更难查）：
 * - `MAX_SUBSCRIPTION_TOOLS`（80）：唯一硬阈值，订阅集超过它才拒绝；
 * - `DEFAULT_SET_TOOLS_SOFT_MAX`（40）：默认推荐集，超过只警示；
 * - `HISTORICAL_SOURCE_LIMIT` / `HISTORICAL_TOOL_LIMIT`（20 / 40）：旧口径的历史参考，**只展示、不判定**；
 * - `MAX_SOURCES` / `MAX_TOOLS`：为了不破坏已有导入保留的**兼容别名**，值与上面的职责常量相同。
 */
export const MAX_SUBSCRIPTION_TOOLS = 80;
export const DEFAULT_SET_TOOLS_SOFT_MAX = 40;
export const HISTORICAL_SOURCE_LIMIT = 20;
export const HISTORICAL_TOOL_LIMIT = 40;

/** @deprecated 用 `HISTORICAL_SOURCE_LIMIT`（只展示）；保留别名仅为兼容既有导入。 */
export const MAX_SOURCES = HISTORICAL_SOURCE_LIMIT;
/** @deprecated 用 `DEFAULT_SET_TOOLS_SOFT_MAX`（默认集软建议）；保留别名仅为兼容既有导入。 */
export const MAX_TOOLS = DEFAULT_SET_TOOLS_SOFT_MAX;
/**
 * 每工具约多少 token：由实测 37 工具 10,274 token 折算（§10.2 影响声明）。
 * 只用于把「工具数」换算成上下文代价给人看，不是精确计量；换基准要同时改 AGENTS §10.2。
 */
export const TOKENS_PER_TOOL = 280;

/** 产物结构版本；改字段形状时 +1（site/ 与市场生成器据此判断）。 */
export const COUNTS_SCHEMA_VERSION = 1;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const README_BEGIN = '<!-- counts:begin -->';
export const README_END = '<!-- counts:end -->';

/** 读构建信息；dist 不存在（干净克隆、build 之前）时返回 null，不抛。 */
export function readBuildInfo(buildInfoPath = path.join(ROOT, 'dist', 'service', 'build-info.json')) {
  try {
    const raw = JSON.parse(readFileSync(buildInfoPath, 'utf8'));
    return {
      sourceRev: typeof raw.sourceRev === 'string' ? raw.sourceRev : null,
      builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : null,
      packageVersion: typeof raw.packageVersion === 'string' ? raw.packageVersion : null,
    };
  } catch {
    return null;
  }
}

/**
 * 从注册表收集数量事实。纯函数：只吃注册表接口，不读文件、不联网。
 *
 * @param {{ listSources: Function, listTools: Function, listMetaTools: Function }} registry
 * @param {{ scope?: string, buildInfo?: object|null, buildInfoPath?: string }} [options]
 */
/**
 * 默认推荐集的源清单：**直接读 src/service/budget.ts 的 DEFAULT_SET_SOURCES**。
 *
 * 为什么不在这里再抄一份：抄一份就等于有两个真相，改一边忘一边时，
 * 算出来的「默认推荐集」和运行时下发的集合会悄悄不一致。这里只解析源码里的数组字面量。
 */
function readDefaultSetSources() {
  const source = readFileSync(path.join(ROOT, 'src', 'service', 'budget.ts'), 'utf8');
  const match = /DEFAULT_SET_SOURCES[^=]*=\s*\[([\s\S]*?)\]/.exec(source);
  if (!match) throw new Error('读不到 src/service/budget.ts 的 DEFAULT_SET_SOURCES：默认集口径无法确定');
  return [...match[1].matchAll(/'([a-z0-9-]+)'/g)].map((hit) => hit[1]);
}

const DEFAULT_SET_SOURCES = readDefaultSetSources();

export function collectCounts(registry, options = {}) {
  const built = registry.listSources().map((bundle) => ({
    id: bundle.manifest.id,
    displayName: bundle.manifest.displayName,
    tier: bundle.manifest.tier,
    tools: bundle.tools.length,
  }));
  const metaToolNames = registry.listMetaTools().map((tool) => tool.name);
  const tools = registry.listTools().length;
  const sourceTools = built.reduce((sum, source) => sum + source.tools, 0);
  // 默认推荐集按清单算：清单外的源（scod / string / uniprot …）不自动进来
  const defaultSetTools = built.filter((source) => DEFAULT_SET_SOURCES.includes(source.id))
    .reduce((sum, source) => sum + source.tools, 0) + metaToolNames.length;

  // 注册表自己的口径必须自洽：否则后面所有数字都不可信，这里直接抛。
  if (tools !== sourceTools + metaToolNames.length) {
    throw new Error(
      `注册表口径不自洽：listTools()=${tools}，源工具=${sourceTools} + 元工具=${metaToolNames.length}`,
    );
  }

  return {
    schemaVersion: COUNTS_SCHEMA_VERSION,
    scope: options.scope ?? 'source',
    sources: built.length,
    sourceTools,
    metaTools: metaToolNames.length,
    metaToolNames,
    defaultSetSources: DEFAULT_SET_SOURCES,
    defaultSetTools,
    tools,
    perSource: built,
    buildInfo: options.buildInfo !== undefined ? options.buildInfo : readBuildInfo(options.buildInfoPath),
  };
}

/**
 * 预算判定（v2.3 源市场口径）。
 *
 * **全库只报数、不拦截**；唯一的失败条件是**订阅集**超过 `MAX_SUBSCRIPTION_TOOLS`。
 * 订阅集从哪来：调用方传入（`stats.mjs` 用与运行时同一个 `PLANTOMICS_SOURCES` 解析）。
 * 不传就是「没指定订阅集」——此时只算默认集，**绝不因为全库大而失败**。
 *
 * @param {object} counts `collectCounts()` 的结果
 * @param {{ requested: string[], sources: number, tools: number }} [subscription]
 */
export function buildBudgetReport(counts, subscription) {
  const subscriptionTools = subscription ? subscription.tools : undefined;
  const overSubscription = subscriptionTools !== undefined && subscriptionTools > MAX_SUBSCRIPTION_TOOLS;
  const tokenEstimate = counts.tools * TOKENS_PER_TOOL;

  return {
    sources: counts.sources,
    tools: counts.tools,
    metaTools: counts.metaTools,
    defaultSetSources: counts.defaultSetSources,
    defaultSetTools: counts.defaultSetTools,
    perSource: counts.perSource,
    /** 历史阶段参考（旧口径 20 源），只显示、不判定 */
    legacyMaxSources: MAX_SOURCES,
    /** 默认推荐集软建议；超过只警示 */
    maxDefaultSetTools: MAX_TOOLS,
    maxSubscriptionTools: MAX_SUBSCRIPTION_TOOLS,
    tokensPerTool: TOKENS_PER_TOOL,
    tokenEstimate,
    subscriptionTokens: subscriptionTools === undefined ? undefined : subscriptionTools * TOKENS_PER_TOOL,
    subscription: subscription ?? null,
    overDefaultSuggestion: counts.defaultSetTools > MAX_TOOLS,
    /** 唯一硬阈值：**指定的订阅集**超 80 才为真。全库再大也不会置真 */
    overBudget: overSubscription,
    /** 数字取自哪个构建产物（含 `-dirty` 标记）；`stats` 会把它打在首行 */
    buildInfo: counts.buildInfo ?? null,
  };
}

export function renderStatsText(report) {
  /**
   * 先报「这份数字是从哪个 dist 读的」。
   *
   * 2026-11-01 真实踩过：有人为了让截图有干净身份把 `dist/` 换成旧提交的归档构建，
   * 另一个人随后用 `stats` 核对，得出「注册表 37」的错误结论——实际工作区注册表是 39。
   * `dist/` 是可变的共享产物，所以数字旁边必须写清它的身份（含 `-dirty`），
   * 让人一眼看到「这是工作区构建，不是发布口径」。
   */
  const build = report.buildInfo ?? null;
  const rev = build && typeof build.sourceRev === 'string' ? build.sourceRev : '未知';
  const dirty = typeof rev === 'string' && rev.endsWith('-dirty');
  const lines = [
    `构建：${rev}${dirty ? ' ——工作区构建（含未提交改动），非发布口径' : ''}`
      + (build && build.builtAt ? ` · ${build.builtAt}` : ''),
    `全库：${report.sources} 源 / ${report.tools} 工具（源工具 ${report.tools - report.metaTools} + 元工具 ${report.metaTools}）`
      + ' —— 只报数，不拦截（v2.3 §10.2.3）',
    `      源数 20 是旧口径的历史参考（当前 ${report.sources}），不作失败条件。`,
    '',
    '| 源 | 等级 | 工具数 |',
    '|---|---|---|',
    ...report.perSource.map((source) => `| ${source.id} | ${source.tier} | ${source.tools} |`),
    '',
    `默认推荐集（清单 ${report.defaultSetSources.join(', ')}）：${report.defaultSetTools} 工具，软建议 ≤ ${report.maxDefaultSetTools}`
      + (report.overDefaultSuggestion ? ' ⚠️ 已超建议，32K 级上下文会明显拥挤（仅警示，不失败）' : ' ✅'),
  ];

  if (report.subscription) {
    lines.push(
      `订阅集（PLANTOMICS_SOURCES=${report.subscription.requested.join(',')}）：`
        + `${report.subscription.tools} 工具 / 硬上限 ${report.maxSubscriptionTools}`
        + (report.overBudget ? ' ❌ 超限' : ' ✅'),
    );
  } else {
    lines.push(
      `订阅集：本次未指定（未设 PLANTOMICS_SOURCES）→ 只报默认集；` +
        `硬上限 ${report.maxSubscriptionTools} 工具只对**指定了订阅集**的请求生效`,
    );
  }

  // 语义要说准：有订阅集时报订阅集，没有时报默认集。两个数混用会让"当前集"变成假的。
  // 百分比不在脚本里另算一套——占比口径的唯一真相是 AGENTS §10.2，脚本只报 token 数。
  const scopeLabel = report.subscription ? '订阅集' : '默认集';
  const scopeTokens = report.subscription ? report.subscriptionTokens : report.tokenEstimate;
  lines.push(
    `token 估算：每工具约 ${report.tokensPerTool}（实测 37 工具 10,274 token 折算）；`
      + `${scopeLabel}约 ${scopeTokens} token；`
      + `${report.maxSubscriptionTools} 工具约 ${report.maxSubscriptionTools * report.tokensPerTool} token。`
      + '上下文占比口径见 AGENTS §10.2（脚本不另算百分比）',
  );

  if (report.overBudget) {
    lines.push(
      `❌ 订阅集 ${report.subscription.tools} 工具 > 上限 ${report.maxSubscriptionTools}：`
        + '拒绝或强警示（§10.2.1）。减源、改用更小的订阅集，或先把源合并为更少的意图级工具。',
    );
  }

  return `${lines.join('\n')}\n`;
}

/** README 标记块：只放稳定数字，不放 builtAt（每次构建都变，会让校验天天红）。 */
export function renderReadmeBlock(counts) {
  const metaNote = counts.metaTools > 0 ? `（含 ${counts.metaTools} 个元工具）` : '';
  return [
    README_BEGIN,
    `> **当前源码口径：${counts.sources} 源、${counts.tools} 工具${metaNote}。**`
      + ' 本块由 `npm run counts -- --write` 从 `dist/` 实测生成，勿手改；'
      + '已发布包能装到什么另见 `npm run counts -- --published`（两者可以不同，发布滞后不是索引写错）。',
    README_END,
  ].join('\n');
}

/** 市场索引描述里的数量短语：发布口径的规范措辞，前后端都别自己拼。 */
export function renderDescriptionClause(counts) {
  return {
    zh: `${counts.sources} 个植物组学数据库、${counts.tools} 个 MCP 工具`,
    en: `${counts.sources} plant-omics databases behind ${counts.tools} MCP tools`,
  };
}

/**
 * README 里散落的数量：每条 = 一个正则 + 它的规范渲染。
 *
 * 为什么不都做成标记块：`/healthz` 示例与已知限制是句子里夹的数字，硬塞块会把句子切断，
 * 读起来更糟。这里用「唯一正则 + 唯一渲染」，`--write` 会照着改，`--check` 会照着核，
 * 另写一套文案就会红——这就是要的效果。
 */
export function inlineNumberRules(counts) {
  const metaField = counts.metaTools > 0 ? `,"metaTools":${counts.metaTools}` : '';
  return [
    {
      label: '/healthz 示例里的源数与工具数',
      pattern: /"sources":\s*\d+,\s*"tools":\s*\d+(?:,\s*"metaTools":\s*\d+)?/g,
      render: `"sources":${counts.sources},"tools":${counts.tools}${metaField}`,
    },
    {
      label: '「默认加载清单」句里的源清单与工具数',
      // 兼容旧措辞（「当前源码的 N 个工具默认全部加载（订阅集上限 M 个）」），
      // 否则旧 README 永远改不成新口径。新措辞必须**列出完整清单**：
      // render 里带 DEFAULT_SET_SOURCES，所以清单变了而 README 没改，这条就会红——
      // 锁的是"清单与代码一致"，不是"那句话的措辞好看"。
      // 三种形态都要认：
      //   ① 旧旧措辞「当前源码的 N 个工具仍全量常驻（规则允许到 M 个）」
      //   ② 旧措辞「当前源码的 N 个工具默认全部加载（订阅集上限 M 个）」
      //   ③ 新措辞「默认加载清单 … （订阅集上限 M 个）」
      pattern: /(?:当前源码的\s*\d+\s*个工具(?:仍全量常驻（规则允许到|默认全部加载（订阅集上限)\s*\d+\s*个）|默认加载清单[^\n]*?（订阅集上限\s*\d+\s*个）)/g,
      render: `默认加载清单 ${counts.defaultSetSources.length} 个源、${counts.defaultSetTools} 个工具（`
        + `${counts.defaultSetSources.join('、')}）；清单外的源用 \`x-plantomics-sources\` 或 \`PLANTOMICS_SOURCES\` 自取`
        + `（订阅集上限 ${MAX_SUBSCRIPTION_TOOLS} 个）`,
    },
  ];
}

/** 逐条核对内联数量：缺句子或数不对都算问题。 */
export function checkInlineNumbers(readme, counts) {
  const problems = [];
  for (const rule of inlineNumberRules(counts)) {
    const matches = readme.match(rule.pattern) ?? [];
    if (matches.length === 0) {
      problems.push(`README 找不到「${rule.label}」，或措辞已改（改措辞要同步 scripts/counts.mjs 的规则）`);
      continue;
    }
    for (const match of matches) {
      if (match !== rule.render) {
        problems.push(`README「${rule.label}」写的是 ${match}，应为 ${rule.render}`);
      }
    }
  }
  return problems;
}

/** 把内联数量改写成规范结果。 */
export function rewriteInlineNumbers(readme, counts) {
  let next = readme;
  for (const rule of inlineNumberRules(counts)) next = next.replace(rule.pattern, rule.render);
  return next;
}

function readReadme(readmePath = path.join(ROOT, 'README.md')) {
  return readFileSync(readmePath, 'utf8');
}

/** 校验 README 标记块：与当前生成结果逐字一致（想改措辞就改生成器，别手改 README）。 */
export function checkReadmeBlock(readme, counts) {
  const begin = readme.indexOf(README_BEGIN);
  const end = readme.indexOf(README_END);
  if (begin < 0 || end < 0 || end < begin) {
    return [`README 缺少 ${README_BEGIN} / ${README_END} 标记块（数字无处生成，就会手写过期）`];
  }
  const actual = readme.slice(begin, end + README_END.length);
  const expected = renderReadmeBlock(counts);
  if (actual.trim() !== expected.trim()) {
    return ['README 的 counts 标记块与 dist 实测不一致（或措辞被手改）：跑 `npm run counts -- --write`'];
  }
  return [];
}

/** README「现在支持什么」表格：逐源的等级与工具数必须与注册表一致。 */
export function checkReadmeTable(readme, counts) {
  const problems = [];
  const sectionStart = readme.indexOf('## 现在支持什么');
  if (sectionStart < 0) return ['README 找不到「## 现在支持什么」小节，无法核对逐源数字'];

  const seen = new Set();
  for (const rawLine of readme.slice(sectionStart).split('\n').slice(1)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const bold = /\*\*(.+?)\*\*/.exec(cells[0]);
    if (!bold) continue; // 表头与分隔行
    const label = bold[1].trim();
    /**
     * **全等匹配，且必须恰好一条**（2026-11-03）。
     *
     * 原来用 startsWith：两个源的 displayName 一旦有包含关系（「小麦」与「小麦多组学（WheatOmics）」），
     * 它会悄悄匹配到错的那行还照样绿——文案写错应该让检查器喊出来，而不是让它找近似。
     */
    const hits = counts.perSource.filter((candidate) => candidate.displayName === label);
    if (hits.length !== 1) {
      problems.push(
        hits.length === 0
          ? `README 表格里的源「${label}」在注册表里不存在（源被删/改名后表格没跟着改）`
          : `README 表格里的源「${label}」在注册表里命中 ${hits.length} 条：displayName 有重复，先改 manifest`,
      );
      continue;
    }
    const source = hits[0];
    if (seen.has(source.id)) {
      problems.push(`README 表格里的源「${label}」重复出现`);
      continue;
    }
    seen.add(source.id);
    if (cells[1] !== source.tier) {
      problems.push(`README 表格「${label}」等级写 ${cells[1]}，注册表是 ${source.tier}`);
    }
    const declared = Number(cells[3]);
    if (!Number.isInteger(declared)) {
      problems.push(`README 表格「${label}」工具数不是整数：${cells[3]}`);
    } else if (declared !== source.tools) {
      problems.push(`README 表格「${label}」工具数写 ${declared}，注册表是 ${source.tools}`);
    }
  }

  for (const source of counts.perSource) {
    if (!seen.has(source.id)) {
      problems.push(`README 表格缺少源「${source.displayName}」（注册表有、表格没登记）`);
    }
  }
  return problems;
}

/**
 * 预算口径检查（v2.3 源市场制）。
 *
 * 分两层，缺一层都可能是「换个名字继续用旧口径」：
 *
 * ① **常量一致性**：新阈值必须三处同值——
 *    `MAX_SUBSCRIPTION_TOOLS`（counts）↔ `SUBSET_TOOLS_HARD_MAX`（budget.ts）= 80；
 *    `MAX_TOOLS`（counts，已改义为默认集软建议）↔ `DEFAULT_SET_TOOLS_SOFT_MAX`（budget.ts）= 40。
 *    历史常量（20 源 / 40 工具）只允许作为**展示**存在，且必须与 budget.ts 的 HISTORICAL_* 对齐。
 *    `stats.mjs` 不再自带数字：它只调 counts 的判定函数。
 *
 * ② **行为断言**：光比常量名和数字，等于「把旧常量换个名字」。这里直接喂构造数据给
 *    `buildBudgetReport()`，看它到底拦不拦：81 必须红、80 不红、默认集 41 只警示、
 *    全库 200 源 200 工具不红。**行为不对，名字对也没用。**
 */
/**
 * 规则文件（`AGENTS.md`）核对的三态。
 *
 * 为什么要三态：两态（有/无都当错误）会让**任何外部 clone 的 `npm test` 必红**——
 * `AGENTS.md` 被 `.gitignore` 忽略、从不进公开仓，缺它不是仓库坏了，是这个检出本来就没有规则文件；
 * 两态（有/无都放过）又会变成静默跳过，规则被改而代码没跟也没人发现。
 * 所以这里返回**显式状态值**，由调用方分别断言，谁也糊弄不了：
 *   `{ status: 'checked', problems: [], threshold: 80, soft: 40 }` 文件在，当前口径两档都对得上
 *   `{ status: 'checked', problems: [ ... ] }`                     文件在但规则对不上 / 读不了 → 必须红
 *   `{ status: 'rules-file-absent', problems: [] }`                文件**真不存在**（ENOENT）→ 未核对
 *
 * 取值口径（R12 两轮复验逼出来的，不是"能跑就行"）：
 *   ① **只认当前口径所在的小节**：先剥 HTML 注释，再定位「十、入口与工具数量预算」里的 10.1，
 *      历史沿革（10.4）、正文示例、注释里的同形表格都不参与——否则"先写个旧表格 80、再写当前 999"
 *      或"用注释包住旧 80"都能骗过检查（R12-B1）。
 *   ② **同一行只许出现一次**：出现两次就红——重复行意味着"哪条算数"没有答案，猜一条等于放水。
 *   ③ **完整解析整数，不取前缀**：`≤ 80.5` 必须被拒，不许截成 80（R12-B1）；格式不合规等于红。
 *   ④ **两档都核**：硬上限（唯一硬阈值）与默认推荐集软建议（R12-B1 残留）。
 *   ⑤ **读失败 ≠ 文件不存在**：只有 ENOENT 算未核对，EACCES / 路径是目录 / 编码坏一律红（R12-C1）。
 */
const RULES_SECTION = /^#\s*十、[\s\S]*?(?=^#\s*十一、)/m;

/**
 * 剥掉 HTML 注释与 **Markdown 围栏代码块**后，取「十、」那一节的 10.1 小节正文。
 *
 * 围栏必须整块删掉：正文里贴一段示例（里面自带「十、/10.1/十一」的完整假文档）
 * 会把定位骗到示例里去（R12 第二轮实测）。反引号 ``` 与波浪号 ~~~ 两种围栏都算。
 * 删掉后，示例里的标题既不算节、也不算小节。
 *
 * 10.1 出现两次直接拒绝——"哪段才算当前口径"没有答案时，猜第一个就是放水。
 */
function ruleScope(text) {
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, '')
    // 反引号围栏（``` 或更多），整块删
    .replace(/^[ \t]*`{3,}[^\n]*\n[\s\S]*?^[ \t]*`{3,}[ \t]*$/gm, '')
    // 波浪号围栏（~~~），整块删——只认 ``` 的话，示例用 ~~~ 包起来就又能冒充现行规则
    .replace(/^[ \t]*~{3,}[^\n]*\n[\s\S]*?^[ \t]*~{3,}[ \t]*$/gm, '');
  const section = RULES_SECTION.exec(cleaned)?.[0];
  if (!section) return { error: 'AGENTS.md 里找不到「十、入口与工具数量预算」这一节：规则结构变了，先对规则' };
  const headings = section.match(/^##\s*10\.1(?=\s|$)/gm) ?? [];
  if (headings.length === 0) return { error: '第十节里找不到 10.1 小节（当前口径表所在）：规则结构变了，先对规则' };
  if (headings.length > 1) {
    return { error: `第十节里出现了 ${headings.length} 个 10.1 小节：无法判断哪段是当前口径，先合并成一段` };
  }
  // 注意结尾用 (?![\s\S]) 而不是 $：多行模式下 $ 会匹配行尾，小节会被截成第一行。
  const sub = /^##\s*10\.1[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(section);
  if (!sub) return { error: '10.1 小节内容取不出来：规则结构变了，先对规则' };
  return { scope: sub[1] };
}

/**
 * 从当前口径小节里取「标签 | ≤ N（说明） | …」这一行。
 *
 * 按**单元格**解析，不按整行找第一个 `≤`（R12 第二轮实测的反例：说明列先写一个 ≤ 80，
 * 真正的值列写 ≤ 999，按整行找会取到 80 然后报"对得上"）。规则：
 *   - 行必须是表格行，第一格是标签，第二格是值；
 *   - 值格必须**整格**就是「≤ 整数（说明）」，不做前缀匹配、不接受小数；
 *   - 标签格和其它格不许再出现 `≤`（否则又是一处歧义）；
 *   - 同一标签在当前口径里只许出现一次。
 */
function parseLimitRow(scope, label, suffix) {
  // 只认"行首就是 |"的表格行：缩进 4 格的缩进代码块里的表（Markdown 的另一种代码块）
  // 因此不会被当成现行表格；真被缩进了就找不到行 → 红（安全失败），不是静默放过。
  const rows = scope.split('\n').filter((line) => line.startsWith('|') && line.includes(label));
  if (rows.length === 0) return { error: `当前口径（10.1）里找不到「${label}」这一行：规则被改/被删` };
  if (rows.length > 1) {
    return { error: `「${label}」在当前口径里出现 ${rows.length} 次：哪条算数没有答案，先删掉重复行` };
  }
  const line = rows[0].trim();
  const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  if (cells.length < 3) {
    return { error: `「${label}」行不是「标签 | 阈值 | 说明」三列表格行：${line}` };
  }
  if (!cells[0].includes(label)) {
    return { error: `「${label}」没有出现在第一格（标签列）：${line}` };
  }
  const otherCells = cells.filter((_, index) => index !== 1);
  if (otherCells.some((cell) => cell.includes('≤'))) {
    return { error: `「${label}」行的阈值出现在除值列以外的单元格里，无法判断哪格算数：${line}` };
  }
  const valueCell = cells[1].replace(/\*/g, '').trim();
  // 整格匹配：≤ 整数（说明），小数/全角/带前缀说明一律不合格
  const match = /^≤\s*(\d+)(?![\d.])\s*（([^）]*)）$/.exec(valueCell);
  if (!match) {
    return { error: `「${label}」的值列不是「≤ 整数（说明）」：${valueCell}（80.5 这类小数/异常写法一律算不合格）` };
  }
  if (suffix && !match[2].includes(suffix)) {
    return { error: `「${label}」的值列缺少「${suffix}」字样：${valueCell}` };
  }
  return { value: Number(match[1]) };
}

export function inspectRulesAnchor(root = ROOT) {
  let agents;
  try {
    agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  } catch (error) {
    // 只有"文件确实不在"才算未核对；读不了是故障，必须红，不许伪装成 absent。
    if (error?.code === 'ENOENT') return { status: 'rules-file-absent', problems: [] };
    return {
      status: 'checked',
      problems: [`读 AGENTS.md 失败（${error?.code ?? 'unknown'}：${error?.message ?? error}）：不是"没有规则文件"，是这个文件读不了`],
    };
  }

  const scope = ruleScope(agents);
  if (scope.error) return { status: 'checked', problems: [scope.error] };

  const problems = [];
  const hard = parseLimitRow(scope.scope, '单次订阅集工具数', '唯一硬阈值');
  const soft = parseLimitRow(scope.scope, '默认推荐集', '软建议');

  if (hard.error) problems.push(hard.error);
  else if (hard.value !== MAX_SUBSCRIPTION_TOOLS) {
    problems.push(
      `AGENTS.md 当前口径写 ≤ ${hard.value}，代码常量 MAX_SUBSCRIPTION_TOOLS=${MAX_SUBSCRIPTION_TOOLS}：`
        + '改阈值必须先改规则、再改代码，两边不许各说各话',
    );
  }
  if (soft.error) problems.push(soft.error);
  else if (soft.value !== DEFAULT_SET_TOOLS_SOFT_MAX) {
    problems.push(
      `AGENTS.md 当前口径的默认推荐集写 ≤ ${soft.value}，代码常量 DEFAULT_SET_TOOLS_SOFT_MAX=${DEFAULT_SET_TOOLS_SOFT_MAX}：`
        + '源码常量写对不能证明规则正文也对',
    );
  }

  return { status: 'checked', problems, threshold: hard.value, soft: soft.value };
}

export function checkBudgetConstants(root = ROOT) {
  const problems = [];

  const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

  // 常量被删时直接引用会抛 ReferenceError，脚本看起来像崩了。
  // `typeof` 对未声明标识符是安全的，用它先探一次：缺了就用自己的话报错，并跳过行为断言。
  const CAP = typeof MAX_SUBSCRIPTION_TOOLS === 'number' ? MAX_SUBSCRIPTION_TOOLS : null;
  const SOFT = typeof DEFAULT_SET_TOOLS_SOFT_MAX === 'number' ? DEFAULT_SET_TOOLS_SOFT_MAX : null;
  if (CAP === null) problems.push('scripts/counts.mjs 缺少常量 MAX_SUBSCRIPTION_TOOLS（订阅集硬上限），预算判定无法进行');
  if (SOFT === null) problems.push('scripts/counts.mjs 缺少常量 DEFAULT_SET_TOOLS_SOFT_MAX（默认集软建议），预算判定无法进行');

  /** 从源码里取 `const NAME = 数字;`（缺失时报自己的话，不让脚本崩成 ReferenceError） */
  const constantOf = (rel, name) => {
    const source = read(rel);
    const match = new RegExp(`const ${name} = (\\d+);`).exec(source);
    if (!match?.[1]) {
      problems.push(`${rel} 里找不到常量 ${name}（阈值定义缺失，不是脚本崩溃）`);
      return null;
    }
    return Number(match[1]);
  };

  /**
   * ⓪ **字面锚定**：规则写死 80 / 40，代码里也必须是这两个数。
   *
   * 为什么光比「counts ↔ budget 相等」不够（审查实测过）：三处一起改成 81/41 仍然全绿，
   * 那保护的是「改的时候记得一起改」，不是「数字等于规则」。这里钉死字面值，
   * 规则真要改（AGENTS §10.2）就必须**同时**改代码，改不动就红——这是故意的。
   */
  const anchors = [
    { name: 'MAX_SUBSCRIPTION_TOOLS', expected: 80, rule: 'AGENTS.md §10.2 订阅集硬上限' },
    { name: 'DEFAULT_SET_TOOLS_SOFT_MAX', expected: 40, rule: 'AGENTS.md §10.2 默认推荐集软建议' },
  ];
  for (const anchor of anchors) {
    const actual = constantOf(path.join('scripts', 'counts.mjs'), anchor.name);
    if (actual !== null && actual !== anchor.expected) {
      problems.push(
        `${anchor.name}=${actual}，但规则是 ${anchor.expected}（${anchor.rule}）：改阈值必须先改规则，再改这里`,
      );
    }
  }

  // 规则文档存在性：§10.2 里仍写着「≤ 80」。只做存在性判断，不解析结构，排版变了不会误报。
  // 三态由 inspectRulesAnchor 给出：文件在 → 真核；文件不在 → 明确「未核对」，**不当成错误**。
  const rules = inspectRulesAnchor(root);
  problems.push(...rules.problems);

  // ① 常量一致性：新阈值两处同值；历史常量只作展示，也要对齐
  const pairs = [
    { countsName: 'MAX_SUBSCRIPTION_TOOLS', budgetName: 'SUBSET_TOOLS_HARD_MAX', label: '订阅集硬上限' },
    { countsName: 'DEFAULT_SET_TOOLS_SOFT_MAX', budgetName: 'DEFAULT_SET_TOOLS_SOFT_MAX', label: '默认集软建议' },
    { countsName: 'HISTORICAL_SOURCE_LIMIT', budgetName: 'HISTORICAL_SOURCE_LIMIT', label: '历史源数上限（只展示）' },
    { countsName: 'HISTORICAL_TOOL_LIMIT', budgetName: 'HISTORICAL_TOOL_LIMIT', label: '历史工具上限（只展示）' },
  ];
  for (const pair of pairs) {
    const inCounts = constantOf(path.join('scripts', 'counts.mjs'), pair.countsName);
    const inBudget = constantOf(path.join('src', 'service', 'budget.ts'), pair.budgetName);
    if (inCounts !== null && inBudget !== null && inCounts !== inBudget) {
      problems.push(`${pair.label}不一致：counts.${pair.countsName}=${inCounts}，budget.${pair.budgetName}=${inBudget}`);
    }
  }

  // 兼容别名不许漂：MAX_TOOLS 必须等于默认集软建议，MAX_SOURCES 必须等于历史源上限
  const aliasChecks = [
    { alias: 'MAX_TOOLS', target: 'DEFAULT_SET_TOOLS_SOFT_MAX' },
    { alias: 'MAX_SOURCES', target: 'HISTORICAL_SOURCE_LIMIT' },
  ];
  for (const alias of aliasChecks) {
    const aliasSource = read(path.join('scripts', 'counts.mjs'));
    const defined = new RegExp(`const ${alias.alias} = ${alias.target};`).test(aliasSource);
    if (!defined) {
      problems.push(`scripts/counts.mjs 的兼容别名 ${alias.alias} 必须定义成 = ${alias.target}（别让别名自己漂）`);
    }
  }

  // stats.mjs 不许自带阈值数字：它必须用 counts 的判定
  const statsSource = read(path.join('scripts', 'stats.mjs'));
  const ownConstant = /const\s+(MAX_[A-Z_]+|SUBSET_[A-Z_]+|DEFAULT_SET_[A-Z_]+|HISTORICAL_[A-Z_]+)\s*=\s*\d+;/.exec(statsSource);
  if (ownConstant) {
    problems.push(`scripts/stats.mjs 自带阈值常量 ${ownConstant[0]}：判定必须走 scripts/counts.mjs，不许两套数`);
  }
  if (!/from '\.\/counts\.mjs'/.test(statsSource)) {
    problems.push("scripts/stats.mjs 没有从 './counts.mjs' 引入判定函数");
  }

  // ② 行为断言：拿构造数据直接喂判定函数，看它拦不拦
  const fakeCounts = (sources, tools) => ({
    schemaVersion: COUNTS_SCHEMA_VERSION,
    scope: 'source',
    sources,
    sourceTools: tools,
    metaTools: 0,
    metaToolNames: [],
    tools,
    // 行为断言里为了构造「超大库」，默认集就当全库算；默认可单独覆盖
    defaultSetSources: [],
    defaultSetTools: tools,
    perSource: [],
    buildInfo: {},
  });

  // 常量缺失时跳过行为断言（前面已报过「缺少常量」，这里不再拿 undefined 去算）
  const behaviorCases = CAP === null || SOFT === null ? [] : [
    {
      label: `订阅集 ${CAP + 1} 工具必须判为超硬上限`,
      run: () => buildBudgetReport(fakeCounts(8, 37), { requested: ['x'], sources: 8, tools: CAP + 1 }),
      expect: (r) => r.overBudget === true,
    },
    {
      label: `订阅集 ${CAP} 工具不应判超限`,
      run: () => buildBudgetReport(fakeCounts(8, 37), { requested: ['x'], sources: 8, tools: CAP }),
      expect: (r) => r.overBudget === false,
    },
    {
      label: `默认集 ${SOFT + 1} 工具只警示、不判超限`,
      run: () => buildBudgetReport(fakeCounts(8, SOFT + 1)),
      expect: (r) => r.overDefaultSuggestion === true && r.overBudget === false,
    },
    {
      label: '全库 200 源 / 200 工具不因全库数字判失败',
      run: () => buildBudgetReport(fakeCounts(200, 200)),
      expect: (r) => r.overBudget === false,
    },
  ];
  for (const testCase of behaviorCases) {
    let report;
    try {
      report = testCase.run();
    } catch (error) {
      // 常量被删时判定函数会抛 ReferenceError：这里翻译成校验失败，而不是让脚本崩掉
      problems.push(`预算行为无法判定（${testCase.label}）：${error.message}——多半是阈值常量被删或改名`);
      continue;
    }
    if (!testCase.expect(report)) {
      problems.push(`预算行为不对：${testCase.label}`);
    }
  }

  return problems;
}

/**
 * 置顶顺序一致性：`src/core/pinned-sources.json` 是唯一来源，`dist` 必须是它的副本，
 * 且客户端清单前 N 个源必须正好是置顶清单（顺序也一致）。
 *
 * 为什么放进 `--check`：置顶丢一个 id 或顺序被别处排序覆盖，页面看起来"只是顺序怪"，
 * 不会报错——这种静默失效只能靠断言抓。
 */
export function checkPinnedSources({ counts, root = ROOT, catalog }) {
  const problems = [];
  const srcPath = path.join(root, 'src', 'core', 'pinned-sources.json');
  const distPath = path.join(root, 'dist', 'core', 'pinned-sources.json');

  let srcText;
  try {
    srcText = readFileSync(srcPath, 'utf8');
  } catch (error) {
    return [`缺少 src/core/pinned-sources.json（${error.message}）：置顶顺序的唯一来源，不能没有`];
  }

  let pinnedData;
  try {
    pinnedData = JSON.parse(srcText);
  } catch (error) {
    return [`src/core/pinned-sources.json 不是合法 JSON：${error.message}`];
  }
  if (pinnedData?.schemaVersion !== 1 || !Array.isArray(pinnedData?.pinned)) {
    problems.push('src/core/pinned-sources.json 形状不对：需要 {"schemaVersion":1,"pinned":["…"],"note":"…"}');
    return problems;
  }
  const pinned = pinnedData.pinned;

  const known = new Set(counts.perSource.map((source) => source.id));
  for (const id of pinned) {
    if (typeof id !== 'string' || !known.has(id)) {
      problems.push(`置顶清单里的源「${String(id)}」不在注册表里（已登记：${[...known].join(', ')}）`);
    }
  }

  let distText;
  try {
    distText = readFileSync(distPath, 'utf8');
  } catch {
    problems.push('dist/core/pinned-sources.json 缺失：先 npm run build（构建时从 src 复制）');
    return problems;
  }
  if (distText !== srcText) {
    problems.push('dist/core/pinned-sources.json 与 src 不一致：重跑 npm run build（构建时复制）');
  }

  if (catalog) {
    if (JSON.stringify(catalog.pinned) !== JSON.stringify(pinned)) {
      problems.push(
        `客户端清单的 pinned 是 ${JSON.stringify(catalog.pinned)}，与 src 的 ${JSON.stringify(pinned)} 不一致`,
      );
    }
    const head = catalog.sources.slice(0, pinned.length).map((source) => source.id);
    if (JSON.stringify(head) !== JSON.stringify(pinned)) {
      problems.push(`客户端清单前 ${pinned.length} 个源是 ${JSON.stringify(head)}，应等于置顶清单 ${JSON.stringify(pinned)}`);
    }
    for (const source of catalog.sources) {
      const shouldPin = pinned.includes(source.id);
      if (source.pinned !== shouldPin) {
        problems.push(`客户端清单 ${source.id} 的 pinned=${source.pinned}，应为 ${shouldPin}`);
      }
    }
  } else {
    problems.push('没拿到客户端清单：无法核对置顶顺序（dist/client/catalog.js 缺失？先 npm run build）');
  }

  return problems;
}

/**
 * 源图标一致性：`src/core/source-icons.json` 也是唯一来源，`dist` 必须是它的副本，
 * 且注册表里的每个源都得有图标（缺了页面会显示「?」，但那是兜底，不是通过）。
 */
export function checkSourceIcons({ counts, root = ROOT }) {
  const problems = [];
  const srcPath = path.join(root, 'src', 'core', 'source-icons.json');
  const distPath = path.join(root, 'dist', 'core', 'source-icons.json');

  let srcText;
  try {
    srcText = readFileSync(srcPath, 'utf8');
  } catch (error) {
    return [`缺少 src/core/source-icons.json（${error.message}）：源图标的唯一来源，不能没有`];
  }

  let parsed;
  try {
    parsed = JSON.parse(srcText);
  } catch (error) {
    return [`src/core/source-icons.json 不是合法 JSON：${error.message}`];
  }
  if (parsed?.schemaVersion !== 1 || typeof parsed?.sources !== 'object' || parsed.sources === null) {
    problems.push('src/core/source-icons.json 形状不对：需要 {"schemaVersion":1,"sources":{"<源 id>":{"color","svg"}}}');
    return problems;
  }

  for (const source of counts.perSource) {
    const icon = parsed.sources[source.id];
    if (!icon) {
      problems.push(`源「${source.id}」没有图标（会显示「?」占位）`);
      continue;
    }
    if (typeof icon.svg !== 'string' || icon.svg.trim() === '') {
      problems.push(`源「${source.id}」的图标 svg 为空`);
    }
    if (typeof icon.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(icon.color)) {
      problems.push(`源「${source.id}」的主色不是 #rrggbb：${JSON.stringify(icon.color)}`);
    }
  }
  for (const id of Object.keys(parsed.sources)) {
    if (!counts.perSource.some((source) => source.id === id)) {
      problems.push(`图标表里的「${id}」不是注册表中的源（源删了图标没删）`);
    }
  }

  let distText;
  try {
    distText = readFileSync(distPath, 'utf8');
  } catch {
    problems.push('dist/core/source-icons.json 缺失：先 npm run build（构建时从 src 复制）');
    return problems;
  }
  if (distText !== srcText) {
    problems.push('dist/core/source-icons.json 与 src 不一致：重跑 npm run build（构建时复制）');
  }

  return problems;
}

/** 离线校验：预算口径 + README 标记块 + 逐源表格 + 内联数量 + 置顶顺序 + 源图标。 */
export function checkSourceScope({ counts, readme = readReadme(), root = ROOT, catalog }) {
  // 每道检查单独兜底：某一项因为常量被删/改名而抛异常时，报「哪一项、缺什么」，
  // 而不是让整条命令崩成一句 `X is not defined`（那看起来像脚本坏了，其实是校验失败）。
  const safely = (label, run) => {
    try {
      return run();
    } catch (error) {
      return [`${label} 执行失败：${error.message}——多半是阈值常量被删或改名，先看 scripts/counts.mjs 顶部的常量定义`];
    }
  };

  return [
    ...safely('预算口径检查', () => checkBudgetConstants(root)),
    ...safely('README 标记块', () => checkReadmeBlock(readme, counts)),
    ...safely('README 逐源表格', () => checkReadmeTable(readme, counts)),
    ...safely('README 内联数量', () => checkInlineNumbers(readme, counts)),
    ...safely('置顶顺序', () => checkPinnedSources({ counts, root, catalog })),
    ...safely('源图标', () => checkSourceIcons({ counts, root })),
  ];
}

/** 把 README 的标记块与内联数量都重写成当前结果；没有标记块直接抛，不猜位置。 */
export function writeReadme(counts, readmePath = path.join(ROOT, 'README.md')) {
  const readme = readFileSync(readmePath, 'utf8');
  const begin = readme.indexOf(README_BEGIN);
  const end = readme.indexOf(README_END);
  if (begin < 0 || end < begin) {
    throw new Error(`README 缺少 ${README_BEGIN} / ${README_END} 标记块，先补上标记再生成`);
  }
  const withBlock = readme.slice(0, begin) + renderReadmeBlock(counts) + readme.slice(end + README_END.length);
  const next = rewriteInlineNumbers(withBlock, counts);
  writeFileSync(readmePath, next);
  return next;
}

/* ------------------------------------------------------------------ *
 * 发布口径：下载 market 指向的 npm tarball，核完整性，数里面真实的工具
 * ------------------------------------------------------------------ */

/** 最小 tar 读取器：只取普通文件，够解 npm tarball，不引第三方依赖。 */
export function extractTarEntries(gzipped) {
  const tar = gunzipSync(gzipped);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeField, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    const body = tar.subarray(dataStart, dataStart + size);
    if (typeflag === '0' || typeflag === '\0') {
      entries.push({ name: name.replace(/^\.\//, ''), body });
    } else if (typeflag === 'L' || typeflag === 'x') {
      // pax / GNU 长名头：跳过，本包的路径都短于 100 字节，走到这里说明包结构变了
      throw new Error(`tarball 出现扩展头（type=${typeflag}），当前解析器不支持`);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function verifyIntegrity(buffer, integrity) {
  if (!integrity) throw new Error('registry 未给 integrity，无法确认包没被篡改');
  const [algorithm, expected] = integrity.split('-');
  if (!['sha512', 'sha384', 'sha256', 'sha1'].includes(algorithm)) {
    throw new Error(`不认识的 integrity 算法：${algorithm}`);
  }
  const actual = createHash(algorithm).update(buffer).digest('base64');
  if (actual !== expected) throw new Error(`tarball 完整性校验失败：期望 ${integrity}，实得 ${algorithm}-${actual}`);
  return integrity;
}

function unpackToTemp(entries) {
  const dir = mkdtempSync(path.join(tmpdir(), 'plantomics-published-'));
  for (const entry of entries) {
    if (!entry.name.startsWith('package/')) continue;
    const relative = entry.name.slice('package/'.length);
    if (relative === 'package.json' || relative.startsWith('dist/')) {
      const target = path.join(dir, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, entry.body);
    }
  }
  return dir;
}

/**
 * 取发布口径的数量事实：registry 的 latest 版本 tarball → 解包 → 跑包自己的注册表。
 * 联网；只用于发布前校验，不进 npm test。
 */
export async function collectPublishedCounts({ marketPath = path.join(ROOT, 'market', 'index.json') } = {}) {
  const market = JSON.parse(readFileSync(marketPath, 'utf8'));
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const plugin = (market.plugins ?? []).find((entry) => entry.name === pkg.name);
  if (!plugin) throw new Error(`market/index.json 里没有插件 ${pkg.name}`);

  const registryUrl = (process.env.npm_config_registry ?? 'https://registry.npmjs.org').replace(/\/$/, '');
  const packumentUrl = `${registryUrl}/${pkg.name.replace('/', '%2F')}`;
  const packument = await (await fetch(packumentUrl, { signal: AbortSignal.timeout(30_000) })).json();
  const latest = packument['dist-tags']?.latest;
  if (!latest) throw new Error('registry 没有 dist-tags.latest');
  const info = packument.versions?.[latest];
  if (!info?.dist?.tarball) throw new Error(`registry 的 ${latest} 没有 tarball 地址`);

  /**
   * 这里**不再**要求 market 已经登记 latest：那会把「市场索引落后」报成取数失败，
   * 使得 build-copy.mjs（靠本命令的 --json 取数）在索引落后时根本跑不起来——
   * 而索引落后恰恰是它要修的状态。版本一致性由 checkPublishedScope 判定为
   * 「数字 / 版本不一致」（mismatch），方向清楚。
   */

  const tarball = Buffer.from(
    await (await fetch(info.dist.tarball, { signal: AbortSignal.timeout(60_000) })).arrayBuffer(),
  );
  verifyIntegrity(tarball, info.dist.integrity);

  const tempDir = unpackToTemp(extractTarEntries(tarball));
  try {
    const entry = pathToFileURL(path.join(tempDir, 'dist', 'sources', 'index.js')).href;
    const { createRegistry } = await import(entry);
    const counts = collectCounts(createRegistry(), {
      scope: 'published',
      buildInfoPath: path.join(tempDir, 'dist', 'service', 'build-info.json'),
    });
    return {
      counts,
      latest,
      tarball: info.dist.tarball,
      integrityVerified: info.dist.integrity,
      packageVersion: counts.buildInfo?.packageVersion ?? latest,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * 发布口径校验：市场描述的数量短语必须等于 tarball 里真实的数量；
 * 市场索引第一条（用户实际安装的版本）必须就是 npm latest，且 source.type 是 npm。
 *
 * `latest` 由调用方从 registry 取；不传时只核描述（保留给纯函数测试）。
 */
export function checkPublishedScope({ counts, market, latest }) {
  const problems = [];
  const plugin = market.plugins?.[0];
  const clause = renderDescriptionClause(counts);
  const zh = plugin?.description?.zh ?? '';
  const en = plugin?.description?.en ?? '';
  if (!zh.includes(clause.zh)) {
    problems.push(`市场中文描述缺少现行数量短语「${clause.zh}」（实际 tarball 是这个数）`);
  }
  if (!en.includes(clause.en)) {
    problems.push(`市场英文描述缺少现行数量短语「${clause.en}」（实际 tarball 是这个数）`);
  }

  /**
   * 版本一致性：index.json 的 `versions[0]` 是市场实际安装目标（check-index.mjs 与官方
   * `marketInstallTarget` 都取第一条）。它必须等于 npm latest，否则市场会装到与发布包
   * 不同的版本——这正是「四条通道版本不一致」要拦的那类问题。
   *
   * 注意：这里核的是**发布口径**，不是源码 `package.json`。源码版本可以先于 npm 前进
   * （发布前必然如此）；发布后把新版本追加到 versions 第一条，这条闸才会转绿。
   */
  const versions = Array.isArray(plugin?.versions) ? plugin.versions : [];
  const newest = versions[0];
  if (latest !== undefined) {
    if (!versions.some((entry) => entry?.version === latest)) {
      problems.push(`market/index.json 没有登记 npm latest ${latest}（用户装不到 latest）`);
    } else if (newest?.version !== latest) {
      problems.push(
        `market/index.json 第一条是 ${newest?.version ?? '（缺）'}，npm latest 是 ${latest}：`
          + '市场会装到与 npm latest 不一致的版本',
      );
    }
  }
  if (newest && (newest.source?.type ?? 'npm') !== 'npm') {
    problems.push('market 里该版本的 source.type 不是 npm');
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

async function loadLocalCounts() {
  const entry = pathToFileURL(path.join(ROOT, 'dist', 'sources', 'index.js')).href;
  let module;
  try {
    module = await import(entry);
  } catch (error) {
    throw new Error(`读不到 dist/sources/index.js（先 npm run build）：${error.message}`);
  }
  return collectCounts(module.createRegistry());
}

function fail(problems, title) {
  process.stderr.write(`${title}\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exitCode = 1;
}

async function main(argv) {
  const flags = new Set(argv.slice(2));
  const asJson = flags.has('--json');

  if (flags.has('--published')) {
    let published;
    try {
      published = await collectPublishedCounts();
    } catch (error) {
      fail([error.message], '❌ 发布口径取数失败（联网检查，未计为通过）');
      return;
    }
    const market = JSON.parse(readFileSync(path.join(ROOT, 'market', 'index.json'), 'utf8'));
    const problems = checkPublishedScope({ counts: published.counts, market, latest: published.latest });
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ ...published, problems }, null, 2)}\n`);
      if (problems.length > 0) process.exitCode = 1;
      return;
    }
    const { counts } = published;
    process.stdout.write(
      `发布口径：npm ${published.counts.buildInfo?.packageVersion ?? ''}（latest ${published.latest}）`
        + ` ${counts.sources} 源 / ${counts.tools} 工具（源工具 ${counts.sourceTools} + 元工具 ${counts.metaTools}）\n`,
    );
    process.stdout.write(`  tarball ${published.tarball}\n  完整性 ${published.integrityVerified}\n`);
    process.stdout.write(`  构建自 ${counts.buildInfo?.sourceRev ?? '未知'} @ ${counts.buildInfo?.builtAt ?? '未知'}\n`);
    const sourceVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    process.stdout.write(
      sourceVersion === published.latest
        ? `  源码 package.json：${sourceVersion}（与 npm latest 相同）\n`
        : `  源码 package.json：${sourceVersion}（领先 npm latest，属发布前状态；发布后把该版本追加到 market/index.json 第一条）\n`,
    );
    if (problems.length > 0) fail(problems, '❌ 市场索引与发布包不一致');
    else process.stdout.write('✅ 市场索引：数量短语与版本都对得上发布包\n');
    return;
  }

  const counts = await loadLocalCounts();

  if (flags.has('--write')) {
    writeReadme(counts);
    process.stdout.write(
      `✅ README 已按 dist 重写：标记块 ${counts.sources} 源 / ${counts.tools} 工具，内联数量同步\n`,
    );
    return;
  }

  if (flags.has('--check')) {
    // 置顶顺序要核到"客户端清单真的按这个顺序渲染"，所以从 dist 里把清单造出来比对。
    let catalog;
    try {
      const mod = await import(pathToFileURL(path.join(ROOT, 'dist', 'client', 'catalog.js')).href);
      catalog = mod.buildCatalog();
    } catch (error) {
      catalog = undefined;
      process.stderr.write(`（读不到 dist/client/catalog.js：${error.message}；置顶顺序这一项会报缺失）\n`);
    }
    const problems = checkSourceScope({ counts, catalog });
    // 规则文件三态：不能让「没有 AGENTS.md」静默滑过去，所以每一次 --check 都要印出来。
    const rules = inspectRulesAnchor();
    const rulesNote = rules.status === 'checked'
      ? '规则核对：已核对 AGENTS.md 的「≤ 80」阈值'
      : '规则核对：**未核对** —— 本检出没有 AGENTS.md（公开仓不含规则文件）；'
        + `阈值以源码字面锚定 ${MAX_SUBSCRIPTION_TOOLS} / ${MAX_TOOLS} 为准，有规则文件时必须真核对`;
    if (asJson) process.stdout.write(`${JSON.stringify({ counts, problems, rules }, null, 2)}\n`);
    if (problems.length > 0) {
      fail(problems, '❌ 数量校验失败（README 与 dist 实测不符）');
      return;
    }
    process.stdout.write(`${rulesNote}\n`);
    process.stdout.write(
      `✅ 数量校验通过：README 标记块与逐源表格、预算口径（订阅集硬上限 ${MAX_SUBSCRIPTION_TOOLS} / 默认集软建议 ${MAX_TOOLS}，含 4 条行为断言）、置顶顺序、源图标都与 dist 一致`
        + `（${counts.sources} 源 / ${counts.tools} 工具，置顶 ${catalog?.pinned.join(', ') ?? '-'}）\n`,
    );
    return;
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
    return;
  }

  const lines = [
    `源码口径：${counts.sources} 源 / ${counts.tools} 工具（源工具 ${counts.sourceTools} + 元工具 ${counts.metaTools}）`,
    `构建：${counts.buildInfo?.sourceRev ?? '未知'} @ ${counts.buildInfo?.builtAt ?? '未知'}`,
    '',
    '| 源 | 等级 | 工具数 |',
    '|---|---|---|',
    ...counts.perSource.map((source) => `| ${source.id} | ${source.tier} | ${source.tools} |`),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((error) => {
    process.stderr.write(`❌ ${error.message}\n`);
    process.exitCode = 1;
  });
}

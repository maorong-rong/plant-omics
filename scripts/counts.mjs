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

/** 与当前工程预算一致；改这里必须同时改 `src/service/budget.ts` 与 `src/client/catalog.ts`，`--check` 会核。 */
export const MAX_SOURCES = 20;
export const MAX_TOOLS = 40;
/** 仅用于情景估算；不是每源最低/最高数量校验。能力较窄可少于 4，须另经审查。 */
export const ASSUMED_TOOLS_LOW = 4;
export const ASSUMED_TOOLS_HIGH = 8;

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
    tools,
    perSource: built,
    buildInfo: options.buildInfo !== undefined ? options.buildInfo : readBuildInfo(options.buildInfoPath),
  };
}

/** 预算判定（原 stats.mjs 的逻辑原样搬过来，字段名不变，别处有测试盯着）。 */
export function buildBudgetReport(counts) {
  const toolRoom = Math.max(0, MAX_TOOLS - counts.tools);
  const sourceRoom = Math.max(0, MAX_SOURCES - counts.sources);
  const sourcesByToolsMin = Math.floor(toolRoom / ASSUMED_TOOLS_HIGH);
  const sourcesByToolsMax = Math.floor(toolRoom / ASSUMED_TOOLS_LOW);

  return {
    sources: counts.sources,
    maxSources: MAX_SOURCES,
    tools: counts.tools,
    maxTools: MAX_TOOLS,
    toolRoom,
    sourceRoom,
    sourcesByToolsMin,
    sourcesByToolsMax,
    /** 40 以内可以全量暴露；超过就必须先做检索层（§10.2） */
    needsRetrievalLayer: counts.tools > MAX_TOOLS,
    /** 保留既有字段；其判定只在每源 8 工具假设下成立，不是硬门禁。 */
    bindingConstraint: toolRoom / ASSUMED_TOOLS_HIGH < sourceRoom ? 'tools' : 'sources',
    capacityEstimateAssumption: {
      toolsPerSourceLow: ASSUMED_TOOLS_LOW,
      toolsPerSourceHigh: ASSUMED_TOOLS_HIGH,
      isMinimumRequirement: false,
      bindingConstraintToolsPerSource: ASSUMED_TOOLS_HIGH,
    },
    perSource: counts.perSource,
    overBudget: counts.sources > MAX_SOURCES || counts.tools > MAX_TOOLS,
  };
}

export function renderStatsText(report) {
  const lines = [
    `源：${report.sources} / ${report.maxSources}`,
    `工具：${report.tools} / ${report.maxTools}`,
    '',
    '| 源 | 等级 | 工具数 |',
    '|---|---|---|',
    ...report.perSource.map((source) => `| ${source.id} | ${source.tier} | ${source.tools} |`),
    '',
  ];

  if (report.sources > report.maxSources) {
    lines.push(`❌ 源数超上限（${report.sources} > ${report.maxSources}）：按当前工程预算 不许再加。`);
  }
  if (report.needsRetrievalLayer) {
    lines.push(`⚠️ 工具数 ${report.tools} > ${report.maxTools}：**必须先实现检索层**再继续加源（§10.2）。`);
  }

  if (!report.overBudget && !report.needsRetrievalLayer) {
    lines.push(
      `✅ 第 1 阶段（全量暴露）。实际工具余量 ${report.toolRoom} 个，实际源余量 ${report.sourceRoom} 个。`,
    );
    lines.push(
      `   情景估算：仅假设新增源各有4–8工具，工具余量可容纳约 ${report.sourcesByToolsMin}–${report.sourcesByToolsMax} 个源（另受源余量限制）。`,
      `   4不是每源最低工具数；较窄能力可少于4个，须说明理由并独立审查，不凑数。`,
      `   按每源8工具假设的紧约束：${report.bindingConstraint === 'tools' ? '工具额度' : '源额度'}；接入门禁只按实际源≤20、工具≤40检查。`,
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
      label: '「全量常驻」句里的工具数与规则上限',
      pattern: /当前源码的\s*\d+\s*个工具仍全量常驻（规则允许到\s*\d+\s*个）/g,
      render: `当前源码的 ${counts.tools} 个工具仍全量常驻（规则允许到 ${MAX_TOOLS} 个）`,
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
    const source = counts.perSource.find((candidate) => candidate.displayName.startsWith(label));
    if (!source) {
      problems.push(`README 表格里的源「${label}」在注册表里不存在（源被删/改名后表格没跟着改）`);
      continue;
    }
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

/** 预算常量三处副本必须一致（counts → 运行时 budget.ts → 客户端 catalog.ts）。 */
export function checkBudgetConstants(root = ROOT) {
  const problems = [];
  const files = [
    path.join(root, 'scripts', 'counts.mjs'),
    path.join(root, 'src', 'service', 'budget.ts'),
    path.join(root, 'src', 'client', 'catalog.ts'),
  ];
  for (const name of ['MAX_SOURCES', 'MAX_TOOLS']) {
    const expected = name === 'MAX_SOURCES' ? MAX_SOURCES : MAX_TOOLS;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const match = new RegExp(`const ${name} = (\\d+);`).exec(source);
      if (!match?.[1]) {
        problems.push(`${path.relative(root, file)} 里找不到常量 ${name}`);
        continue;
      }
      if (Number(match[1]) !== expected) {
        problems.push(
          `${path.relative(root, file)} 的 ${name}=${match[1]}，与 scripts/counts.mjs 的 ${expected} 不一致`,
        );
      }
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

/** 离线校验：README 标记块 + 逐源表格 + 内联数量 + 预算常量 + 置顶顺序 + 源图标。 */
export function checkSourceScope({ counts, readme = readReadme(), root = ROOT, catalog }) {
  return [
    ...checkReadmeBlock(readme, counts),
    ...checkReadmeTable(readme, counts),
    ...checkInlineNumbers(readme, counts),
    ...checkBudgetConstants(root),
    ...checkPinnedSources({ counts, root, catalog }),
    ...checkSourceIcons({ counts, root }),
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

  const declared = (plugin.versions ?? []).find((entry) => entry.version === latest);
  if (!declared) throw new Error(`market/index.json 没有登记 ${latest}（用户装不到 latest）`);
  if ((declared.source?.type ?? 'npm') !== 'npm') throw new Error('market 里该版本的 source.type 不是 npm');

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

/** 发布口径校验：市场描述的数量短语必须等于 tarball 里真实的数量。 */
export function checkPublishedScope({ counts, market }) {
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
    const problems = checkPublishedScope({ counts: published.counts, market });
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
    if (problems.length > 0) fail(problems, '❌ 市场索引描述与发布包不一致');
    else process.stdout.write('✅ 市场索引的数量短语与发布包一致\n');
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
    if (asJson) process.stdout.write(`${JSON.stringify({ counts, problems }, null, 2)}\n`);
    if (problems.length > 0) {
      fail(problems, '❌ 数量校验失败（README 与 dist 实测不符）');
      return;
    }
    process.stdout.write(
      `✅ 数量校验通过：README 标记块与逐源表格、三处预算常量、置顶顺序、源图标都与 dist 一致`
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

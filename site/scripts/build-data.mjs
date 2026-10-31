#!/usr/bin/env node
/**
 * 落地页数据生成器（构建期快照）。
 *
 * 为什么不在页面里写死「8 源 37 工具」：写死的数字迟早过期，而过期的数字是**公开页面上的错**。
 * 这里直接读注册表（与 `npm run stats`、侧边栏面板同一份真相），再跑一次 `scripts/stats.mjs`
 * 交叉核对；两边不一致就非零退出，宁可不出页，也不出错的页。
 *
 * 产出：
 *   site/data/catalog.json   —— 给 Web 应用 / 其它消费者
 *   site/data/catalog.js     —— `window.__PLANTOMICS_CATALOG__`，让 index.html 用 <script> 引，
 *                                file:// 直开也能用（fetch 在 file:// 下会被拦）
 *
 * 用法：node site/scripts/build-data.mjs
 * 前置：npm run build（读 dist/，不读 src/）
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { META_LABELS, SOURCE_LABELS } from './labels.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'site', 'data');

/** 与 scripts/stats.mjs 同一口径（页面只做展示，不参与门禁判定）。 */
const MAX_SOURCES = 20;
const MAX_TOOLS = 40;

/**
 * 置顶顺序的**唯一来源**：`src/core/pinned-sources.json`（构建时被复制到 `dist/core/`）。
 *
 * 这里刻意不再写一份常量。以前 site 与 src/client 各有一份，两边各自维护、早晚有一个先变；
 * 现在顺序只在一处定义，读不到就**构建失败并指路**，绝不静默回退成注册表原序
 * ——回退是最难发现的错：页面看起来正常，只是顺序悄悄变了。
 */
const PINNED_FILE = join(ROOT, 'dist', 'core', 'pinned-sources.json');

/**
 * 源图标与主色的**唯一来源**：`src/core/source-icons.json`（构建时复制到 `dist/core/`）。
 *
 * 以前 site 手写一份 `assets/source-icons.js`、`src/client` 另有一份，改一处忘一处就漂。
 * 现在图标只在 JSON 里定义，`site/` 与 `web/` 的 JS 都由本脚本从它生成；缺图标、颜色不成
 * `#rrggbb`、或 JSON 里留着已删源的残留，都直接失败——不静默用占位图糊过去。
 */
const ICONS_FILE = join(ROOT, 'dist', 'core', 'source-icons.json');

const DIST_ENTRY = join(ROOT, 'dist', 'sources', 'index.js');

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** 读图标表并校验；缺失或形状不对直接失败（附路径），不猜、不占位。 */
function readSourceIcons() {
  if (!existsSync(ICONS_FILE)) {
    fail(
      `找不到源图标表：${ICONS_FILE}\n` +
        '  它是图标与主色的唯一来源，构建时由 src/core/source-icons.json 复制进 dist。\n' +
        '  先跑 npm run build（会复制并校验）；源文件本身缺失时，找代码改动者补。',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ICONS_FILE, 'utf8'));
  } catch (error) {
    fail(`源图标表不是合法 JSON：${ICONS_FILE}\n  ${error.message}`);
  }
  if (parsed.schemaVersion !== 1) {
    fail(`源图标表 schemaVersion 期望 1，实际 ${JSON.stringify(parsed.schemaVersion)}（${ICONS_FILE}）`);
  }
  const icons = parsed.sources;
  if (!icons || typeof icons !== 'object' || Array.isArray(icons)) {
    fail(`源图标表的 sources 必须是对象（${ICONS_FILE}）`);
  }
  for (const [id, entry] of Object.entries(icons)) {
    if (!entry || typeof entry !== 'object') fail(`图标 ${id} 必须是一个对象（${ICONS_FILE}）`);
    if (typeof entry.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(entry.color)) {
      fail(`图标 ${id} 的 color 必须是 #rrggbb，实际 ${JSON.stringify(entry.color)}（${ICONS_FILE}）`);
    }
    if (typeof entry.svg !== 'string' || entry.svg.trim() === '') {
      fail(`图标 ${id} 的 svg 为空（${ICONS_FILE}）`);
    }
  }
  return icons;
}

/** 把图标表写成浏览器可用的 JS（site 与 web 各一份，内容相同）。 */
function writeIconScript(target, icons) {
  const body = `(function () {
  // 由 site/scripts/build-data.mjs 从 dist/core/source-icons.json 生成，勿手改。
  window.__PMH_SOURCE_ICONS__ = ${JSON.stringify(icons, null, 2)};
})();
`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body, 'utf8');
}

function readPinnedSourceIds() {
  if (!existsSync(PINNED_FILE)) {
    fail(
      `找不到置顶清单：${PINNED_FILE}\n` +
        '  它是置顶顺序的唯一来源，构建时由 src/core/pinned-sources.json 复制进 dist。\n' +
        '  先跑 npm run build（会复制并校验）；源文件本身缺失时，找代码改动者补。',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(PINNED_FILE, 'utf8'));
  } catch (error) {
    fail(`置顶清单不是合法 JSON：${PINNED_FILE}\n  ${error.message}`);
  }
  if (parsed.schemaVersion !== 1) {
    fail(`置顶清单 schemaVersion 期望 1，实际 ${JSON.stringify(parsed.schemaVersion)}（${PINNED_FILE}）`);
  }
  if (!Array.isArray(parsed.pinned) || parsed.pinned.some((id) => typeof id !== 'string' || id === '')) {
    fail(`置顶清单的 pinned 必须是非空字符串数组（${PINNED_FILE}）`);
  }
  if (new Set(parsed.pinned).size !== parsed.pinned.length) {
    fail(`置顶清单里有重复 id：${parsed.pinned.join(', ')}（${PINNED_FILE}）`);
  }
  return parsed.pinned;
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** 跑 stats 拿「源：8 / 20　工具：37 / 40」这一行，作为交叉核对，不解析整张表。 */
function statsCounts() {
  const text = execFileSync(process.execPath, [join(ROOT, 'scripts', 'stats.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const sources = /源：\s*(\d+)\s*\/\s*(\d+)/.exec(text);
  const tools = /工具：\s*(\d+)\s*\/\s*(\d+)/.exec(text);
  if (!sources || !tools) fail('stats.mjs 输出里找不到「源：N / M」「工具：N / M」，脚本格式可能变了');
  return { sources: Number(sources[1]), tools: Number(tools[1]) };
}

async function main() {
  const { createRegistry } = await import(`file://${DIST_ENTRY.replaceAll('\\', '/')}`);
  const registry = createRegistry();
  const bundles = registry.listSources();

  const collected = bundles.map((bundle) => {
    const labels = SOURCE_LABELS[bundle.manifest.id];
    if (!labels) {
      fail(`源 "${bundle.manifest.id}" 没有中英文文案：在 site/scripts/labels.mjs 的 SOURCE_LABELS 里补一条`);
    }
    return {
      id: bundle.manifest.id,
      displayName: bundle.manifest.displayName,
      label: labels,
      tier: bundle.manifest.tier,
      homepage: bundle.manifest.homepage,
      species: [...bundle.manifest.species],
      caveats: [...(bundle.manifest.caveats ?? [])],
      versionNote: bundle.manifest.versionNote ?? '未知（上游未提供版本口径，本仓不推测）',
      toolCount: bundle.tools.length,
      tools: bundle.tools.map((tool) => ({
        name: tool.name,
        summary: summarize(tool.description),
      })),
    };
  });

  const staleLabels = Object.keys(SOURCE_LABELS).filter((id) => !collected.some((s) => s.id === id));
  if (staleLabels.length > 0) {
    fail(`labels.mjs 里有注册表中不存在的源：${staleLabels.join(', ')}（删掉或改正 id）`);
  }

  // 置顶顺序读唯一来源（dist/core/pinned-sources.json），不在本文件里另写一份。
  // `pinned` 也写进数据，页面据此加角标；数组顺序即展示顺序，未列出的源保持注册表原序。
  const pinnedIds = readPinnedSourceIds();
  const missingPinned = pinnedIds.filter((id) => !collected.some((s) => s.id === id));
  if (missingPinned.length > 0) {
    fail(
      `置顶清单里有注册表中不存在的源：${missingPinned.join(', ')}\n` +
        `  改 ${PINNED_FILE} 或 src/core/pinned-sources.json（数组顺序就是展示顺序）`,
    );
  }
  const sources = [
    ...pinnedIds.map((id) => collected.find((source) => source.id === id)),
    ...collected.filter((source) => !pinnedIds.includes(source.id)),
  ].map((source, index) => ({ ...source, pinned: pinnedIds.includes(source.id), order: index }));

  // 图标：从唯一来源读，逐个源核对，缺了/多了都失败（不静默用占位图）
  const sourceIcons = readSourceIcons();
  const missingIcons = sources.filter((source) => !sourceIcons[source.id]).map((source) => source.id);
  if (missingIcons.length > 0) {
    fail(
      `这些源没有图标：${missingIcons.join(', ')}\n` +
        `  在 src/core/source-icons.json 里补 { color: "#rrggbb", svg: "…" }（会复制到 ${ICONS_FILE}）`,
    );
  }
  const staleIcons = Object.keys(sourceIcons).filter((id) => !sources.some((source) => source.id === id));
  if (staleIcons.length > 0) {
    fail(
      `图标表里有注册表中不存在的源：${staleIcons.join(', ')}\n` +
        '  删掉这些条目，否则会让人以为还能查它们',
    );
  }
  // 只把注册表里真实存在的源写进前端脚本，顺序跟 sources 一致（页面按 catalog 顺序渲染）
  const orderedIcons = {};
  for (const source of sources) orderedIcons[source.id] = sourceIcons[source.id];

  const metaTools = registry.listMetaTools().map((tool) => {
    const labels = META_LABELS[tool.name];
    if (!labels) fail(`元工具 "${tool.name}" 缺英文说明：在 site/scripts/labels.mjs 的 META_LABELS 里补一条`);
    return { name: tool.name, summary: summarize(tool.description), label: labels };
  });

  const toolCount = sources.reduce((sum, source) => sum + source.toolCount, 0) + metaTools.length;
  const expected = statsCounts();

  // 三道对账：注册表自洽、与 stats 一致、不越预算。
  if (toolCount !== expected.tools) {
    fail(`工具数对不上：注册表算得 ${toolCount}，npm run stats 报 ${expected.tools}`);
  }
  if (sources.length !== expected.sources) {
    fail(`源数对不上：注册表算得 ${sources.length}，npm run stats 报 ${expected.sources}`);
  }
  if (sources.length > MAX_SOURCES || toolCount > MAX_TOOLS) {
    fail(`超出预算：源 ${sources.length}/${MAX_SOURCES}、工具 ${toolCount}/${MAX_TOOLS}`);
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    package: { name: pkg.name, version: pkg.version },
    build: readBuildInfo(),
    budget: { sources: sources.length, maxSources: MAX_SOURCES, tools: toolCount, maxTools: MAX_TOOLS },
    tiers: countTiers(sources),
    published: readPublishedScope(sources),
    sources,
    metaTools,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  writeFileSync(join(OUT_DIR, 'catalog.json'), json, 'utf8');
  writeFileSync(
    join(OUT_DIR, 'catalog.js'),
    `/* 由 site/scripts/build-data.mjs 生成，勿手改。源：dist/ 注册表。 */\nwindow.__PLANTOMICS_CATALOG__ = ${json.trim()};\n`,
    'utf8',
  );

  // `web/` 要能独立部署（Nginx 只挂 web/ 也能跑），所以数据与图标在这里一并投递一份。
  // 顺序、置顶、数字都来自这次生成——web/ 里不再自己算、也不再自己排。
  const webDir = join(ROOT, 'web', 'data');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(
    join(webDir, 'catalog.js'),
    `/* 由 site/scripts/build-data.mjs 生成，勿手改。源：dist/ 注册表。 */\nwindow.__PLANTOMICS_CATALOG__ = ${json.trim()};\n`,
    'utf8',
  );
  // 图标 JS 由 JSON 生成：site 与 web 各一份，内容相同（web 要能独立部署）。
  // 以前 site 那份是手写的、web 靠复制它；现在两处都从 dist/core/source-icons.json 生成，不再手改。
  writeIconScript(join(ROOT, 'site', 'assets', 'source-icons.js'), orderedIcons);
  writeIconScript(join(ROOT, 'web', 'assets', 'source-icons.js'), orderedIcons);
  copyFileSync(join(ROOT, 'site', 'favicon.svg'), join(ROOT, 'web', 'favicon.svg'));

  console.log(`✓ 已生成 site/data/catalog.{json,js}`);
  console.log(`  源 ${sources.length}/${MAX_SOURCES}，工具 ${toolCount}/${MAX_TOOLS}（含元工具 ${metaTools.length} 个）`);
  console.log(`  等级 T1 ${catalog.tiers.T1} / T2 ${catalog.tiers.T2} / T3 ${catalog.tiers.T3}`);
  console.log(`  快照 ${catalog.gitCommit ?? '（无 git）'} · ${catalog.generatedAt} · 包版本 ${pkg.version}`);
}

function summarize(description) {
  return String(description ?? '').trim();
}

/**
 * 构建信息（`dist/service/build-info.json`）：`sourceRev` 标记这份产物来自哪次源码构建。
 * 页面上的快照必须同时写「读到数据的时刻」和「产物来自哪次构建」，否则没人能判断这页新不新。
 */
function readBuildInfo() {
  const path = join(ROOT, 'dist', 'service', 'build-info.json');
  if (!existsSync(path)) return null;
  try {
    const info = JSON.parse(readFileSync(path, 'utf8'));
    return {
      sourceRev: info.sourceRev ?? null,
      builtAt: info.builtAt ?? null,
      packageVersion: info.packageVersion ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * 已发布包口径（「装上能拿到什么」）。
 *
 * 数字不在这里数：`market/copy.json` 由 `market/scripts/build-copy.mjs` 联网解包
 * `market/index.json` 指向的 npm tarball 算出（唯一实现在 `scripts/counts.mjs --published`）。
 * 本函数只做一件事——把「发布包里有几个源/工具」「源码里有但包里还没发布哪些源」摆到页面上，
 * 好让首屏的源码口径数字与安装段不被人读成同一件事。
 *
 * 文件不存在时返回 null，页面显示「未取数」，绝不猜一个数字出来。
 */
function readPublishedScope(sources) {
  const path = join(ROOT, 'market', 'copy.json');
  if (!existsSync(path)) return null;
  const copy = JSON.parse(readFileSync(path, 'utf8'));
  if (copy.scope !== 'published' || !copy.counts) return null;
  const publishedIds = new Set(copy.sourceIds ?? []);
  const missing = sources
    .filter((source) => !publishedIds.has(source.id))
    .map((source) => ({ id: source.id, name: source.label.zh.name, nameEn: source.label.en.name }));
  return {
    spec: copy.installed?.spec ?? null,
    sources: copy.counts.sources,
    tools: copy.counts.tools,
    metaTools: copy.counts.metaTools,
    sourceIds: [...publishedIds],
    missingSources: missing,
    snapshotAt: copy.generatedAt ?? null,
  };
}

function countTiers(sources) {
  const tiers = { T1: 0, T2: 0, T3: 0 };
  for (const source of sources) tiers[source.tier] = (tiers[source.tier] ?? 0) + 1;
  return tiers;
}

main().catch((error) => fail(error?.stack ?? String(error)));

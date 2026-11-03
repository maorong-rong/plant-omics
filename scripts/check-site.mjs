#!/usr/bin/env node
/**
 * 站点闸：`site/` 的两条硬规则（M3.1 验收③所需的负控也靠它）。
 *
 * 规则一 · 快照只放身份：`site/data/catalog.json` 与 `catalog.js` 不得出现
 * `sources / budget / tiers / published / metaTools` 这五类会漂的数据面字段。
 * 为什么：页面上的源数、工具数、阈值、数据时刻一律运行时向 `GET /catalog` 取；
 * 快照里再存一份，就必然出现「快照说 8 源、接口说 10 源」这种两种真相。
 *
 * 规则二 · 渲染路径不出现源 id：`site/` 的页面与渲染脚本里，源 id（如 `wheatomics`）
 * 只允许出现在配置示例与注释里，不允许进正文。为什么：源 id 是内部标识，页面应显示
 * 给人看的中文名（`displayName`），而不是把 id 漏给用户。
 *
 * 规则三 · 数据数字面量：渲染路径（`site/index.html` 剥离 `<pre>/<code>/注释/script` 之后、
 * `site/assets/app.js`）不许出现「N 个源」「N 个工具」「工具 N」这类**会漂的数字**。
 * 为什么：数字是运行时的事实，写进静态文件就一定会落后（漏掉的正好是 M3.1 第③条后半句
 * 「塞一个工具数字面量 → 必须变红」）。阈值（80/40）不属于此类，它在 `budget` 里且由接口给。
 *
 * 规则四 · 已发布包数字必须等于唯一真相：`site/data/copy.js` 的 `published.{sources,tools,metaTools,spec}`
 * 必须逐字等于 `market/copy.json` 的 `counts.{sources,tools,metaTools}` 与 `installed.spec`。
 * 为什么：`copy.js` 不在快照白名单里，页面却真的渲染它（「已发布包」说明段），于是它成了
 * 手改 `999` 也无人察觉的盲区。`market/copy.json` 本来就是生成器读的那份
 * （`site/scripts/build-data.mjs` 的 `readPublishedScope`），拿它当锚点不新增第二份真相；
 * 它自己的数由 `npm run counts:published`（联网解包 npm tarball）负责核准。
 *
 * ⚠️ 三个实测过的坑，改规则前先读：
 *
 * 1. **`site/assets/source-icons.js` 的键就是源 id**（id → { svg, color }）。整份文件必须放行，
 *    否则每次都是误报。它是字典文件，不是渲染文本。
 * 2. **源 id `string` 与 JS 类型名撞名**（`typeof x === 'string'` 满屏都是）。所以对 `.js`
 *    豁免「关键词型 id」的裸词匹配；**但 `index.html` 正文里出现 `string` 这个源 id 照样要报**。
 *    豁免范围不许扩散：以后撞名了不要顺手往 EXEMPT_KEYWORD_IDS 里加，那等于把这个闸关掉。
 *    记一笔设计债：源 id 用 JS 类型名本身就是隐患（改名是破坏性变更，现在只做豁免）。
 * 3. **`site/assets/market.js` 里有一句「`/catalog` 返回了 0 个源」**，那是**运行时措辞**
 *    （描述“接口返回空数组”这种异常态），不是对数据规模的断言。所以规则三只覆盖
 *    `index.html` 与 `app.js`；把它一并纳入会立刻误报。要扩范围，先分清「陈述事实的数字」
 *    与「描述异常的数字」——第一次就跑红的检查，下一个会直接关掉。
 *
 * 用法：node scripts/check-site.mjs        （离线；需要先 npm run build，读 dist 注册表取源 id）
 * 退出码：任一规则不过 → 1。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createRegistry } from '../dist/sources/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 快照里不许出现的数据面字段（快照只留身份：schemaVersion/generatedAt/gitCommit/package/build/note）。 */
export const FORBIDDEN_SNAPSHOT_KEYS = ['sources', 'budget', 'tiers', 'published', 'metaTools'];

/** 参与「渲染路径不出现源 id」检查的文件（相对仓库根）。 */
export const RENDER_FILES = [
  'site/index.html',
  'site/market.html',
  'site/assets/app.js',
  'site/assets/market.js',
];

/** 字典文件：键就是源 id，整份放行（坑 1）。 */
export const DICTIONARY_FILES = ['site/assets/source-icons.js'];

/** 关键词型源 id：只对 `.js` 豁免裸词匹配（坑 2，范围不许扩散）。 */
export const EXEMPT_KEYWORD_IDS = new Set(['string']);

const SNAPSHOT_FILES = [
  { file: 'site/data/catalog.json', kind: 'json' },
  { file: 'site/data/catalog.js', kind: 'js-data' },
];

/** 规则三覆盖的文件（坑 3：`market.js` 故意不在内）。 */
export const DATA_NUMBER_FILES = [
  { file: 'site/index.html', kind: 'html' },
  { file: 'site/assets/app.js', kind: 'js' },
];

/** 会漂的数据数字面量。阈值（80/40）不在此列：它由 `/catalog` 的 budget 给。 */
export const DATA_NUMBER_PATTERNS = [
  { re: /\d+\s*(?:个源|个工具|个元工具)/, label: '「N 个源/工具」式数字面量' },
  { re: /(?:个源|个工具|个元工具)\s*\d+/, label: '「源/工具 N」式数字面量' },
  { re: /工具\s*\d+/, label: '「工具 N」式数字面量' },
];

/** 规则四：页面渲染的「已发布包」事实，锚点是生成器自己的输入。 */
export const PUBLISHED_COPY_FILE = 'site/data/copy.js';
export const PUBLISHED_ANCHOR_FILE = 'market/copy.json';

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/* ------------------------------------------------------------------ *
 * 规则一：快照只放身份
 * ------------------------------------------------------------------ */

export function checkSnapshot(root = ROOT) {
  const problems = [];
  for (const { file, kind } of SNAPSHOT_FILES) {
    let text;
    try {
      text = readFileSync(path.join(root, file), 'utf8');
    } catch (error) {
      problems.push(`${file} 读不到（${error.message}）：快照文件必须在库`);
      continue;
    }

    if (kind === 'json') {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        problems.push(`${file} 不是合法 JSON：${error.message}`);
        continue;
      }
      for (const key of FORBIDDEN_SNAPSHOT_KEYS) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
          problems.push(`snapshot: 出现禁止字段 "${key}"（${file}）`);
        }
      }
      continue;
    }

    // catalog.js 是 `window.__PLANTOMICS_CATALOG__ = {...}` 形态，按「键名:」匹配即可，
    // 不必求值（求值会执行文件内容，闸不该有副作用）。
    for (const key of FORBIDDEN_SNAPSHOT_KEYS) {
      if (new RegExp(`["']?${key}["']?\\s*:`).test(text)) {
        problems.push(`snapshot: 出现禁止字段 "${key}"（${file}）`);
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * 规则二：渲染路径不出现源 id
 * ------------------------------------------------------------------ */

/** 去掉注释与配置示例（`<pre>` / `<code>`）后再扫描——注释和安装示例本来就该出现源 id。 */
export function stripNonRendered(text, kind) {
  /** 原地空格化、保留换行：行号必须与**原文件**一致，删掉再扫会把报错行号带偏。 */
  const blank = (match) => match.replace(/[^\n]/g, ' ');
  let out = text;
  if (kind === 'html') {
    out = out.replace(/<!--[\s\S]*?-->/g, blank);
    out = out.replace(/<pre\b[\s\S]*?<\/pre>/gi, blank);
    out = out.replace(/<code\b[\s\S]*?<\/code>/gi, blank);
    out = out.replace(/<script\b[\s\S]*?<\/script>/gi, blank);
  } else {
    out = out.replace(/\/\*[\s\S]*?\*\//g, blank);
    out = out.replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + match.slice(lead.length).replace(/[^\n]/g, ' '));
  }
  return out;
}

/** 返回 [{ line, id }]：在渲染文本里出现的源 id（行号即原文件行号）。 */
export function findSourceIds(text, ids, { kind }) {
  const rendered = stripNonRendered(text, kind).split('\n');
  const hits = [];
  for (let index = 0; index < rendered.length; index += 1) {
    const line = rendered[index];
    for (const id of ids) {
      if (kind !== 'html' && EXEMPT_KEYWORD_IDS.has(id)) continue; // 坑 2：只豁免 .js
      // 词边界按 ASCII 判定：`wheatomics_search` 不算裸出现，`wheatomics` 才算
      if (new RegExp(`(^|[^A-Za-z0-9_-])${id}([^A-Za-z0-9_-]|$)`).test(line)) {
        hits.push({ line: index + 1, id });
      }
    }
  }
  return hits;
}

export function checkRenderPath(root = ROOT, registry = createRegistry()) {
  const problems = [];
  const ids = registry.listSources().map((bundle) => bundle.manifest.id);
  for (const file of RENDER_FILES) {
    let text;
    try {
      text = readFileSync(path.join(root, file), 'utf8');
    } catch (error) {
      problems.push(`${file} 读不到（${error.message}）`);
      continue;
    }
    if (DICTIONARY_FILES.includes(file)) continue;
    const kind = file.endsWith('.html') ? 'html' : 'js';
    for (const hit of findSourceIds(text, ids, { kind })) {
      problems.push(`render-path: ${file} 第 ${hit.line} 行出现源 id "${hit.id}"`);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * 规则三：数据数字面量
 * ------------------------------------------------------------------ */

/** 返回问题串：渲染文本里出现「N 个源/N 个工具」这类会漂的数字（行号即原文件行号）。 */
export function checkDataNumbers(root = ROOT) {
  const problems = [];
  for (const { file, kind } of DATA_NUMBER_FILES) {
    let text;
    try {
      text = readFileSync(path.join(root, file), 'utf8');
    } catch (error) {
      problems.push(`${file} 读不到（${error.message}）`);
      continue;
    }
    const lines = stripNonRendered(text, kind).split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      // 每行报一条即可：同一行的「34 个工具」会同时命中两条规则，重复报只会淹没清单
      for (const { re, label } of DATA_NUMBER_PATTERNS) {
        const hit = line.match(re);
        if (!hit) continue;
        problems.push(`data-number: ${file} 第 ${index + 1} 行出现${label}「${hit[0].trim()}」`);
        break;
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * 规则四：已发布包数字必须等于 market/copy.json
 * ------------------------------------------------------------------ */

/** 取 `site/data/copy.js` 里的对象（`window.__PMH_COPY__ = {...};`，不求值、无副作用）。 */
export function readCopyObject(root = ROOT) {
  const text = readFileSync(path.join(root, PUBLISHED_COPY_FILE), 'utf8');
  const match = text.match(/window\.__PMH_COPY__\s*=\s*([\s\S]*?);\s*$/);
  if (!match) throw new Error('找不到 `window.__PMH_COPY__ = {...};` 形式的赋值');
  return JSON.parse(match[1]);
}

export function checkPublishedNumbers(root = ROOT) {
  let copy;
  try {
    copy = readCopyObject(root);
  } catch (error) {
    return [`${PUBLISHED_COPY_FILE} 解析失败：${error.message}`];
  }

  let anchor;
  try {
    anchor = JSON.parse(readFileSync(path.join(root, PUBLISHED_ANCHOR_FILE), 'utf8'));
  } catch (error) {
    return [`${PUBLISHED_ANCHOR_FILE} 读不到（${error.message}）：发布数字的唯一真相是它，缺失就无法比对`];
  }

  const published = copy.published;
  if (!published) {
    return [`published-copy: ${PUBLISHED_COPY_FILE} 没有 published 块（页面「已发布包」说明会失去数据）`];
  }

  const expected = {
    spec: anchor.installed?.spec ?? null,
    sources: anchor.counts?.sources ?? null,
    tools: anchor.counts?.tools ?? null,
    metaTools: anchor.counts?.metaTools ?? null,
  };
  const problems = [];
  for (const key of ['spec', 'sources', 'tools', 'metaTools']) {
    if (published[key] !== expected[key]) {
      problems.push(
        `published-copy: ${key} 与 ${PUBLISHED_ANCHOR_FILE} 不一致`
          + `（copy.js=${JSON.stringify(published[key]) ?? '缺'}，锚点=${JSON.stringify(expected[key]) ?? '缺'}）`
          + '——发布数字只能来自该锚点，手改必红',
      );
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function main() {
  const problems = [
    ...checkSnapshot(),
    ...checkRenderPath(),
    ...checkDataNumbers(),
    ...checkPublishedNumbers(),
  ];
  const registry = createRegistry();
  const ids = registry.listSources().length;

  if (problems.length === 0) {
    process.stdout.write(
      `✅ 站点闸通过：快照无数据面字段（${SNAPSHOT_FILES.length} 个文件），`
        + `渲染路径无源 id（${RENDER_FILES.length} 个文件 / ${ids} 个源 id；`
        + `字典文件 ${DICTIONARY_FILES.length} 个放行，关键词型 id 仅 .js 豁免），`
        + `渲染路径无数据数字面量（${DATA_NUMBER_FILES.length} 个文件 / ${DATA_NUMBER_PATTERNS.length} 条规则），`
        + `已发布包数字等于 ${PUBLISHED_ANCHOR_FILE}\n`,
    );
    return;
  }
  process.stderr.write('❌ 站点闸未通过\n');
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

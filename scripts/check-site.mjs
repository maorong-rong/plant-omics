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
 * ⚠️ 两个实测过的坑，改规则前先读：
 *
 * 1. **`site/assets/source-icons.js` 的键就是源 id**（id → { svg, color }）。整份文件必须放行，
 *    否则每次都是误报。它是字典文件，不是渲染文本。
 * 2. **源 id `string` 与 JS 类型名撞名**（`typeof x === 'string'` 满屏都是）。所以对 `.js`
 *    豁免「关键词型 id」的裸词匹配；**但 `index.html` 正文里出现 `string` 这个源 id 照样要报**。
 *    豁免范围不许扩散：以后撞名了不要顺手往 EXEMPT_KEYWORD_IDS 里加，那等于把这个闸关掉。
 *    记一笔设计债：源 id 用 JS 类型名本身就是隐患（改名是破坏性变更，现在只做豁免）。
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
 * CLI
 * ------------------------------------------------------------------ */

function main() {
  const problems = [...checkSnapshot(), ...checkRenderPath()];
  const registry = createRegistry();
  const ids = registry.listSources().length;

  if (problems.length === 0) {
    process.stdout.write(
      `✅ 站点闸通过：快照无数据面字段（${SNAPSHOT_FILES.length} 个文件），`
        + `渲染路径无源 id（${RENDER_FILES.length} 个文件 / ${ids} 个源 id；`
        + `字典文件 ${DICTIONARY_FILES.length} 个放行，关键词型 id 仅 .js 豁免）\n`,
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

#!/usr/bin/env node
/**
 * R3 出处字段完整性抽样（论文用，可入库版本）
 *
 * 口径：每个已接入源各挑 1 个工具做 **1 次真实上游调用**，检查模型可见正文的尾注是否含四要素：
 *   完整请求（含参数）/ HTTP 状态 / 耗时 / 查询时刻。
 * 这是"字段完整性抽样"，**不是**"可复现率"或"重放成功率"（后者需自动重放校验，本脚本不做）。
 *
 * 与旧版（%TEMP%\r3c.mjs）的差别：
 *   1. 必须给 PMH_BASE（不硬编码本机 dist 路径）；
 *   2. 源与工具清单按当次 registry 现算，缺哪个源就如实报缺（不写死 7 个）；
 *   3. 产物 JSON 带 git HEAD、dist 哈希、时刻、每条调用的 URL 与判定；
 *   4. **本脚本是联网测量（真实上游响应），不是单元测试**：不进 `npm test`，红了不算测试失败；
 *      与 `npm run probe` 同一职责层级（AGENTS.md §四）。本脚本只读上游、不写仓内文件。
 *
 * 用法：
 *   $env:PMH_BASE = "file:///<repo>/dist/"
 *   node r3-provenance-fields.mjs --tag c959985 --out-dir <目录>
 *
 * 说明：n 很小（每源 1 次），只覆盖成功路径；错误路径另有错误注入，不是真实 503。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const getArg = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : undefined; };
const force = argv.includes('--force');

const base = process.env.PMH_BASE;
if (!base) { console.error('缺少环境变量 PMH_BASE（与 R1 runner 同口径，不静默回落工作树 dist）'); process.exit(2); }
const tag = getArg('--tag');
if (!tag) { console.error('缺少 --tag（如 --tag c959985）'); process.exit(2); }
const outDir = getArg('--out-dir') || tmpdir();   // 产物不入库：默认落系统临时目录
const outPath = join(outDir, `r3-provenance-fields-${tag}.json`);

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
const basePath = fileURLToPath(base);
const distFiles = ['sources/index.js', 'core/http.js'];
const distInfo = {};
for (const rel of distFiles) {
  const p = join(basePath, rel);
  if (!existsSync(p)) { console.error(`PMH_BASE 下找不到 ${rel}`); process.exit(5); }
  distInfo[rel] = { sha256: sha256(p), bytes: statSync(p).size };
}
const repoRoot = basePath.replace(/[\\/]dist[\\/]?$/, '');
let gitHead = null;
try { gitHead = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* 非 git */ }

const { registry } = await import(base + 'sources/index.js');
const { fetchJson } = await import(base + 'core/http.js');
const tools = new Map(registry.listTools().map((t) => [t.name, t]));

// 每源 1 个工具 + 固定参数；源不在目录里就跳过并记 missing
const CALLS = [
  ['wheatomics', 'wheatomics_expression_projects', {}],
  ['strawberry', 'strawberry_catalog', {}],
  ['gwh', 'gwh_project_sample_lookup', { entity: 'project', id: 'PRJCA000437' }],
  ['icg', 'icg_species_list', { limit: 2 }],
  ['ic4r', 'ic4r_gene', { locus: 'IC4R-OSJ01G000100' }],
  ['gramene', 'gramene_search', { q: 'rice', rows: 2 }],
  ['scod', 'scod_genome_list', {}],
];

const rows = [];
const missing = [];
for (const [source, name, args] of CALLS) {
  const t = tools.get(name);
  if (!t) { missing.push({ source, tool: name, reason: '工具不在本构建' }); continue; }
  const t0 = Date.now();
  let text = '';
  try { text = (await t.run(args, { http: fetchJson })).text; }
  catch (e) { rows.push({ source, tool: name, ok: false, error: String(e?.message || e).slice(0, 200), ms: Date.now() - t0 }); continue; }
  const ms = Date.now() - t0;
  const hasUrl = /https?:\/\/[^\s｜|]+/.test(text);
  const hasStatus = /HTTP[^0-9]{0,4}\d{3}/.test(text);
  const hasMs = /\d+(\.\d+)?\s*ms/i.test(text);
  const hasTime = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text);
  const bytes = Buffer.byteLength(text, 'utf8');
  const tail = text.split('\n').filter((l) => l.startsWith('源：')).join(' / ').slice(0, 400);
  rows.push({
    source, tool: name, ok: hasUrl && hasStatus && hasMs && hasTime,
    fourElements: { url: hasUrl, httpStatus: hasStatus, elapsedMs: hasMs, timestamp: hasTime },
    textBytes: bytes, overBudget: bytes > 4096, ms, tail,
  });
}

const passed = rows.filter((r) => r.ok).length;
const result = {
  ranAt: new Date().toISOString(),
  instrument: 'r3-provenance-fields.mjs',
  anchor: { tag, gitHead, pmhBase: base, dist: distInfo, toolCount: tools.size },
  what: '每源 1 次真实上游调用，检查尾注四要素（完整请求/HTTP 状态/耗时/时刻）',
  notWhat: '不是"可复现率"或"重放成功率"：未做自动重放校验；只覆盖成功路径；n 很小',
  tally: { passed, total: rows.length, missing },
  rows,
};

if (existsSync(outPath) && !force) { console.error('产物已存在，拒绝覆盖（加 --force）：' + outPath); process.exit(3); }
mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 1), 'utf8');

console.log(`锚=${tag} HEAD=${gitHead ?? '未知'} 工具=${tools.size}`);
for (const r of rows) {
  if (!r.ok && r.error) { console.log(`✘ ${r.source}/${r.tool} 失败：${r.error}`); continue; }
  console.log(`${r.ok ? '✔' : '✘'} ${r.source}/${r.tool} textBytes=${r.textBytes} ${r.overBudget ? '!!超4KB' : ''} ` +
    `URL=${r.fourElements.url} HTTP=${r.fourElements.httpStatus} 耗时=${r.fourElements.elapsedMs} 时刻=${r.fourElements.timestamp} (${r.ms}ms)`);
}
if (missing.length) console.log('缺失：' + missing.map((m) => m.source + '/' + m.tool).join(', '));
console.log(`出处四要素齐全：${passed}/${rows.length}`);
console.log('saved ' + outPath);

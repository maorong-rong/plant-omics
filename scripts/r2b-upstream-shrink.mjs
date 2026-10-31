#!/usr/bin/env node
/**
 * R2-b 上游响应 vs 工具正文（论文用，可入库版本）
 *
 * 口径：对每个已接入源各挑 1 个工具做 1 次真实上游调用，同时记录
 *   ① 工具正文的 UTF-8 字节（模型可见）
 *   ② 本次调用中上游**实际返回的原始响应体字节**（用注入式 fetch 在响应流上直接量，
 *      不是事后按 URL 重取 —— 重取对 POST 端点和会变的上游都不可靠，第一版就栽在这）
 * 两者相除得到合计缩减比。**这是"格式化 + 有界裁剪"的合计效果，不是单纯裁剪**。
 *
 * 为什么必须同时报两个方向：上游本来就紧凑时（如 IC4R 388 B），
 * 加表头与出处反而让正文变大 —— 只报 99.9% 会让读者以为是无损压缩层。
 *
 * **本脚本是联网测量（真实上游响应），不是单元测试**：不进 `npm test`，红了不算测试失败；
 * 与 `npm run probe` 同一职责层级（AGENTS.md §四）。本脚本只读上游、不写仓内文件。
 *
 * 用法：
 *   $env:PMH_BASE = "file:///<repo>/dist/"
 *   node r2b-upstream-shrink.mjs --tag c959985 --out-dir <目录>
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { tmpdir } from 'node:os';

const UA = 'plant-omics-mcp/0.1 (research aggregation; see README)';
const argv = process.argv.slice(2);
const getArg = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : undefined; };
const force = argv.includes('--force');

const base = process.env.PMH_BASE;
if (!base) { console.error('缺少环境变量 PMH_BASE（与 R1 runner 同口径）'); process.exit(2); }
const tag = getArg('--tag');
if (!tag) { console.error('缺少 --tag（如 --tag c959985）'); process.exit(2); }
const outDir = getArg('--out-dir') || tmpdir();   // 产物不入库：默认落系统临时目录
const outPath = join(outDir, `r2b-upstream-shrink-${tag}.json`);

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
const { fetchJson, createFetcher } = await import(base + 'core/http.js');
const tools = new Map(registry.listTools().map((t) => [t.name, t]));

// 注入式 fetch：在响应流上直接量原始体字节，避免"事后按 URL 重取"对 POST/易变上游失真
function makeInstrumented() {
  const captured = [];
  const fetchImpl = async (url, init) => {
    const res = await globalThis.fetch(url, init);
    try {
      const body = await res.clone().text();
      captured.push({
        url: String(url),
        method: init?.method ?? 'GET',
        status: res.status,
        bytes: Buffer.byteLength(body, 'utf8'),
      });
    } catch { captured.push({ url: String(url), method: init?.method ?? 'GET', status: res.status, bytes: null }); }
    return res;
  };
  return { captured, http: createFetcher({}, fetchImpl) };
}

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
for (const [source, name, args] of CALLS) {
  const t = tools.get(name);
  if (!t) { rows.push({ source, tool: name, skipped: '工具不在本构建' }); continue; }
  const { captured, http } = makeInstrumented();
  let text = '';
  try { text = (await t.run(args, { http })).text; }
  catch (e) { rows.push({ source, tool: name, failed: String(e?.message || e).slice(0, 200), requests: captured }); continue; }
  const textBytes = Buffer.byteLength(text, 'utf8');
  const first = captured.find((c) => c.bytes !== null);
  if (!first) { rows.push({ source, tool: name, textBytes, failed: '没有捕获到上游响应体', requests: captured }); continue; }
  const ratio = 1 - textBytes / first.bytes;
  rows.push({
    source, tool: name, textBytes,
    upstream: { bytes: first.bytes, status: first.status, method: first.method, url: first.url },
    requestCount: captured.length,
    shrink: Number(ratio.toFixed(4)),
    grew: ratio < 0,
    note: '上游字节数取自本次调用的实际响应体，不是事后按 URL 重取',
  });
}

const ok = rows.filter((r) => r.shrink !== null);
const grew = ok.filter((r) => r.grew);
const result = {
  ranAt: new Date().toISOString(),
  instrument: 'r2b-upstream-shrink.mjs',
  anchor: { tag, gitHead, pmhBase: base, dist: distInfo, toolCount: tools.size },
  what: '每源 1 次真实上游调用：工具正文 UTF-8 字节 vs 按尾注重取的原始响应字节',
  notWhat: '不是无损压缩比、不是裁剪单独的效果（含格式化与出处尾注）；n 很小；上游内容本身会变',
  mustReportBothDirections: true,
  tally: { measured: ok.length, total: rows.length, grewCount: grew.length, grewTools: grew.map((r) => r.tool) },
  rows,
};

if (existsSync(outPath) && !force) { console.error('产物已存在，拒绝覆盖（加 --force）：' + outPath); process.exit(3); }
mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 1), 'utf8');

console.log(`锚=${tag} HEAD=${gitHead ?? '未知'} 工具=${tools.size}`);
for (const r of rows) {
  if (r.failed) { console.log(`✘ ${r.source}/${r.tool}：${r.failed}`); continue; }
  if (r.skipped) { console.log(`- ${r.source}/${r.tool} 跳过：${r.skipped}`); continue; }
  const pct = r.shrink === null ? '未知' : (r.shrink * 100).toFixed(1) + '%';
  console.log(`${r.grew ? '↑变大' : '↓缩小'} ${r.source}/${r.tool} 上游=${r.upstream.bytes ?? '失败'} B → 正文=${r.textBytes} B（${pct}）`);
}
console.log(`实测 ${ok.length}/${rows.length}；其中变大的 ${grew.length} 条${grew.length ? '（' + grew.map((r) => r.tool).join(', ') + '）' : ''}`);
console.log('saved ' + outPath);

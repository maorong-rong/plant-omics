#!/usr/bin/env node
/**
 * R2 载荷测量（论文用，可入库版本）
 *
 * 口径：把 registry.listTools() 的全量工具按 MCP tools/list 形状
 *   { name, description, inputSchema } 序列化为 JSON，按 UTF-8 字节与 token 计。
 * tokenizer：cl100k_base（gpt-tokenizer v2），版本写进产物。
 *
 * 与旧版（%TEMP%\tokens3.mjs）的差别：
 *   1. 不再硬编码本机 dist 路径 —— 必须给 PMH_BASE（与 R1 runner 同口径）；
 *   2. 打印的"全量 N 工具 / 元工具 / 源工具"全部按当次现算，不写死 34/32；
 *   3. 产物 JSON 带 git HEAD、dist 关键文件哈希、工具数、tokenizer 版本，
 *      使"哪个数配哪版代码"可判；
 *   4. 拒绝覆盖已有产物（--force 才覆盖）。
 *
 * 用法：
 *   $env:PMH_BASE = "file:///<repo>/dist/"
 *   node r2-token-payload.mjs --tag bf123e5 --out-dir <目录>
 *
 * 依赖：gpt-tokenizer v2（cl100k_base）。优先用仓内安装，找不到时可用
 *   $env:PMH_TOKENIZER = "file:///<某处>/node_modules/gpt-tokenizer/esm/main.js" 指定。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const EXPECT_TOKENIZER = '2.9.0';          // 锁定：不同 tokenizer ⇒ 数字不同
const argv = process.argv.slice(2);
const getArg = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : undefined; };
const force = argv.includes('--force');

const base = process.env.PMH_BASE;
if (!base) {
  console.error('缺少环境变量 PMH_BASE。例：$env:PMH_BASE = "file:///<repo>/dist/"\n' +
    '（与 R1 runner 同口径：不许静默回落到工作树 dist，否则"哪个数配哪版代码"无从判断）');
  process.exit(2);
}
const tag = getArg('--tag');
if (!tag) { console.error('缺少 --tag（产物文件名必须能区分锚点，如 --tag bf123e5 / --tag c959985）'); process.exit(2); }
const outDir = getArg('--out-dir') || tmpdir();   // 产物不入库：默认落系统临时目录
const outPath = join(outDir, `r2-token-payload-${tag}.json`);

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
const basePath = fileURLToPath(base);
const distFiles = ['sources/index.js', 'retrieval/find-sources.js', 'retrieval/capability-catalog.js'];
const distInfo = {};
for (const rel of distFiles) {
  const p = join(basePath, rel);
  if (!existsSync(p)) { console.error(`PMH_BASE 下找不到 ${rel} → dist 没构建或指错目录`); process.exit(5); }
  distInfo[rel] = { sha256: sha256(p), bytes: statSync(p).size, mtime: statSync(p).mtime.toISOString() };
}
const repoRoot = basePath.replace(/[\\/]dist[\\/]?$/, '');
let gitHead = null;
try { gitHead = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* 非 git 目录 */ }

// —— tokenizer ——
let encode, tokenizerVersion = null;
const tokPath = process.env.PMH_TOKENIZER;
if (tokPath) {
  encode = (await import(tokPath)).encode;
  const pkgPath = fileURLToPath(tokPath.replace(/\/esm\/main\.js$/, '/package.json'));
  if (existsSync(pkgPath)) tokenizerVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
} else {
  try {
    encode = (await import('gpt-tokenizer')).encode;
    const req = (await import('node:module')).createRequire(import.meta.url);
    tokenizerVersion = req('gpt-tokenizer/package.json').version;
  } catch {
    console.error('找不到 gpt-tokenizer。请装进仓（推荐版本 ' + EXPECT_TOKENIZER + '），' +
      '或用 $env:PMH_TOKENIZER 指向已安装的 esm/main.js');
    process.exit(2);
  }
}
if (tokenizerVersion && tokenizerVersion !== EXPECT_TOKENIZER) {
  console.warn(`⚠️ tokenizer 版本 ${tokenizerVersion} ≠ 锁定版本 ${EXPECT_TOKENIZER}：数字可能与论文记录不同（已写进产物）`);
}

const { registry } = await import(base + 'sources/index.js');
const tools = registry.listTools();
const meta = tools.filter((t) => t.name.startsWith('hub_'));
const src = tools.filter((t) => !t.name.startsWith('hub_'));

const payload = (ts) => JSON.stringify({ tools: ts.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
const stats = (ts) => ({ tools: ts.length, bytes: Buffer.byteLength(payload(ts), 'utf8'), tokens: encode(payload(ts)).length });

const perTool = src.map((t) => ({ name: t.name, tokens: encode(payload([t])).length, bytes: Buffer.byteLength(payload([t]), 'utf8') }))
  .sort((a, b) => b.tokens - a.tokens);
const median = perTool.length ? perTool[Math.floor(perTool.length / 2)].tokens : null;

// 5 条问题：候选正文长度（不含被点名工具 schema —— 论文三段相加，别把这行当端到端）
const QUESTIONS = [
  '小麦 TaVRN1 在干旱条件下的表达量是多少',
  '水稻 Os01g0100100 的功能注释是什么',
  '草莓某个基因在不同组织的表达情况',
  '拟南芥里调控开花时间的已知基因有哪些',
  '甘蔗 Chr1A 上某区间的基因',
];
const fsTool = tools.find((t) => t.name === 'hub_find_sources');
const answers = [];
for (const q of QUESTIONS) {
  const r = await fsTool.run({ question: q }, {});
  answers.push({
    question: q,
    bytes: Buffer.byteLength(r.text, 'utf8'),
    tokens: encode(r.text).length,
    rawCandidates: r.raw?.candidates ? { total: r.raw.candidates.total, sources: r.raw.candidates.sourceCount } : null,
  });
}

const result = {
  ranAt: new Date().toISOString(),
  instrument: 'r2-token-payload.mjs',
  anchor: { tag, gitHead, pmhBase: base, dist: distInfo, toolCount: tools.length, metaTools: meta.length, sourceTools: src.length },
  tokenizer: { name: 'cl100k_base (gpt-tokenizer)', version: tokenizerVersion, expected: EXPECT_TOKENIZER },
  full: stats(tools),
  meta: stats(meta),
  sources: stats(src),
  perSourceTool: { max: perTool[0] ?? null, median, min: perTool.at(-1) ?? null, top5: perTool.slice(0, 5) },
  candidateText: answers,
  note: 'candidateText 只是检索层返回正文；论文"三段相加"须另加被点名工具 schema，见论文骨架 §一.3',
  labelNote: '所有工具数按当次 registry.listTools() 现算，不写死历史值',
};

if (existsSync(outPath) && !force) { console.error('产物已存在，拒绝覆盖（加 --force）：' + outPath); process.exit(3); }
mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 1), 'utf8');

console.log(`锚=${tag} HEAD=${gitHead ?? '未知'} 源工具=${src.length} 元工具=${meta.length} 全量=${tools.length}`);
console.log(`tokenizer=${EXPECT_TOKENIZER}（实得 ${tokenizerVersion ?? '未知'}）`);
console.log(`全量 ${tools.length} 工具 = ${result.full.bytes} B / ${result.full.tokens} tokens`);
console.log(`元工具 ${meta.length} 个 = ${result.meta.bytes} B / ${result.meta.tokens} tokens`);
console.log(`源工具 ${src.length} 个 = ${result.sources.bytes} B / ${result.sources.tokens} tokens`);
console.log(`单工具 最大 ${perTool[0]?.name}=${perTool[0]?.tokens} | 中位 ${median} | 最小 ${perTool.at(-1)?.name}=${perTool.at(-1)?.tokens}`);
for (const a of answers) console.log(`Q="${a.question}" bytes=${a.bytes} tokens=${a.tokens}`);
console.log('saved ' + outPath);

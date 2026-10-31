#!/usr/bin/env node
/**
 * 工具级上游实测（probe-tools）。
 *
 * 与 `scripts/probe.mjs` 的分工（别混）：
 *   - `probe.mjs` 是**源级**探活：一个源打 1 个探活请求，回答"这个源还活着吗"。
 *   - 本脚本是**工具级**：把某个源的**每一个**工具都真打一次上游，回答"模型真能调用它吗"。
 *     源级 200 不能顶替工具级——端点、参数、响应形态各自会变，源活着而某个工具挂了是常态。
 *
 * 为什么要有：`npm test` 全离线（fixture 回放），只证明"我们按抓下来的形状能解析"。
 * 上游今天是否还接受这组参数、返回是否仍被解析器接住，只有真打才知道（AGENTS §四）。
 *
 * 口径（每个工具一行证据）：
 *   完整请求（含参数） / HTTP 状态 / 耗时 / 解析器是否接住。
 *   **失败如实记失败**：不重试到绿、不改 fixture、不降断言。工具抛错就是失败。
 *   `meta` 取自 `ToolResult.meta`（工具自己写的出处四要素），不是脚本另算的。
 *
 * 用法：
 *   npm run build
 *   node scripts/probe-tools.mjs --source wheatomics
 *   node scripts/probe-tools.mjs --source wheatomics --json <目录>/wheatomics.json
 *
 * 退出码：任一工具失败 → 1（AGENTS §五：断言失败必须非零退出）。
 * 产物：默认只打印；`--json` 才落盘，且默认目录是系统临时目录（本机实测件不入库）。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distBase = pathToFileURL(join(resolve(here, '..'), 'dist') + '/').href;

const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
};
const source = getArg('--source');
if (!source) {
  console.error('缺少 --source（如 --source wheatomics）。本脚本只测一个源，避免一次打太多上游。');
  process.exit(2);
}

/**
 * 每个工具一组**真实**参数。
 *
 * 哈希里缺一个工具就报错退出，不静默跳过：新加工具必须同时在这里给参数，
 * 否则"逐个实测"会悄悄退化成"实测了一部分"。参数来源写在该条的注释里。
 */
const CALLS = {
  wheatomics: {
    // 登记表：searchid VRN1 为文档示例
    wheatomics_search_known_genes: { searchid: 'VRN1', limit: 5 },
    // 工具描述里的示例 ID（IWGSC RefSeq v2.1 命名）
    wheatomics_gene_detail: { gene_id: 'TraesCS5A02G391700' },
    // 无必填；不传 keyword，取全量目录（上游约 6.7 KB）
    wheatomics_expression_projects: {},
    // project 取自 expression_projects 的 project 列（登记表记录 PRJEB5314_paired_tbl）
    wheatomics_expression_query: { gene_ids: 'TraesCS5A02G391700', project: 'PRJEB5314_paired_tbl', top: 3 },
    // 登记表：papers 关键词 vernalization 有命中
    wheatomics_search_papers: { q: 'vernalization', limit: 3 },
    // 登记表：转换需 .1 后缀 + gene_version 表名
    wheatomics_convert_gene_ids: { ids: 'TraesCS6B01G342500.1', gene_version: 'MIPS_result' },
    // 工具描述：不做格式猜测，只接受单个 ID
    wheatomics_cross_species_homologs: { gene_id: 'TraesCS5A02G391700', max_targets: 2 },
    // 目录工具：不传 keyword 取全量（上游 6,675 B / 29 数据集）
    wheatomics_variant_datasets: {},
    // 登记表实测：dataset=whealbi_minocc10 + chr1A:1-200000 可用；limit 取小值少拉体积
    wheatomics_variant_query: { dataset: 'whealbi_minocc10', region: 'chr1A:1-200000', limit: 5 },
    // 登记表：functions/pfam 正例 PF00319（SBP 结构域）
    wheatomics_gene_annotation: { pfam_id: 'PF00319', limit: 3 },
    // 按基因取序列：默认 gene（碱基），本地裁 200 碱基
    wheatomics_sequence: { gene_id: 'TraesCS5A02G391700', sequence_type: 'gene', offset: 1, length: 200 },
  },
};

const plan = CALLS[source];
if (!plan) {
  console.error(`--source ${source} 没有登记参数。在 scripts/probe-tools.mjs 的 CALLS 里补，不许瞎猜参数。`);
  process.exit(2);
}

const { registry } = await import(distBase + 'sources/index.js');
const { invokeTool } = await import(distBase + 'core/invoke.js');

const tools = registry.listTools().filter((t) => t.name.startsWith(`${source}_`));
if (tools.length === 0) {
  console.error(`注册表里没有 ${source}_* 工具（源未启用？检查 PLANTOMICS_SOURCES）`);
  process.exit(2);
}

const missing = tools.map((t) => t.name).filter((n) => !plan[n]);
const extra = Object.keys(plan).filter((n) => !tools.some((t) => t.name === n));
if (missing.length > 0 || extra.length > 0) {
  if (missing.length > 0) console.error(`未给参数的工具：${missing.join(', ')}`);
  if (extra.length > 0) console.error(`参数表里多出注册表没有的工具：${extra.join(', ')}`);
  process.exit(2);
}

let gitHead = null;
try {
  gitHead = execFileSync('git', ['-C', resolve(here, '..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  /* 非 git 环境不阻断实测 */
}

const rows = [];
for (const tool of tools) {
  const args = plan[tool.name];
  const startedAt = Date.now();
  try {
    const result = await invokeTool(tool, args);
    rows.push({
      tool: tool.name,
      args,
      ok: true,
      request: result.meta.request,
      status: result.meta.status,
      durationMs: result.meta.durationMs,
      wallMs: Date.now() - startedAt,
      textBytes: Buffer.byteLength(result.text, 'utf8'),
      at: result.meta.at,
      textHead: result.text.split('\n')[0] ?? '',
    });
    console.log(`✅ ${tool.name}  HTTP ${result.meta.status}  ${result.meta.durationMs} ms  ${Buffer.byteLength(result.text, 'utf8')} B`);
    console.log(`   ${result.meta.request}`);
  } catch (error) {
    rows.push({
      tool: tool.name,
      args,
      ok: false,
      request: null,
      status: null,
      durationMs: null,
      wallMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(`❌ ${tool.name}  ${Date.now() - startedAt} ms（未取到 meta）`);
    console.log(`   ${error instanceof Error ? error.message : String(error)}`);
  }
}

const failed = rows.filter((r) => !r.ok);
const summary = {
  script: 'probe-tools',
  measured: true,
  notUnitTest: true,
  source,
  gitHead,
  at: new Date().toISOString(),
  node: process.version,
  total: rows.length,
  ok: rows.length - failed.length,
  failed: failed.map((r) => r.tool),
  rows,
};

const outJson = getArg('--json');
if (outJson) {
  const outPath = outJson === 'true' ? join(tmpdir(), `probe-tools-${source}-${Date.now()}.json`) : outJson;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\nJSON: ${outPath}`);
}

console.log(`\n${source}：${summary.ok}/${summary.total} 个工具真打上游成功${failed.length ? `，失败 ${failed.length} 个：${summary.failed.join(', ')}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);

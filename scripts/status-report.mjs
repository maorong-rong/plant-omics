#!/usr/bin/env node
/**
 * 现状报告（P0 证据链）：把「10 源探活 attempts」「发布三通道版本」「默认集三处读数」
 * 汇总成 `docs/现状-<date>.md`，并对三处读数不一致**报红**。
 *
 * 为什么要有它：方向文档 ④ G1/G2/G8 记录了三类漂移——默认集在 `catalog`（35）与
 * `hub_status` / `tools/list`（41）各说一套；npm / 市场 / 云服务三个通道版本不同；
 * PR 没有 CI。P0 的职责是**让机器每天回答“现在到底几比几”**，不是顺手把它们改一致
 * （统一读数属于 P1/P2b，本阶段明确不做）。
 *
 * 两个入口，退出码语义不同（刻意分开，避免“生成报告”与“断言通过”混为一谈）：
 *
 *   npm run status:report        # 生成 docs/现状-<date>.md；生成成功即 exit 0
 *   npm run status:check         # 只做一致性断言：三处读数不一致 → exit 1；一致 → exit 0
 *
 * 用法：
 *   npm run build && npm run status:report
 *   npm run build && npm run status:check
 *   PLANTOMICS_SOURCES="wheatomics,gramene,ensemblplants,ic4r,strawberry,gwh,icg" npm run status:check
 *   node scripts/status-report.mjs --no-probe            # 不跑联网探活（attempts 记「未探」）
 *   node scripts/status-report.mjs --probe-report probe-report.json   # 复用已有探活报告
 *   node scripts/status-report.mjs --out /tmp/现状.md
 *
 * 三处读数的读取方式（刻意都走**运行时接口**，不直接读源码常量，否则报告会替被测对象说话）：
 *   - `/catalog.budget.defaultSetTools`：在 127.0.0.1 起一个临时 HTTP 服务，GET /catalog；
 *   - `hub_status`：同一个服务上走 MCP `tools/call`，从正文解析「默认推荐集：N 个工具」；
 *   - `tools/list`：同一个服务上走 MCP `tools/list`，数返回的 tool 条数。
 *
 * 边界：
 *   - 探活只覆盖**源级**探活端点（10 个），不代表 39 个源工具都可联网（D3=B 明确不做工具级全量）；
 *   - 三通道版本只记录事实，不做发布一致性闸（那是 P2）；报告里只标一致性状态；
 *   - 联网通道取不到时记「未知 + 原因」，不猜一个版本号。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MARKET_PATH = path.join(ROOT, 'market', 'index.json');
const DEFAULT_CLOUD_HEALTHZ = 'https://datamcp.moilab.net/healthz';
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
const PACKAGE_NAME = 'plantomics-hub';
const READ_TIMEOUT_MS = 30_000;

/** 三处读数的显示名：报告正文与断言输出共用，避免两套说法。 */
export const READING_LABELS = {
  catalogDefaultSetTools: '/catalog.budget.defaultSetTools',
  hubStatusDefaultSetTools: 'hub_status',
  toolsListCount: 'tools/list',
};

/**
 * 从 `hub_status` 正文解析默认推荐集工具数。
 *
 * 为什么解析正文而不是 raw 字段：MCP `tools/call` 只回文本内容，`raw` 不出协议。
 * 正文有两种措辞（超软建议 / 在软建议内），但都以「默认推荐集：N 个工具」开头，
 * 所以只认这一段；找不到就抛错——**不许猜一个数字**，否则报告会拿假数做断言。
 */
export function extractHubStatusDefaultSetTools(text) {
  const match = /默认推荐集：\s*(\d+)\s*个工具/.exec(String(text ?? ''));
  if (!match) {
    throw new Error('hub_status 正文里找不到「默认推荐集：N 个工具」：无法读取 hub_status 的默认集读数');
  }
  return Number(match[1]);
}

/** 简单 semver 比较（只用于从 market/index.json 的版本数组里取最大，不处理预发布标记）。 */
export function compareSemver(a, b) {
  const parse = (value) => String(value).split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (typeof l === 'number' && typeof r === 'number') {
      if (l !== r) return l - r;
    } else if (String(l) !== String(r)) {
      return String(l) < String(r) ? -1 : 1;
    }
  }
  return 0;
}

/**
 * market/index.json 里该插件登记的最高版本。
 *
 * 只读本地文件：市场索引就是本地事实，不联网（联网取的是 npm，两者分开才是“三通道”）。
 */
export function latestMarketVersion(market, { name = PACKAGE_NAME } = {}) {
  const plugin = (market?.plugins ?? []).find((entry) => entry.name === name)
    ?? (market?.plugins ?? [])[0];
  const versions = (plugin?.versions ?? []).map((entry) => entry?.version).filter((version) => typeof version === 'string');
  if (versions.length === 0) return null;
  return versions.reduce((highest, version) => (compareSemver(version, highest) > 0 ? version : highest));
}

/** 版本基础段：`0.1.1+svc.7.g026f3be` → `0.1.1`。用于跨通道比较“包版本”而不是构建号。 */
export function baseVersion(version) {
  if (typeof version !== 'string' || version.trim() === '') return null;
  return version.trim().split('+', 1)[0];
}

/**
 * 默认集三处读数的一致性判定（纯函数，不读文件、不联网）。
 *
 * 判据：三处都必须读到非负整数，且三者相等。任一读不到 = **不一致**（不能把“没读到”
 * 当作“一致”混过去）；不相等 = 不一致。退出码由调用方据此决定。
 */
export function evaluateDefaultSetConsistency(readings) {
  const entries = [
    [READING_LABELS.catalogDefaultSetTools, readings?.catalogDefaultSetTools],
    [READING_LABELS.hubStatusDefaultSetTools, readings?.hubStatusDefaultSetTools],
    [READING_LABELS.toolsListCount, readings?.toolsListCount],
  ];
  const unreadable = entries.filter(([, value]) => !Number.isInteger(value) || value < 0);
  const values = Object.fromEntries(entries);
  if (unreadable.length > 0) {
    return {
      consistent: false,
      values,
      problems: unreadable.map(([label]) => `${label} 读不到有效整数`),
    };
  }
  const unique = new Set(entries.map(([, value]) => value));
  const consistent = unique.size === 1;
  return {
    consistent,
    values,
    problems: consistent
      ? []
      : [`三处读数不一致：${entries.map(([label, value]) => `${label}=${value}`).join('；')}`],
  };
}

/** 三通道包版本是否一致（只报告，不做闸：发布一致性属于 P2）。 */
export function evaluateChannelVersions(channels) {
  const found = channels
    .map((channel) => ({ label: channel.label, version: baseVersion(channel.version) }))
    .filter((entry) => entry.version !== null);
  if (found.length !== 3) {
    return { consistent: false, found, note: '有通道取不到版本，无法比较' };
  }
  const unique = new Set(found.map((entry) => entry.version));
  return {
    consistent: unique.size === 1,
    found,
    note: unique.size === 1
      ? `三通道包版本一致：${[...unique][0]}`
      : `三通道包版本不一致：${found.map((entry) => `${entry.label}=${entry.version}`).join('；')}`,
  };
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function one(value, fallback = '未知') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

/**
 * 渲染 `docs/现状-<date>.md`。
 *
 * 内容按 issue 验收的三块组织：逐源 attempts / 发布三通道版本 / 默认集三处读数。
 * **每一处都写“怎么读的”**：读者要能照着复现，而不是相信一张手写表格。
 */
export function renderStatusReport(snapshot) {
  const {
    date,
    generatedAt,
    gitRev,
    nodeVersion,
    sourcesSetting,
    readings,
    consistency,
    channels,
    probe,
    probeError,
  } = snapshot;
  const lines = [];

  lines.push(`# 现状报告 ${date}`);
  lines.push('');
  lines.push('> 本文件由 `npm run status:report` 生成，不是手写；同一天重跑会覆盖。');
  lines.push(`> 生成时刻：${generatedAt}｜源码提交：\`${one(gitRev, '未知（不是 git 检出）')}\`｜Node：\`${nodeVersion}\``);
  lines.push(`> 本次启用源：${sourcesSetting ? `\`PLANTOMICS_SOURCES=${sourcesSetting}\`` : '全库（未设 `PLANTOMICS_SOURCES`）'}`);
  lines.push('');

  const catalogTotals = readings?.catalogTotals ?? {};
  lines.push('## 一句话');
  lines.push('');
  lines.push(
    `源码口径共 ${one(catalogTotals.sources)} 源 / ${one(catalogTotals.tools)} 工具（源工具 ${one(catalogTotals.sourceTools)} + 元工具 ${one(catalogTotals.metaTools)}）；`
      + `默认集三处读数为 ${READING_LABELS.catalogDefaultSetTools}=${one(consistency.values[READING_LABELS.catalogDefaultSetTools])}、`
      + `${READING_LABELS.hubStatusDefaultSetTools}=${one(consistency.values[READING_LABELS.hubStatusDefaultSetTools])}、`
      + `${READING_LABELS.toolsListCount}=${one(consistency.values[READING_LABELS.toolsListCount])}，`
      + `${consistency.consistent ? '✅ 一致' : '❌ 不一致（见下）'}。`,
  );
  lines.push('');

  /* ---------------- 默认集三处读数 ---------------- */
  lines.push('## 默认集三处读数');
  lines.push('');
  lines.push('| 读数来源 | 工具数 | 怎么读的 |');
  lines.push('|---|---|---|');
  lines.push(`| \`${READING_LABELS.catalogDefaultSetTools}\` | ${one(consistency.values[READING_LABELS.catalogDefaultSetTools])} | 临时服务 \`GET /catalog\`，取 \`budget.defaultSetTools\`（按 \`DEFAULT_SET_SOURCES\` 清单算） |`);
  lines.push(`| \`${READING_LABELS.hubStatusDefaultSetTools}\` | ${one(consistency.values[READING_LABELS.hubStatusDefaultSetTools])} | 同一服务走 MCP \`tools/call hub_status\`，解析正文「默认推荐集：N 个工具」 |`);
  lines.push(`| \`${READING_LABELS.toolsListCount}\` | ${one(consistency.values[READING_LABELS.toolsListCount])} | 同一服务走 MCP \`tools/list\`，数返回条数 |`);
  lines.push('');
  if (consistency.consistent) {
    lines.push(`**一致性检查：✅ 一致**（三处都是 ${consistency.values[READING_LABELS.toolsListCount]}）——\`npm run status:check\` 在本检出上 exit 0。`);
  } else {
    lines.push(`**一致性检查：❌ 不一致**——${consistency.problems.join('；')}。`);
    lines.push('');
    lines.push('> 这是 ④-G1 的已知缺口。P0 只负责**报红**：`npm run status:check` 在此检出上 exit 1。'
      + '统一三处读数属于 P1/P2b，本报告不做修复。');
  }
  lines.push('');

  /* ---------------- 发布三通道版本 ---------------- */
  lines.push('## 发布三通道版本');
  lines.push('');
  lines.push('| 通道 | 版本 | 读取结果 |');
  lines.push('|---|---|---|');
  for (const channel of channels) {
    lines.push(`| ${channel.label} | ${channel.error ? '未知' : one(channel.version)} | ${escapeCell(channel.error ? `读取失败：${channel.error}` : channel.detail)} |`);
  }
  lines.push('');
  const channelVersions = evaluateChannelVersions(channels);
  lines.push(`**三通道包版本：${channelVersions.consistent ? '✅ 一致' : '❌ 不一致'}**——${channelVersions.note}。`);
  lines.push('');
  lines.push('> 发布一致性闸属于 P2；本报告只记录事实，不改市场索引、不发版本。');
  lines.push('');

  /* ---------------- 逐源 attempts ---------------- */
  lines.push('## 逐源 attempts（源级探活）');
  lines.push('');
  if (probeError) {
    lines.push(`❌ 本次探活没有跑成：${escapeCell(probeError)}。因此**没有**逐源 attempts 证据，记为未知。`);
  } else if (!probe) {
    lines.push('本次以 `--no-probe` 运行，**没有**逐源 attempts 证据，记为未知。');
  } else {
    lines.push(`探活日期：${probe.date}；共 ${probe.results.length} 个源级端点（D3=B：只跑 10 个源级探活，不做工具级全量）。`);
    lines.push('');
    lines.push('| 源 | 端点 | HTTP | 期望 | 尝试 | 耗时 | 结论 | 备注 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const result of probe.results) {
      lines.push(
        `| ${result.id} | ${escapeCell(result.url)} | ${one(result.status)} | ${one(result.expected)} | ${one(result.attempts)} | ${one(result.ms)} ms | ${result.ok ? '✅' : '❌'} | ${escapeCell(result.note)} |`,
      );
    }
    const failed = probe.results.filter((result) => !result.ok);
    lines.push('');
    lines.push(`合计：${probe.results.length - failed.length}/${probe.results.length} 个源级端点通过${failed.length ? `；未通过：${failed.map((result) => result.id).join(', ')}` : ''}。`);
  }
  lines.push('');

  /* ---------------- 边界 ---------------- */
  lines.push('## 这份报告能证明什么、不能证明什么');
  lines.push('');
  lines.push('- 能证明：上述 10 个源级探活端点此刻是否可用（含 attempts 与逐次轨迹）；');
  lines.push('- 能证明：`/catalog`、`hub_status`、`tools/list` 三处**当前读数**，以及它们是否一致；');
  lines.push('- 能证明：npm latest / 本地市场索引 / 云服务 `/healthz` 三处**当前版本**；');
  lines.push('- **不能证明**：39 个源工具逐个可用（探活端点只覆盖其中 8 个，其余只有离线 fixture 证据）；');
  lines.push('- **不能证明**：带 token 的公网端到端调用、真实 DSH 宿主装载（U2/U3 仍未知）；');
  lines.push('- 不做修复：三处读数不一致是 P1/P2b 的工单；本报告只报红。');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * 采集层（联网 / 起临时服务；全部在函数内，脚本顶层不 import dist）
 * ------------------------------------------------------------------ */

/** 发布三通道：npm latest、本地 market/index.json、云服务 /healthz。失败只记原因，不中断报告。 */
export async function collectChannels({
  fetch: fetcher = globalThis.fetch,
  marketPath = DEFAULT_MARKET_PATH,
  npmRegistry = process.env.npm_config_registry ?? DEFAULT_NPM_REGISTRY,
  cloudHealthzUrl = process.env.PLANTOMICS_STATUS_CLOUD_URL ?? DEFAULT_CLOUD_HEALTHZ,
  packageName = PACKAGE_NAME,
} = {}) {
  const channels = [];

  // 通道一：npm latest（只有 registry 是网络事实；tarball 内容不在本报告范围）
  const npm = { key: 'npm', label: 'npm latest', version: null, detail: '', error: null };
  try {
    const registryUrl = String(npmRegistry).replace(/\/$/, '');
    const response = await fetcher(`${registryUrl}/${packageName}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const packument = await response.json();
    const latest = packument?.['dist-tags']?.latest;
    if (!latest) throw new Error('registry 没有 dist-tags.latest');
    npm.version = latest;
    const total = Object.keys(packument?.versions ?? {}).length;
    npm.detail = `dist-tags.latest；registry 共登记 ${total} 个版本`;
  } catch (error) {
    npm.error = error instanceof Error ? error.message : String(error);
  }
  channels.push(npm);

  // 通道二：本地市场索引（用户从 DSH 市场能装到的版本）
  const market = { key: 'market', label: 'market/index.json', version: null, detail: '', error: null };
  try {
    const data = JSON.parse(readFileSync(marketPath, 'utf8'));
    const latest = latestMarketVersion(data, { name: packageName });
    if (!latest) throw new Error('plugins[].versions 为空');
    market.version = latest;
    const plugin = (data.plugins ?? [])[0] ?? {};
    const count = (plugin.versions ?? []).length;
    market.detail = `本地索引登记 ${count} 个版本`;
  } catch (error) {
    market.error = error instanceof Error ? error.message : String(error);
  }
  channels.push(market);

  // 通道三：公网云服务 /healthz（免鉴权；只读版本与规模，不调工具）
  const cloud = { key: 'cloud', label: '云服务 /healthz', version: null, detail: '', error: null };
  try {
    const response = await fetcher(cloudHealthzUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    if (!health?.version) throw new Error('响应里没有 version');
    cloud.version = health.version;
    cloud.detail = `package ${one(health.package)}；${one(health.sources)} 源 / ${one(health.tools)} 工具（元工具 ${one(health.metaTools)}）；${cloudHealthzUrl}`;
  } catch (error) {
    cloud.error = error instanceof Error ? error.message : String(error);
  }
  channels.push(cloud);

  return channels;
}

/**
 * 本地三处读数：起一个临时 HTTP 服务（127.0.0.1:0，免鉴权），
 * 用 `/catalog` 与 MCP 协议各读一遍。用完即关，不留监听端口。
 *
 * 走运行时接口而不是源码常量：报告要测的正是“实际下发的东西”，
 * 直接 import `defaultSetToolCount` 等于让被测对象自己给自己打分。
 */
export async function collectLocalReadings({ env = process.env } = {}) {
  let modules;
  try {
    modules = await Promise.all([
      import(pathToFileURL(path.join(ROOT, 'dist', 'sources', 'index.js')).href),
      import(pathToFileURL(path.join(ROOT, 'dist', 'service', 'config.js')).href),
      import(pathToFileURL(path.join(ROOT, 'dist', 'service', 'http.js')).href),
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
  } catch (error) {
    throw new Error(`读不到 dist/（先 npm run build）：${error instanceof Error ? error.message : String(error)}`);
  }
  const [{ registry }, { parseServiceConfig }, { createService }, { Client }, { StreamableHTTPClientTransport }] = modules;

  const config = parseServiceConfig({
    ...env,
    // 固定回环 + 随机端口：不暴露端口，也不和本机已有服务抢 8787。
    PLANTOMICS_HUB_HOST: '127.0.0.1',
    PLANTOMICS_HUB_PORT: '0',
    // 报告是本机只读自查：不启用 token，避免把环境里可能存在的 token 带进临时服务。
    PLANTOMICS_HUB_TOKEN: '',
    PLANTOMICS_HUB_LOG: 'quiet',
  });
  const service = createService({ registry, config, logger: () => {} });
  const running = await service.start();
  // running.url 是 MCP 端点（…/mcp）；/catalog 在同一个 origin 根路径上
  const origin = new URL(running.url).origin;
  const client = new Client({ name: 'plantomics-status-report', version: '0.0.0' });
  try {
    const catalogResponse = await fetch(`${origin}/catalog`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!catalogResponse.ok) throw new Error(`GET /catalog 返回 HTTP ${catalogResponse.status}`);
    const catalog = await catalogResponse.json();

    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    const { tools } = await client.listTools();
    const status = await client.callTool({ name: 'hub_status', arguments: {} });
    if (status.isError) throw new Error('hub_status 返回 isError=true');
    const statusText = (status.content ?? [])
      .filter((entry) => entry?.type === 'text')
      .map((entry) => entry.text)
      .join('\n');

    return {
      catalogDefaultSetTools: catalog?.budget?.defaultSetTools,
      hubStatusDefaultSetTools: extractHubStatusDefaultSetTools(statusText),
      toolsListCount: tools.length,
      catalogTotals: {
        sources: catalog?.totals?.sources,
        tools: catalog?.totals?.tools,
        // /catalog 的 totals 只有 sources/tools/metaTools；源工具数由前两者相减得出
        sourceTools: Number.isInteger(catalog?.totals?.tools) && Number.isInteger(catalog?.totals?.metaTools)
          ? catalog.totals.tools - catalog.totals.metaTools
          : null,
        metaTools: catalog?.totals?.metaTools,
        defaultSources: catalog?.budget?.defaultSources ?? [],
      },
      serviceUrl: running.url,
    };
  } finally {
    await client.close().catch(() => {});
    await running.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function readGitRev() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function readProbeReport(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!data || !Array.isArray(data.results)) {
    throw new Error(`${file} 不是探活报告（缺少 results 数组）`);
  }
  return { date: data.date, results: data.results };
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  collectLocal = collectLocalReadings,
  collectChannelsFn = collectChannels,
  runProbeFn,
} = {}) {
  const flags = new Set(argv);
  const checkOnly = flags.has('--check');
  const noProbe = flags.has('--no-probe');
  const outIndex = argv.indexOf('--out');
  const probeIndex = argv.indexOf('--probe-report');
  const outArg = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const probeArg = probeIndex >= 0 ? argv[probeIndex + 1] : undefined;
  const normalizedOut = outArg ? (path.isAbsolute(outArg) ? outArg : path.join(ROOT, outArg)) : null;

  const now = new Date();
  const date = now.toISOString().slice(0, 10);

  let readings;
  try {
    readings = await collectLocal({ env });
  } catch (error) {
    stderr(`❌ 读不到本地三处读数（先 npm run build）：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const consistency = evaluateDefaultSetConsistency(readings);

  /* 一致性断言模式：只回答“三处读数一致吗”，不写报告。 */
  if (checkOnly) {
    const detail = Object.entries(consistency.values)
      .map(([label, value]) => `${label}=${one(value, '读不到')}`)
      .join('；');
    if (consistency.consistent) {
      stdout(`✅ 默认集三处读数一致：${detail}\n`);
      return 0;
    }
    stderr(`❌ 默认集三处读数不一致：${detail}\n`);
    for (const problem of consistency.problems) {
      // 三处数值已在上一行给出；这里只补“哪一处读不到”这类额外信息，避免同一句话打两遍
      if (!problem.includes(detail)) stderr(`  - ${problem}\n`);
    }
    return 1;
  }

  /* 报告模式：三通道 + 逐源 attempts 都采集，生成 docs/现状-<date>.md。 */
  const channels = await collectChannelsFn();
  let probe = null;
  let probeError = null;
  try {
    if (probeArg) {
      probe = readProbeReport(path.isAbsolute(probeArg) ? probeArg : path.join(ROOT, probeArg));
    } else if (!noProbe) {
      const { runProbe } = await import('./probe.mjs');
      probe = await (runProbeFn ?? runProbe)();
    }
  } catch (error) {
    probeError = error instanceof Error ? error.message : String(error);
  }

  const outPath = normalizedOut ?? path.join(ROOT, 'docs', `现状-${date}.md`);
  const generatedAt = now.toISOString();
  const document = renderStatusReport({
    date,
    generatedAt,
    gitRev: readGitRev(),
    nodeVersion: process.version,
    sourcesSetting: env.PLANTOMICS_SOURCES?.trim() || null,
    readings,
    consistency,
    channels,
    probe,
    probeError,
  });
  writeFileSync(outPath, document, 'utf8');

  const shown = path.relative(ROOT, outPath) || outPath;
  stdout(`✅ 现状报告已生成：${shown}\n`);
  if (consistency.consistent) {
    stdout(`✅ 默认集三处读数一致（${READING_LABELS.toolsListCount}=${consistency.values[READING_LABELS.toolsListCount]}）\n`);
  } else {
    stdout(`❌ 默认集三处读数不一致（报告内已标红）；\`npm run status:check\` 会 exit 1\n`);
  }
  if (probeError) stdout(`⚠️ 探活没有跑成，报告已把 attempts 记为未知：${probeError}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`❌ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

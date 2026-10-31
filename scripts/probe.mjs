#!/usr/bin/env node
/**
 * 可达性实测（probe）。
 *
 * 为什么要有这个东西：本仓库最大的失效模式**不是写错代码，而是上游悄悄变了**——
 * 域名挂了、加了 Cloudflare 挑战、改了路径、**还活着但业务信封变成 success=false**。
 * 没有实测时，这些全表现为「模型调工具报错」，你分不清是全挂还是某一个源挂了。
 *
 * 2026-10-28 对抗性审查 R08 指出：原版只要「状态码对 + JSON 能解析」就算过，
 * 于是 `{"success":false,"data":null}` 也能绿灯。现在补上**业务信封判定**。
 *
 * 用法：
 *   npm run build && npm run probe
 *   node scripts/probe.mjs --source wheatomics
 *   node scripts/probe.mjs --json
 *   node scripts/probe.mjs --attempts 1        # 关掉全部重试（默认连接层 6 次、5xx 3 次）
 *   node scripts/probe.mjs --status-attempts 1 # 5xx 也只发一次
 *
 * 退出码：任一源不符合预期 → 1（按项目规约，断言必须非零退出，不许只告警）。
 * 产物：probe-report.json（本机临时件，已在 .gitignore 里）。
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const UA = 'plant-omics-mcp-probe/0.1';
const TIMEOUT_MS = 20_000;

/**
 * 重试策略（2026-10-30 加，同日按实测补丁）。
 *
 * **连接层失败的实测依据**（调研者，本机直连 Ensembl Plants `rest.ensembl.org`）：31 次请求只有
 * 6 次拿到真实响应，其中出现过**连续 5 次 `UND_ERR_CONNECT_TIMEOUT`、第 6 次才成功**。
 * 不带重试时，一次链路抖动就会被记成"源挂了"——那是把本机出口的问题写成上游结论
 * （AGENTS §十一：HTTP/DNS/代理层错误不足以确定上游状态或排除本机原因）。
 *
 * **5xx 也要重试的实测依据**（2026-10-30 本机 probe）：`rest.ensembl.org` 一次返回 500 HTML，
 * 隔 3 秒复测即 200；不带重试时整轮探活会把这种偶发 500 记成"部分失败"。所以 5xx 重试，
 * 但**上限比连接层低**：5xx 是上游明确回的话，3 次足以区分"抖动"与"持续故障"，
 * 而连接层抖动实测要到第 6 次。
 *
 * **429 一律只发一次**：它是上游要求降速的明确信号（且带 Retry-After），替它重试等于加重限流；
 * 4xx 同理，重试只会重复挨骂。
 *
 * **每次尝试都要逐条留痕**：结果里的 `trail` 与正文都记录第几次、是连接失败（带 cause code 与耗时）
 * 还是哪个状态码（带耗时与 content-type）。2026-10-30 实测出现过「前 2 次本机连接层失败 +
 * 第 3 次拿到 500 HTML」——两类失败叠在同一条记录里，写成"第 N 次才成功"会让读者以为
 * 第 N 次拿到了数据。所以正文是**逐次列表**（`attempt 1: …｜attempt 2: …`），末尾再给一句
 * 结论（`→ 本次未取得数据` / `→ 取得数据（第 N 次尝试）`），只陈述观测，不下"源不可用"的判定。
 *
 * 代价：连接层最坏 6 次 × 20 s ≈ 2 分钟/源；需要快时用 `--attempts 1` 关掉全部重试。
 */
const RETRY_ATTEMPTS = 6;
const RETRY_STATUS_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 4_000;
/** 值得重试的 5xx：502/503/504 是代理层，500 已实测偶发（Ensembl Plants 先 500 HTML、复测 200）。 */
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

/**
 * 业务信封判定。只认两种**明确失败**的写法，其余不强求：
 *  - `success === false`（WheatOmics / Strawberry 系）
 *  - `code` 存在且不是 200 / "200"（NGDC 系，注意它的 code 是字符串）
 */
export function businessFailure(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.success === false) return `success=false：${payload.message ?? payload.error ?? '未给原因'}`;
  if ('code' in payload) {
    const code = String(payload.code);
    if (code !== '200' && code !== '0') return `code=${code}${payload.message ? `：${payload.message}` : ''}`;
  }
  return null;
}

export async function probe(bundle, {
  fetch: fetcher = globalThis.fetch,
  attempts = RETRY_ATTEMPTS,
  statusAttempts = RETRY_STATUS_ATTEMPTS,
  retryDelayMs = RETRY_BASE_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const manifest = bundle.manifest ?? bundle;
  const url = `${manifest.apiBase}${manifest.probe.path}`;
  const expected = manifest.probe.expectStatus ?? 200;
  // T1 要求是能解析、且业务信封不报错的 JSON；T2 可能返回 HTML，只看状态码（解析正确性交给离线 fixture）。
  const expect = manifest.probe.expect ?? (manifest.tier === 'T1' ? 'json' : 'any');
  const started = Date.now();
  const total = Math.max(1, Math.floor(attempts) || 1);
  const statusTotal = Math.max(1, Math.floor(statusAttempts) || 1);
  let tries = 0;
  let lastTransportError;
  /** 已收到的 5xx 次数（与连接层额度分开计，互不挤占）。 */
  let statusTries = 0;
  /**
   * 每次尝试的痕迹：`{n, kind:'connect-fail', cause, ms}` 或 `{n, status, ms, contentType}`。
   * **必须逐条留痕**：2026-10-30 实测出现过「前 2 次本机连接层失败 + 第 3 次拿到 500 HTML」
   * 这种两类失败叠在同一条记录里的情形。写成"第 N 次才成功"会让读者以为第 N 次拿到了数据，
   * 实际是拿到了一个错误页——所以输出必须是逐次列表，不是一句总结。
   */
  const trail = [];

  const causeOf = (error) => error?.cause?.code ?? error?.cause?.message;
  /** 单次尝试的一行描述。连接层用秒（实测约 10.6 s/次），拿到响应用毫秒并带 content-type。 */
  const fmtAttempt = (t) => {
    if (t.kind === 'connect-fail') {
      return `attempt ${t.n}: CONNECT_TIMEOUT${t.cause ? `(${t.cause})` : ''}，${(t.ms / 1000).toFixed(1)} s`;
    }
    if (t.kind === 'body-read-fail') {
      return `attempt ${t.n}: HTTP ${t.status} 但正文未读完（${t.ms} ms${t.cause ? `，${t.cause}` : ''}）`;
    }
    const media = t.contentType ? `，${t.contentType.split(';', 1)[0].trim()}` : '';
    return `attempt ${t.n}: HTTP ${t.status}（${t.ms} ms${media}）`;
  };
  /**
   * 结论句只陈述"这次有没有拿到数据"，**不作源可用性判断**。
   * "取得数据（第 N 次尝试）"里的 N 只用于指出是第几次，不再单独当结论——明细行才是证据。
   */
  const verdictOf = (ok) => (ok
    ? `→ 取得数据（第 ${tries} 次尝试）`
    : '→ 本次未取得数据（仅陈述观测，不作源可用性判断）');
  const detailOf = () => (trail.length > 1 ? `｜尝试明细：${trail.map(fmtAttempt).join('｜')}` : '');

  while (tries < total) {
    tries += 1;
    if (tries > 1) await sleep(Math.min(retryDelayMs * 2 ** (tries - 2), RETRY_MAX_DELAY_MS));

    const attemptStarted = Date.now();
    let response;
    try {
      response = await fetcher(url, {
        headers: { 'user-agent': UA, accept: 'application/json, text/html;q=0.9, */*;q=0.5' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // **真正**的连接层失败（DNS/超时/连接重置）：重试，cause code 与本次耗时留在明细里。
      lastTransportError = error;
      trail.push({ n: tries, kind: 'connect-fail', cause: causeOf(error), ms: Date.now() - attemptStarted });
      continue;
    }

    /**
     * 读正文失败 ≠ 没连上（2026-10-30 审查复现）。
     *
     * `response.text()` 抛错时，状态码其实已经拿到了——连接建立过、上游回过响应头，
     * 失败发生在读正文/解码这一段（连接中途断开、body 被截断、编码坏掉）。
     * 原来把它和 fetch 抛错塞进同一个 catch，结论就写成"连接层失败（均未连上）"，
     * 那是把"连上了但没读完"说成"没连上"，属于替上游下错结论（AGENTS §十一）。
     */
    let body;
    try {
      body = await response.text();
    } catch (error) {
      trail.push({
        n: tries, kind: 'body-read-fail', cause: causeOf(error), ms: Date.now() - attemptStarted,
        status: response.status, contentType: response.headers.get('content-type') ?? '',
      });
      lastTransportError = error;
      // 读正文中断也属于传输层，可重试；到上限就如实报"拿到了状态码但正文没读完"。
      if (tries < total) continue;
      return {
        id: manifest.id,
        url,
        status: response.status,
        expected,
        ok: false,
        ms: Date.now() - started,
        attempts: tries,
        trail,
        /**
         * 只写到事实为止（2026-10-30 二次更正）：收到 200 只证明**响应头到了**，
         * 读体失败可能来自链路中断、本机取消，也可能是上游没给完——三者都未排除，
         * 所以**不许**写"对面没给完"或"源不稳定"这类替上游下的结论（同 5xx 文案的纪律）。
         */
        note: `读取响应正文失败（已收到响应头 HTTP ${response.status}，正文未读完）：`
          + (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
          + (causeOf(error) ? `（cause ${causeOf(error)}）` : '')
          + '；原因未确定（链路中断 / 本机取消 / 上游未给完 均未排除）'
          + `${detailOf()}${verdictOf(false)}`,
      };
    }

    const ms = Date.now() - started;
    const contentType = response.headers.get('content-type') ?? '';
    const base = { id: manifest.id, url, status: response.status, expected, ms, attempts: tries };
    trail.push({ n: tries, status: response.status, ms: Date.now() - attemptStarted, contentType });

    if (response.status !== expected) {
      /**
       * 5xx 允许重试，**额度按"收到 5xx 的次数"计**，不按总尝试次数计。
       *
       * 2026-10-30 实测踩到：ensemblplants 先两次 CONNECT_TIMEOUT、第三次拿到 500 HTML，
       * 旧口径用 `tries < min(total, statusTotal)` 判断，于是连接失败把 5xx 的 3 次额度吃光，
       * 那个 500 一次都没被试第二次——把"偶发 5xx"报成了失败。
       * 现在单独计数：连接层额度（total）与 5xx 额度（statusTotal）互不挤占。
       */
      if (RETRYABLE_STATUS.has(response.status)) {
        statusTries += 1;
        if (statusTries < statusTotal && tries < total) continue;
      }
      return {
        ...base, trail, ok: false,
        note: `状态 ${response.status} ≠ 期望 ${expected}：${body.slice(0, 120).replace(/\s+/g, ' ')}${detailOf()}${verdictOf(false)}`,
      };
    }
    if (expect === 'any') {
      return { ...base, trail, ok: true, note: `HTTP ${response.status}·${body.length} B（T2：只看状态码）${detailOf()}${verdictOf(true)}` };
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return { ...base, trail, ok: false, note: `不是合法 JSON：${body.slice(0, 120).replace(/\s+/g, ' ')}${detailOf()}${verdictOf(false)}` };
    }
    const failure = businessFailure(payload);
    if (failure) return { ...base, trail, ok: false, note: `业务信封报错（${failure}）${detailOf()}${verdictOf(false)}` };

    try {
      await bundle.validateProbe?.(payload);
    } catch (error) {
      return { ...base, trail, ok: false, note: `源级断言失败：${error instanceof Error ? error.message : String(error)}${detailOf()}${verdictOf(false)}` };
    }
    return { ...base, trail, ok: true, note: `${Buffer.byteLength(body, 'utf8')} B JSON，业务信封及源级断言正常${detailOf()}${verdictOf(true)}` };
  }

  /**
   * 汇总句**只能由轨迹归纳**，不许另算一遍（2026-10-30 审查：混合轨迹里汇总说"两次均未连上"，
   * 而明细第一条明明是"已收到响应头、正文未读完"——两者打架）。
   *
   * 归纳规则（代码生成，不手写分支，手写迟早漏组合）：
   *   轨迹有 body-read-fail       → 汇总**不得**出现"均未连上"
   *   轨迹全为 connect-fail        → 才写"均未连上"
   *   轨迹出现过上游状态码          → 汇总必须写出该状态码
   */
  const summarizeTrail = (entries) => {
    const connectFails = entries.filter((t) => t.kind === 'connect-fail').length;
    const bodyFails = entries.filter((t) => t.kind === 'body-read-fail');
    const statusEntries = entries.filter((t) => t.kind === undefined && typeof t.status === 'number');
    const parts = [];
    if (connectFails > 0) parts.push(`连接未建立 ${connectFails} 次`);
    if (bodyFails.length > 0) {
      const codes = [...new Set(bodyFails.map((t) => t.status))].join('/');
      parts.push(`已收到响应头但正文未读完 ${bodyFails.length} 次（状态码 ${codes}）`);
    }
    if (statusEntries.length > 0) {
      const codes = [...new Set(statusEntries.map((t) => t.status))].join('/');
      parts.push(`上游返回状态码 ${codes} 共 ${statusEntries.length} 次`);
    }
    return parts.join('；') || '无可用轨迹';
  };

  const lastErrorText = (lastTransportError instanceof Error
    ? `${lastTransportError.name}: ${lastTransportError.message}`
    : String(lastTransportError))
    + (causeOf(lastTransportError) ? `（cause ${causeOf(lastTransportError)}）` : '');

  const onlyConnectFails = trail.every((t) => t.kind === 'connect-fail');
  return {
    id: manifest.id,
    url,
    status: 0,
    expected,
    ok: false,
    ms: Date.now() - started,
    attempts: tries,
    trail,
    note: onlyConnectFails
      // 全部未连上：这才能说"均未连上"（且仍只到"本机连不上"，不下源结论）
      ? `连接层失败（共 ${tries} 次尝试均未连上，本机到该端点的链路问题，不是状态码结论）：`
        + lastErrorText + `${detailOf()}${verdictOf(false)}`
      // 混合轨迹：汇总由上面归纳生成，不另写结论
      : `本次未取得数据（仅陈述观测，不作源可用性判断）｜失败构成：${summarizeTrail(trail)}；最后一次：`
        + lastErrorText + `${detailOf()}${verdictOf(false)}`,
  };
}

/** No imports of dist, network requests or writes occur until called. */
export async function runProbe({ registry, fetch: fetcher = globalThis.fetch, only, attempts, statusAttempts } = {}) {
  registry ??= (await import('../dist/sources/index.js')).createRegistry();
  const sources = registry.listSources().filter(({ manifest }) => !only || manifest.id === only);
  const results = [];
  for (const bundle of sources) results.push(await probe(bundle, { fetch: fetcher, attempts, statusAttempts }));
  return { date: new Date().toISOString().slice(0, 10), results };
}

export async function main({
  args = process.argv.slice(2), registry, fetch: fetcher = globalThis.fetch,
  writer = writeFileSync,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  const sourceIndex = args.indexOf('--source');
  const only = sourceIndex < 0 ? undefined : args[sourceIndex + 1];
  if (sourceIndex >= 0 && (!only || only.startsWith('--'))) {
    stderr('--source 需要源 id\n');
    return 2;
  }
  /**
   * 命令行只收**正整数**（2026-10-30 审查复现：`--attempts 0` 与 `--attempts 1.5` 原来会被
   * 静默夹成 1 接受）。次数是给人看的口径，0 次或 1.5 次没有意义；
   * 与其猜用户想表达什么，不如报错让他说清。程序内调用仍保留夹取，见 `probe()` 注释。
   */
  const positiveInt = (raw, flag, desc) => {
    if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < 1) {
      stderr(`${flag} 需要正整数（${desc}；收到「${raw ?? ''}」）\n`);
      return null;
    }
    return Number(raw);
  };

  const attemptsIndex = args.indexOf('--attempts');
  let attempts;
  if (attemptsIndex >= 0) {
    attempts = positiveInt(args[attemptsIndex + 1], '--attempts', '连接层重试的总尝试次数，默认 6；1 = 关掉重试');
    if (attempts === null) return 2;
  }

  const statusIndex = args.indexOf('--status-attempts');
  let statusAttempts;
  if (statusIndex >= 0) {
    statusAttempts = positiveInt(args[statusIndex + 1], '--status-attempts', '5xx 重试的总尝试次数，默认 3；1 = 5xx 也只发一次');
    if (statusAttempts === null) return 2;
  }

  const report = await runProbe({ registry, fetch: fetcher, only, attempts, statusAttempts });
  const { date, results } = report;
  if (!results.length) {
    stderr(`没有匹配的源${only ? `：${only}` : ''}\n`);
    return 2;
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await writer('probe-report.json', json, 'utf8');
  if (args.includes('--json')) stdout(json);
  else {
    stdout(`# 可达性实测 ${date}\n\n`);
    stdout('| 源 | 端点 | HTTP | 期望 | 耗时 | 结论 |\n|---|---|---|---|---|---|\n');
    for (const r of results) {
      stdout(`| ${r.id} | ${r.url.replace(/^https?:\/\//, '')} | ${r.status} | ${r.expected} | ${r.ms} ms | ${r.ok ? `✅ ${r.note}` : `❌ ${r.note}`} |\n`);
    }
    stdout('\n> 本表只证明所列探活端点及其断言通过，不代表全部工具可用；工具正确性由离线 fixture 测试保证。\n');
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) stderr(`\n${failed.length}/${results.length} 个源实测失败：${failed.map((r) => r.id).join(', ')}\n`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

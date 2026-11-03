#!/usr/bin/env node
/**
 * fixture 可复现性检查（**联网**，独立自检入口，不进 `npm test`）。
 *
 * 做什么：把每个 fixture 的 `capture.request` 原样重打一次上游，按**两级判据**比对。
 *
 * **主判据：canonicalSha256（键排序后序列化再哈希）。** 跨次稳定，证明"内容没变"。
 * 上游的 JSON 键序并不稳定（Ensembl Plants 实测：同一请求两次，内容相同、字节不同），
 * 所以字节哈希不能当"变了没变"的判据——否则每次重抓都红，最后一定被当噪音关掉。
 *
 * **副判据：字节 sha256。** 相等记 `byte-identical`；不等但 canonical 相等记
 * `byte-order-unstable`——**这不是失败**，只是上游换了序列化顺序。
 * 另外状态码与 content-type 仍按原口径比对（这两项不是序列化噪声）。
 *
 * **它证明什么、不证明什么（别读过头）：**
 * - canonical 一致 ⇒ "此刻上游对这个请求返回的**内容**，与 fixture 记录的一致"；
 * - 字节一致 ⇒ 还额外说明"连序列化都没变"；
 * - **不证明**"当初那一刻确实抓过"——抓取时刻只能靠采集留痕，hash 做不到。
 *   所以 fixture 的 `captureTimeStatus` 仍是未知/确证两档，本脚本不改它。
 * - `simulated: true` 的件直接 SKIP：合成件不参与"可复现"统计（证据层级底线）。
 *
 * 为什么不进 `npm test`：`npm test` 必须全离线（AGENTS §四）。上游是否活着/是否变过，
 * 由本脚本与 `probe` 这类联网入口回答，两处红必须能一眼分开。
 *
 * 用法：
 *   node scripts/verify-fixtures.mjs --source string
 *   node scripts/verify-fixtures.mjs --source string --source wheatomics
 *   node scripts/verify-fixtures.mjs --source string --json --out %TEMP%/verify.json
 *
 * 退出码：任一 DIFF / 请求失败 → 1；参数错误（没给 --source、源目录不存在）→ 2。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'plant-omics-fixture-verify/0.1';
const TIMEOUT_MS = 30_000;
const ROOT = process.cwd();

const argv = process.argv.slice(2);
const argValues = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []));
const sources = argValues('--source');
// `--dir`：直接给一个 fixtures 目录（离线测试用，跳过按源目录枚举）
const dirOverride = argValues('--dir')[0];
const outPath = argValues('--out')[0];
const asJson = argv.includes('--json');

if (sources.length === 0 && !dirOverride) {
  console.error('用法：node scripts/verify-fixtures.mjs --source <源id> [--source <源id>...] [--json] [--out <path>]\n'
    + '说明：本脚本会**真实请求上游**，所以不设默认源，避免误触发大量请求。');
  process.exit(2);
}

const normCt = (value) => String(value ?? '').split(';', 1)[0].trim().toLowerCase();

/**
 * 规范化序列化：对象键递归排序，数组保持原序，无多余空白。
 * 只抹掉"序列化差异"，不抹掉内容差异——顺序敏感的数组不许被排序。
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256Of = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex').toUpperCase();

/** 把 JSON 文本转成 canonical 哈希；不是 JSON 则返回 null（非 JSON 上游没有 canonical 可比）。 */
function canonicalShaOfText(text) {
  try {
    return sha256Of(canonicalJson(JSON.parse(text)));
  } catch {
    return null;
  }
}

/** 从 `capture.request`（形如 `GET https://…`）取方法与 URL。 */
function parseRequest(request) {
  const m = /^([A-Z]+)\s+(\S+)$/.exec(String(request ?? '').trim());
  return m ? { method: m[1], url: m[2] } : null;
}

async function checkOne(filePath, sourceId, fixtureName) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const capture = raw.capture ?? {};
  if (capture.simulated === true) return { sourceId, fixture: fixtureName, verdict: 'SKIP', reason: 'simulated=true（合成件不计入可复现）' };
  const parsed = parseRequest(capture.request);
  if (!parsed) return { sourceId, fixture: fixtureName, verdict: 'SKIP', reason: 'capture.request 缺失或不可解析' };
  if (parsed.method !== 'GET') return { sourceId, fixture: fixtureName, verdict: 'SKIP', reason: `method=${parsed.method}（本脚本只复现 GET）` };

  const started = Date.now();
  let response;
  let body;
  try {
    response = await fetch(parsed.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/json, text/plain;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return {
      sourceId, fixture: fixtureName, verdict: 'ERROR', url: parsed.url, ms: Date.now() - started,
      reason: `请求失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    };
  }

  const sha = createHash('sha256').update(body).digest('hex').toUpperCase();
  const bodyText = body.toString('utf8');
  const gotCanonical = canonicalShaOfText(bodyText);

  // 参考 canonical 必须来自**原体**，不能来自裁剪件：
  // 1) fixture 显式记录的 canonicalSha256 优先；
  // 2) 存了 rawBody 就用 rawBody 算（原体为准）；
  // 3) 没有原体、且 payload 是白名单裁剪（capture.cropping 有值）→ canonical 不可比，退回字节判据。
  //    否则会拿"裁剪后的子集"去比"完整原体"，每份都假 DIFF。
  const rawBody = typeof raw.rawBody === 'string' ? raw.rawBody : undefined;
  const cropped = rawBody === undefined && capture.cropping != null;
  let wantCanonical = '';
  let canonicalSource = '';
  if (capture.canonicalSha256) {
    wantCanonical = String(capture.canonicalSha256).toUpperCase();
    canonicalSource = 'fixture 记录';
  } else if (rawBody !== undefined) {
    wantCanonical = canonicalShaOfText(rawBody) ?? '';
    canonicalSource = 'rawBody';
  } else if (raw.payload !== undefined && !cropped) {
    wantCanonical = sha256Of(canonicalJson(raw.payload));
    canonicalSource = 'payload（非裁剪）';
  } else {
    canonicalSource = '无可比原体（裁剪件且无 rawBody）';
  }

  const diffs = [];
  if (response.status !== capture.status) diffs.push(`status ${capture.status} → ${response.status}`);
  const wantCt = normCt(capture.contentType);
  const gotCt = normCt(response.headers.get('content-type'));
  if (wantCt !== gotCt) diffs.push(`content-type "${wantCt}" → "${gotCt}"`);

  const wantSha = String(capture.sourceSha256 ?? '').toUpperCase();
  const byteIdentical = wantSha ? sha === wantSha : body.length === capture.sourceBytes;

  /** 主判据是 canonical；没有可比原体（或上游不返回 JSON）时才退回字节判据。 */
  let judgedBy = 'canonical';
  let unproven = '';
  if (wantCanonical && gotCanonical) {
    if (wantCanonical !== gotCanonical) {
      diffs.push(`canonical ${wantCanonical.slice(0, 12)}… → ${gotCanonical.slice(0, 12)}…（内容确实变了）`);
    }
  } else {
    judgedBy = 'bytes';
    if (!wantSha) {
      // 只记了字节数、没记哈希：长度相等不等于内容相等（上游换序就是同长不同字节）。
      // 这种件必须报"判不了"，不能因为长度对上就算 OK——那正是拿一个看似合理的数冒充结论。
      unproven = `未记录 sourceSha256（${canonicalSource}），只能比字节数（${capture.sourceBytes} → ${body.length}）；`
        + '长度相等证明不了内容相等，补 rawBody / canonicalSha256 或哈希后才能判';
    } else if (sha !== wantSha) {
      // 字节不同而 canonical 不可比：**不能判"内容变了"，也不能判 OK**。
      // 这是"判不了"，必须显式说出来，否则等于用字节差异冒充结论。
      unproven = `字节不同（sha ${wantSha.slice(0, 12)}… → ${sha.slice(0, 12)}…），但${canonicalSource}，`
        + '无法判断内容是否一致；补 rawBody（或 canonicalSha256）后才能判';
    } else if (body.length !== capture.sourceBytes) {
      unproven = `字节数不同（${capture.sourceBytes} → ${body.length}），但${canonicalSource}，无法判断内容是否一致`;
    }
  }

  const verdict = diffs.length > 0 ? 'DIFF' : unproven ? 'UNPROVEN' : 'OK';
  return {
    sourceId, fixture: fixtureName,
    verdict,
    // 副判据只作留痕：签名字节不同但内容一致 ⇒ 上游序列化顺序变了，不算失败。
    byteOrder: verdict === 'OK' ? (byteIdentical ? 'byte-identical' : 'byte-order-unstable') : 'n/a',
    judgedBy,
    canonicalSource,
    url: parsed.url, ms: Date.now() - started,
    status: response.status, bytes: body.length, sha256: sha, canonicalSha256: gotCanonical ?? '',
    contentType: response.headers.get('content-type') ?? '',
    captureTimeStatus: capture.captureTimeStatus ?? '(未标)',
    reason: diffs.length > 0 ? diffs.join('；') : unproven,
  };
}

const results = [];
if (dirOverride) {
  if (!existsSync(dirOverride)) { console.error('目录不存在：' + dirOverride); process.exit(2); }
  const label = sources[0] ?? 'dir';
  for (const name of readdirSync(dirOverride).filter((n) => n.endsWith('.json')).sort()) {
    results.push(await checkOne(join(dirOverride, name), label, name));
  }
}
for (const sourceId of (dirOverride ? [] : sources)) {
  const dir = join(ROOT, 'src', 'sources', sourceId, 'fixtures');
  if (!existsSync(dir)) {
    console.error(`源 ${sourceId} 的 fixtures 目录不存在：${dir}`);
    process.exit(2);
  }
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    results.push(await checkOne(join(dir, name), sourceId, name));
  }
}

const summary = {
  ranAt: new Date().toISOString(),
  node: process.version,
  sources,
  totals: {
    ok: results.filter((r) => r.verdict === 'OK').length,
    diff: results.filter((r) => r.verdict === 'DIFF').length,
    error: results.filter((r) => r.verdict === 'ERROR').length,
    skip: results.filter((r) => r.verdict === 'SKIP').length,
    unproven: results.filter((r) => r.verdict === 'UNPROVEN').length,
    byteIdentical: results.filter((r) => r.byteOrder === 'byte-identical').length,
    byteOrderUnstable: results.filter((r) => r.byteOrder === 'byte-order-unstable').length,
    judgedByBytes: results.filter((r) => r.judgedBy === 'bytes').length,
  },
  note: '主判据 canonicalSha256（键排序后哈希）：证明「此刻上游返回的内容与 fixture 一致」，'
    + '不证明当初抓取时刻，captureTimeStatus 仍按原记录口径（确证/未知）使用。'
    + '副判据字节 sha256 只作留痕：byte-order-unstable = 内容一致、上游序列化顺序变了，不算失败；'
    + 'judgedBy=bytes 的件是非 JSON 响应或没有可比原体（payload 是白名单裁剪、又没存 rawBody），'
    + '此时退回字节比对——裁剪件不能拿 payload 去比完整原体，否则每份都是假 DIFF。'
    + 'UNPROVEN = 字节不同/不同长、又没有可比原体：这是"判不了"，不是"内容变了"，'
    + '补 rawBody 或 canonicalSha256 后重跑即可判定；它与 DIFF 一起非零退出。',
  results,
};

if (asJson) {
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (outPath) writeFileSync(outPath, text, 'utf8');
  process.stdout.write(text);
} else {
  for (const r of results) {
    const flag = { OK: 'OK  ', DIFF: 'DIFF', ERROR: 'ERR ', SKIP: 'SKIP', UNPROVEN: 'UNPV' }[r.verdict];
    const tag = r.byteOrder === 'byte-order-unstable'
      ? ' [字节序不稳定·内容一致]'
      : r.judgedBy === 'bytes' && r.verdict === 'OK' ? ` [按字节判：${r.canonicalSource}]` : '';
    const detail = r.verdict === 'OK'
      ? `${r.status} ${r.bytes}B ct=${normCt(r.contentType) || '(空)'} ${r.ms}ms 时刻=${r.captureTimeStatus}${tag}`
      : r.reason;
    process.stdout.write(`${flag} ${r.sourceId}/${r.fixture}  ${detail}\n`);
  }
  const { ok, diff, error, skip, unproven, byteIdentical, byteOrderUnstable, judgedByBytes } = summary.totals;
  process.stdout.write(`\n合计 ${results.length} 份：OK ${ok}、DIFF ${diff}、UNPROVEN ${unproven}、ERROR ${error}、SKIP ${skip}\n`);
  process.stdout.write(`其中 OK 的字节对照：逐字节一致 ${byteIdentical}、字节序不稳定但内容一致 ${byteOrderUnstable}`
    + (judgedByBytes ? `、按字节判（非 JSON 或无 canonical 记录）${judgedByBytes}` : '') + '\n');
  process.stdout.write(`${summary.note}\n`);
  if (outPath) process.stdout.write(`saved ${outPath}\n`);
}

// UNPROVEN 也算非零："判不了"不能被当成"没事"，否则覆盖缺口会被静默带过。
const bad = summary.totals.diff + summary.totals.error + summary.totals.unproven;
// 用 exitCode 而非 process.exit()：Windows 上 process.exit 可能在 undici 的 async handle
// 尚未关闭时触发 libuv 断言（子进程表现为 "Assertion failed ... UV_HANDLE_CLOSING"）。
process.exitCode = bad === 0 ? 0 : 1;

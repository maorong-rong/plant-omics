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
 *
 * 退出码：任一源不符合预期 → 1（按项目规约，断言必须非零退出，不许只告警）。
 * 产物：probe-report.json（本机临时件，已在 .gitignore 里）。
 */

import { writeFileSync } from 'node:fs';
import { createRegistry } from '../dist/sources/index.js';

const UA = 'plant-omics-mcp-probe/0.1';
const TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
const only = args.includes('--source') ? args[args.indexOf('--source') + 1] : undefined;
const asJson = args.includes('--json');

const registry = createRegistry();
const sources = registry
  .listSources()
  .map((bundle) => bundle.manifest)
  .filter((manifest) => (only ? manifest.id === only : true));

if (sources.length === 0) {
  process.stderr.write(`没有匹配的源${only ? `：${only}` : ''}\n`);
  process.exit(2);
}

/**
 * 业务信封判定。只认两种**明确失败**的写法，其余不强求：
 *  - `success === false`（WheatOmics / Strawberry 系）
 *  - `code` 存在且不是 200 / "200"（NGDC 系，注意它的 code 是字符串）
 */
function businessFailure(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.success === false) return `success=false：${payload.message ?? payload.error ?? '未给原因'}`;
  if ('code' in payload) {
    const code = String(payload.code);
    if (code !== '200' && code !== '0') return `code=${code}${payload.message ? `：${payload.message}` : ''}`;
  }
  return null;
}

async function probe(manifest) {
  const url = `${manifest.apiBase}${manifest.probe.path}`;
  const expected = manifest.probe.expectStatus ?? 200;
  // T1 要求是能解析、且业务信封不报错的 JSON；T2 可能返回 HTML，只看状态码（解析正确性交给离线 fixture）。
  const expect = manifest.probe.expect ?? (manifest.tier === 'T1' ? 'json' : 'any');
  const started = Date.now();

  try {
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json, text/html;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.text();
    const ms = Date.now() - started;
    const base = { id: manifest.id, url, status: response.status, expected, ms };

    if (response.status !== expected) {
      return { ...base, ok: false, note: `状态 ${response.status} ≠ 期望 ${expected}：${body.slice(0, 120).replace(/\s+/g, ' ')}` };
    }
    if (expect === 'any') {
      return { ...base, ok: true, note: `HTTP ${response.status}·${body.length} B（T2：只看状态码）` };
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return { ...base, ok: false, note: `不是合法 JSON：${body.slice(0, 120).replace(/\s+/g, ' ')}` };
    }
    const failure = businessFailure(payload);
    if (failure) return { ...base, ok: false, note: `业务信封报错（${failure}）` };

    return { ...base, ok: true, note: `${body.length} B JSON，业务信封正常` };
  } catch (error) {
    return {
      id: manifest.id,
      url,
      status: 0,
      expected,
      ok: false,
      ms: Date.now() - started,
      note: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

const results = [];
for (const manifest of sources) results.push(await probe(manifest));

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  'probe-report.json',
  `${JSON.stringify({ date: today, results }, null, 2)}\n`,
  'utf8',
);

if (asJson) {
  process.stdout.write(`${JSON.stringify({ date: today, results }, null, 2)}\n`);
} else {
  process.stdout.write(`# 可达性实测 ${today}\n\n`);
  process.stdout.write('| 源 | 端点 | HTTP | 期望 | 耗时 | 结论 |\n|---|---|---|---|---|---|\n');
  for (const r of results) {
    process.stdout.write(
      `| ${r.id} | ${r.url.replace(/^https?:\/\//, '')} | ${r.status} | ${r.expected} | ${r.ms} ms | ${r.ok ? `✅ ${r.note}` : `❌ ${r.note}`} |\n`,
    );
  }
  process.stdout.write('\n> 本表只证明「一个探活端点可用」，**不等于六个工具都能用**；工具正确性由离线 fixture 测试保证。\n');
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  process.stderr.write(`\n${failed.length}/${results.length} 个源实测失败：${failed.map((r) => r.id).join(', ')}\n`);
  process.exitCode = 1;
}

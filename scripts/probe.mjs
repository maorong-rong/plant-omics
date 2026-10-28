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
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const UA = 'plant-omics-mcp-probe/0.1';
const TIMEOUT_MS = 20_000;

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

export async function probe(bundle, { fetch: fetcher = globalThis.fetch } = {}) {
  const manifest = bundle.manifest ?? bundle;
  const url = `${manifest.apiBase}${manifest.probe.path}`;
  const expected = manifest.probe.expectStatus ?? 200;
  // T1 要求是能解析、且业务信封不报错的 JSON；T2 可能返回 HTML，只看状态码（解析正确性交给离线 fixture）。
  const expect = manifest.probe.expect ?? (manifest.tier === 'T1' ? 'json' : 'any');
  const started = Date.now();

  try {
    const response = await fetcher(url, {
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

    try {
      await bundle.validateProbe?.(payload);
    } catch (error) {
      return { ...base, ok: false, note: `源级断言失败：${error instanceof Error ? error.message : String(error)}` };
    }
    return { ...base, ok: true, note: `${Buffer.byteLength(body, 'utf8')} B JSON，业务信封及源级断言正常` };
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

/** No imports of dist, network requests or writes occur until called. */
export async function runProbe({ registry, fetch: fetcher = globalThis.fetch, only } = {}) {
  registry ??= (await import('../dist/sources/index.js')).createRegistry();
  const sources = registry.listSources().filter(({ manifest }) => !only || manifest.id === only);
  const results = [];
  for (const bundle of sources) results.push(await probe(bundle, { fetch: fetcher }));
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
  const report = await runProbe({ registry, fetch: fetcher, only });
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

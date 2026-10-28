import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { validateProbe } from '../src/sources/strawberry/probe.js';

// Script is JS, intentionally not part of the TS compilation inputs.
// @ts-expect-error No declaration file for the standalone CLI script.
import { businessFailure, main, probe, runProbe } from '../scripts/probe.mjs';

// Real captured status; all negative mutations below are SYNTHETIC, not upstream observations.
const captured = JSON.parse(readFileSync(new URL('../src/sources/strawberry/fixtures/genes-status.json', import.meta.url), 'utf8'));
const normal = () => structuredClone(captured.payload);
const manifest = { id: 'strawberry', tier: 'T1', apiBase: 'https://example.invalid/api', probe: { path: '/genes/status' } };
const bundle = { manifest, validateProbe };
const registry = { listSources: () => [bundle] };
const response = (payload: unknown, status = 200) => async () => new Response(JSON.stringify(payload), { status });

describe('probe offline synthetic cases', () => {
  it('accepts captured normal status without fixing the observed example count in the validator', async () => {
    expect(captured.capture.status).toBe(200);
    expect(captured.capture.contentType).toContain('application/json');
    expect(normal().examples).toHaveLength(60);
    expect(() => validateProbe(normal())).not.toThrow();
    expect(() => validateProbe({ ...normal(), examples: normal().examples.slice(0, 1) })).not.toThrow();
    expect((await probe(bundle, { fetch: response(normal()) })).ok).toBe(true);
  });

  const invalid: [string, unknown][] = [
    ['disabled', { ...normal(), enabled: false }],
    ['unavailable', { ...normal(), available: false }],
    ['missing fields', {}], ['null', null], ['top array', []],
    ['wrong enabled type', { ...normal(), enabled: 'true' }],
    ['wrong available type', { ...normal(), available: 1 }],
    ['wrong examples type', { ...normal(), examples: {} }],
    ['missing examples', { enabled: true, available: true }],
    ['wrong row type', { ...normal(), examples: [null] }],
    ...['species', 'version', 'geneId'].flatMap((key): [string, unknown][] => [
      [`wrong ${key} type`, { ...normal(), examples: [{ ...normal().examples[0], [key]: 1 }] }],
      [`blank ${key}`, { ...normal(), examples: [{ ...normal().examples[0], [key]: '  ' }] }],
    ]),
  ];
  it.each(invalid)('rejects synthetic %s', async (_label, payload) => {
    expect(() => validateProbe(payload)).toThrow();
    const result = await probe(bundle, { fetch: response(payload) });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.note).toContain('源级断言失败');
  });

  it.each(['<html>synthetic fallback</html>', '{invalid'])('rejects synthetic JSON-format failure %s', async (body) => {
    const result = await probe(bundle, { fetch: async () => new Response(body) });
    expect(result.ok).toBe(false);
    expect(result.note).toContain('不是合法 JSON');
  });

  it('rejects synthetic HTTP429 before business validation', async () => {
    const validator = vi.fn();
    const fetch = vi.fn(async () => new Response(JSON.stringify(normal()), { status: 429, headers: { 'Retry-After': '1' } }));
    const result = await probe({ manifest, validateProbe: validator }, { fetch });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(validator).not.toHaveBeenCalled();
  });

  it('retains WheatOmics business envelope success and failure behavior', async () => {
    const wheat = { manifest: { ...manifest, id: 'wheatomics' } };
    for (const payload of [{ success: false }, { code: 500 }, { code: '429' }]) {
      expect(businessFailure(payload)).toBeTruthy();
      expect((await probe(wheat, { fetch: response(payload) })).ok).toBe(false);
    }
    for (const payload of [{ success: true, data: [] }, { code: 200 }, { code: '200' }, { code: '0' }]) {
      expect((await probe(wheat, { fetch: response(payload) })).ok).toBe(true);
    }
  });

  it('aggregates failures, writes through injected writer and returns CLI code 1', async () => {
    const writer = vi.fn();
    const stdout = vi.fn();
    expect(await main({ args: ['--json'], registry, fetch: response({}), writer, stdout, stderr: vi.fn() })).toBe(1);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.mock.calls[0]![0]).results[0].ok).toBe(false);
    expect((await runProbe({ registry, fetch: response(normal()) })).results[0].ok).toBe(true);
    expect(await main({ args: ['--source', 'missing'], registry, fetch: response(normal()), writer, stderr: vi.fn() })).toBe(2);
  });

  it('import is inert even when fetch and file writes are forbidden', () => {
    const url = pathToFileURL(resolve('scripts/probe.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      fs.writeFileSync = () => { throw Error('unexpected write'); };
      syncBuiltinESMExports();
      globalThis.fetch = () => { throw Error('unexpected network'); };
      await import(${JSON.stringify(url)});
    `], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each(['disabled', 'unavailable', 'missing', 'format', '429'])('real isolated node CLI harness exits 1 for synthetic %s (no network/write)', (kind) => {
    const url = pathToFileURL(resolve('scripts/probe.mjs')).href;
    const payload = kind === 'disabled' ? { ...normal(), enabled: false }
      : kind === 'unavailable' ? { ...normal(), available: false } : {};
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { main } from ${JSON.stringify(url)};
      const validateProbe = ${validateProbe.toString()};
      const registry = { listSources: () => [{ manifest: ${JSON.stringify(manifest)}, validateProbe }] };
      const fetch = async () => new Response(${JSON.stringify(kind === 'format' ? '<html>synthetic</html>' : JSON.stringify(payload))},
        { status: ${kind === '429' ? 429 : 200}, headers: { 'Retry-After': '1' } });
      globalThis.fetch = () => { throw Error('real network forbidden'); };
      process.exitCode = await main({ args: [], registry, fetch, writer: () => {}, stdout: () => {}, stderr: (s) => process.stderr.write(s) });
    `], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('1/1 个源实测失败');
    expect(result.status).toBe(1);
  });
});

import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `scripts/verify-fixtures.mjs` 的离线自检（2026-11-01）。
 *
 * 那个脚本本身**联网**（重打上游、比对状态/字节/sha256/content-type），不能进 `npm test` 的常规路径；
 * 但"它会不会把 OK 判错"必须能离线验。这里起一个本地回环 HTTP 服务，让 fixture 的
 * `capture.request` 指向它：同字节 → OK、sha 不符 → DIFF、`simulated:true` → SKIP。
 *
 * 注意：子进程必须用**异步** `execFile`（不是 `spawnSync`）——spawnSync 会阻塞父进程事件循环，
 * 本地服务无法应答，子进程只能干等超时（第一版就这么挂了，60 s 全超时）。
 */

const SCRIPT = resolve('scripts/verify-fixtures.mjs');
const CHILD_TIMEOUT_MS = 60_000;

function runAsync(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, args, { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number'
        ? (error as { code: number }).code
        : error ? 1 : 0;
      done({ code, stdout, stderr });
    });
  });
}

describe('verify-fixtures：判定逻辑（离线、本地回环）', () => {
  it('主判据 canonical：字节序不同但内容一致 → OK 且不算失败；canonical 不同才 DIFF；simulated → SKIP', async () => {
    const body = JSON.stringify({ hello: 'world', n: 1 });
    const sha = createHash('sha256').update(Buffer.from(body)).digest('hex').toUpperCase();
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/json; charset=utf-8' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));

    const dir = mkdtempSync(join(tmpdir(), 'po-vf-'));
    try {
      const fixtures = join(dir, 'fixtures');
      mkdirSync(fixtures);
      const { port } = server.address() as { port: number };
      const capture = {
        request: `GET http://127.0.0.1:${port}/x`,
        status: 200,
        contentType: 'text/json; charset=utf-8',
        sourceBytes: Buffer.byteLength(body),
        sourceSha256: sha,
        simulated: false,
        captureTimeStatus: '未知',
      };
      writeFileSync(join(fixtures, 'same.json'), JSON.stringify({ capture, payload: JSON.parse(body) }), 'utf8');
      // 上游键序不稳定：记录里的字节哈希对不上，但键排序后的内容相同 → 必须判 OK
      writeFileSync(join(fixtures, 'reorder.json'), JSON.stringify({
        capture: { ...capture, sourceSha256: 'B'.repeat(64) },
        payload: { n: 1, hello: 'world' },
        rawBody: '{"n":1,"hello":"world"}',
      }), 'utf8');
      // 内容真变了：canonical 对不上 → DIFF
      writeFileSync(join(fixtures, 'diff.json'), JSON.stringify({
        capture: { ...capture, sourceSha256: 'A'.repeat(64) }, payload: { hello: 'changed' },
      }), 'utf8');
      // 没有 canonical 可比（无 payload、非 JSON 上游走这条）→ 退回字节判据
      writeFileSync(join(fixtures, 'fallback.json'), JSON.stringify({ capture }), 'utf8');
      // 裁剪件、无原体、字节又对不上 → **判不了**，必须显式 UNPROVEN，不能冒充 DIFF 或 OK
      writeFileSync(join(fixtures, 'unproven.json'), JSON.stringify({
        capture: { ...capture, sourceSha256: 'C'.repeat(64), cropping: 'Field whitelist only' },
        payload: { hello: 'world' },
      }), 'utf8');
      writeFileSync(join(fixtures, 'sim.json'), JSON.stringify({
        capture: { ...capture, simulated: true }, payload: {},
      }), 'utf8');

      const out = await runAsync([SCRIPT, '--dir', fixtures, '--source', 'demo', '--json']);
      expect(out.code, `子进程应因 DIFF 非零退出；stderr=${out.stderr.slice(0, 200)}`).toBe(1);
      const report = JSON.parse(out.stdout);
      const byName = Object.fromEntries(
        report.results.map((r: { fixture: string; verdict: string; byteOrder: string; judgedBy: string }) => [r.fixture, r]),
      );
      expect(byName['same.json'].verdict).toBe('OK');
      expect(byName['same.json'].byteOrder).toBe('byte-identical');
      // 关键：这条证明"判据真的换了"——旧实现（只比字节）必定把它判成 DIFF
      expect(byName['reorder.json'].verdict).toBe('OK');
      expect(byName['reorder.json'].byteOrder).toBe('byte-order-unstable');
      expect(byName['reorder.json'].judgedBy).toBe('canonical');
      expect(byName['diff.json'].verdict).toBe('DIFF');
      expect(byName['diff.json'].reason).toContain('内容确实变了');
      expect(byName['fallback.json'].verdict).toBe('OK');
      expect(byName['fallback.json'].judgedBy).toBe('bytes');
      expect(byName['unproven.json'].verdict).toBe('UNPROVEN');
      expect(byName['unproven.json'].reason).toContain('无法判断内容是否一致');
      expect(byName['sim.json'].verdict).toBe('SKIP');
      expect(report.totals).toEqual({
        ok: 3, diff: 1, error: 0, skip: 1,
        unproven: 1,
        // same.json 与 fallback.json 都是逐字节一致（后者只是走字节判据）
        byteIdentical: 2, byteOrderUnstable: 1, judgedByBytes: 2,
      });
      // 口径必须随报告给出：hash 一致 ≠ 证明抓取时刻
      expect(report.note).toContain('不证明当初抓取时刻');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('没给 --source / --dir → exit 2（联网脚本不设默认源，避免误触发大量请求）', () => {
    const out = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('不设默认源');
  }, 60_000);
});

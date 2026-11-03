#!/usr/bin/env node
/**
 * 极简静态服务器（本地验证落地页 / 源市场页）。
 * 零依赖：只用 node:http + node:fs + 全局 fetch，避免为看一页去装一把工具。
 *
 * 用法：
 *   node site/scripts/serve.mjs 8091
 *   node site/scripts/serve.mjs 8091 --catalog-upstream http://127.0.0.1:8787
 *
 * `--catalog-upstream` 是**显式开关**，默认关闭：
 * - 关闭时本脚本只发静态文件，`fetch('/catalog')` 404 —— 市场页停在「待 /catalog」骨架。
 *   这是本地真实状态，别把「骨架能渲染」说成「同源跑通」。
 * - 打开时只把 `/catalog`（精确路径，含 query）转给指定上游，用来验证同源取数后的真实渲染。
 *   它不是通用反代，不转发任何其他路径，也不读任何凭据；只监听回环地址，**不上生产**。
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ── 参数 ─────────────────────────────────────────────────────────────── */
let PORT = null;
let CATALOG_UPSTREAM = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--catalog-upstream') {
    const value = argv[i + 1];
    if (!value) {
      console.error('--catalog-upstream 需要一个 URL，例如 http://127.0.0.1:8787');
      process.exit(2);
    }
    try {
      CATALOG_UPSTREAM = new URL(value);
    } catch {
      console.error('--catalog-upstream 不是合法 URL：' + value);
      process.exit(2);
    }
    if (!/^https?:$/.test(CATALOG_UPSTREAM.protocol)) {
      console.error('--catalog-upstream 只接受 http/https：' + value);
      process.exit(2);
    }
    i += 1;
    continue;
  }
  if (arg.startsWith('--')) {
    console.error('未知参数：' + arg);
    process.exit(2);
  }
  if (PORT == null) PORT = Number(arg);
}
if (PORT == null || !Number.isFinite(PORT)) PORT = Number(process.env.PORT || 8091);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 只代理 `/catalog` 这一条：路径固定，query 原样透传（`?time=` / `?load=` / `?fail=` 调试用）。 */
async function proxyCatalog(request, response, url) {
  const target = new URL(CATALOG_UPSTREAM.href);
  target.pathname = '/catalog';
  target.search = url.search;

  let upstream;
  try {
    upstream = await fetch(target, { headers: { accept: 'application/json' } });
  } catch (error) {
    // 反代自己连不上时，必须和「/catalog 返回 4xx/5xx」区分开：这里是本机反代的问题。
    const body = Buffer.from(JSON.stringify({
      error: 'catalog upstream unreachable',
      proxy: CATALOG_UPSTREAM.origin,
      detail: String((error && error.message) || error),
    }, null, 2), 'utf8');
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
    response.end(body);
    console.warn('[proxy] /catalog 转发失败：' + ((error && error.message) || error));
    return;
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  const headers = {
    'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
    // 数据时刻的取法依赖上游自己的 Date；有一层层转的时候不能换成我们的时钟
    'x-pmh-catalog-proxy': CATALOG_UPSTREAM.origin,
  };
  const date = upstream.headers.get('date');
  if (date) headers.date = date;
  else response.sendDate = false;

  response.writeHead(upstream.status, headers);
  response.end(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (CATALOG_UPSTREAM && pathname === '/catalog') {
    await proxyCatalog(request, response, url);
    return;
  }

  const target = normalize(join(SITE_ROOT, pathname.endsWith('/') ? pathname + 'index.html' : pathname));
  if (!target.startsWith(SITE_ROOT)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = statSync(target);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + pathname);
    return;
  }
  if (stat.isDirectory()) {
    response.writeHead(302, { location: pathname + '/' }).end();
    return;
  }

  response.writeHead(200, {
    'content-type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
  });
  createReadStream(target).pipe(response);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`静态服务已启动：http://127.0.0.1:${PORT}/  （根目录 ${SITE_ROOT}）`);
  if (CATALOG_UPSTREAM) {
    console.log(`⚠ 本地反代已开启：/catalog → ${CATALOG_UPSTREAM.origin}/catalog （只此一条路径；仅供本地验证，不是发布配置）`);
  } else {
    console.log('   /catalog 未反代：访问会 404，源市场页将停在「待 /catalog」骨架（这是本地真实状态）');
  }
});

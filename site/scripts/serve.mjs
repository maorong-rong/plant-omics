#!/usr/bin/env node
/**
 * 极简静态服务器（仅为本地验证落地页 / 后续 Web 应用）。
 * 零依赖：只用 node:http + node:fs，避免为看一页去装一把工具。
 *
 * 用法：node site/scripts/serve.mjs [端口]     默认 8091
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8091);

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

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const target = normalize(join(SITE_ROOT, pathname));
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
});

#!/usr/bin/env node
/**
 * 本地开发服务器：把 `web/` 静态文件与 `/mcp`、`/healthz` 放在**同源**。
 *
 * 为什么要它：服务端不下发 CORS 头、还校验 Origin（`src/service/http.ts`），
 * 所以浏览器里「前端在 A 端口、服务在 B 端口」一定失败。这个脚本复刻 Nginx 的布局
 * （静态站 + /mcp 反代），让本地验证与上线后的同源条件一致。
 *
 * 用法：
 *   node web/dev-server.mjs            # 默认 8094 → 上游 http://127.0.0.1:8787
 *   $env:PLANTOMICS_UPSTREAM='http://127.0.0.1:8793'; node web/dev-server.mjs 8094
 *
 * 注意：这是**开发用**，不鉴权、不做缓存、只监听回环地址；生产走 Nginx 配置（deploy/），不要用它上线。
 */

import { createServer, request as httpRequest } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE);
const PORT = Number(process.argv[2] || process.env.PLANTOMICS_DEV_PORT || 8094);
const UPSTREAM = new URL(process.env.PLANTOMICS_UPSTREAM || 'http://127.0.0.1:8787');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

function proxy(req, res) {
  // Host 换成上游自己的 host：服务端的 Host 白名单是按「谁在监听」判断的。
  // Origin 原样透传：同源 POST 浏览器也会带，服务端要求它在白名单里（回环地址默认放行）。
  const headers = { ...req.headers, host: UPSTREAM.host };
  // 负控开关：模拟「旧版服务端不认 x-plantomics-sources」，用来验证前端会不会把全集冒充成子集。
  // 只用于测试，别在任何真实部署里开。
  if (process.env.PLANTOMICS_STRIP_SUBSET === '1') delete headers['x-plantomics-sources'];
  const upstreamReq = httpRequest(
    {
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 80,
      path: req.url,
      method: req.method,
      headers
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstreamReq.on('error', (error) => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'upstream unreachable', detail: String(error.message || error) }));
  });
  req.pipe(upstreamReq);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  if (url.pathname === '/mcp' || url.pathname === '/healthz') {
    proxy(req, res);
    return;
  }

  // 静态：只允许 web/ 下的文件，杜绝 ../ 穿越
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const target = rel === '' || rel === '.' ? join(ROOT, 'index.html') : join(ROOT, rel);
  if (!target.startsWith(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[web] http://127.0.0.1:${PORT}/  （/mcp /healthz → ${UPSTREAM.origin}）`);
  console.log('[web] 本地与线上同源布局：静态站 + 反代，浏览器调用不会踩 CORS/Origin 坑');
});

#!/usr/bin/env node
/**
 * 市场图标生成器：`icon.svg` → 位图 + 可内联的 data URL。
 *
 * 为什么要出 data URL：市场索引 `format: 1` 的 `icon` 只接受两种值——
 * ① `data:` 内联（SVG/PNG/JPEG/WebP，base64，解码后 ≤ 32 KiB）；
 * ② 可解析到 https 或索引同源的绝对/相对 URL。
 * 本仓现在**没有公开托管地址**，所以用 ①：图标不必等托管就能进索引，也不会因为
 * 「相对图标按索引 URL 解析」而在换域名时失效。
 *
 * 位图不是装饰：README、落地页、GitHub 社交预览都要 PNG，而那些地方读不了 SVG data URL。
 *
 * 用法：node market/scripts/build-icon.mjs
 * 产出：market/assets/icon-512.png、icon-256.png、icon.dataurl.txt
 * 校验：解码字节数 ≤ 32768、mime 在允许清单内、base64 正则与官方校验器一致；不符合则非零退出。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const ASSETS = join(ROOT, 'market', 'assets');
const SVG_PATH = join(ASSETS, 'icon.svg');

/** 与 `@deepseek-ai/dsh-plugin-market-index` 的 DATA_ICON / MAX_INLINE_ICON_BYTES 一致。 */
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u;
const MAX_INLINE_ICON_BYTES = 32 * 1024;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

/** 用 CDP 精确设视口截图：`--screenshot` 在 Windows 上会顶住最小窗口宽度，截出来的尺寸是错的。 */
async function renderPng(svgText, size, outPath) {
  if (!CHROME) fail('找不到 Chrome/Edge，无法渲染位图');
  // 只保留一个 width/height：SVG 根节点自带的尺寸属性要先去掉，否则重复属性里先出现的那个生效，
  // 图标会被按 512px 画进 256px 视口，截出来只剩左上角一块（实测踩过）。
  const sized = svgText.replace(/<svg\b([^>]*)>/i, (_, attrs) =>
    `<svg${attrs.replace(/\s(?:width|height)="[^"]*"/gi, '')} style="display:block;width:100%;height:100%">`,
  );
  const html = `<html><head><style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}svg{display:block}</style></head><body>${sized}</body></html>`;
  const url = `data:text/html;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
  const profile = `C:/Temp/pmh-icon-${process.pid}-${size}`;
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ]);

  let stderr = '';
  const wsUrl = await new Promise((res, rej) => {
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) res(match[1]);
    });
    setTimeout(() => rej(new Error(`浏览器启动超时（${size}px）`)), 20000);
  });

  const socket = new WebSocket(wsUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { res, rej } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? rej(new Error(message.error.message)) : res(message.result);
  });
  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', {
    width: size,
    height: size,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId);
  await send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 },
  }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await new Promise((r) => setTimeout(r, 700));
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);

  const png = Buffer.from(data, 'base64');
  writeFileSync(outPath, png);
  socket.close();
  child.kill();
  return png;
}

function assertInsideLimit(label, base64Payload) {
  const bytes = Math.floor((base64Payload.length / 4) * 3) -
    (base64Payload.endsWith('==') ? 2 : base64Payload.endsWith('=') ? 1 : 0);
  if (bytes > MAX_INLINE_ICON_BYTES) {
    fail(`${label} 解码后 ${bytes} 字节，超过内联上限 ${MAX_INLINE_ICON_BYTES} 字节`);
  }
  console.log(`  ${label}：${bytes} 字节 / 上限 ${MAX_INLINE_ICON_BYTES}`);
  return bytes;
}

async function main() {
  mkdirSync(ASSETS, { recursive: true });
  const svg = readFileSync(SVG_PATH, 'utf8');

  // 默认出 512/256 两档；也可以传尺寸自己出一档（如 node market/scripts/build-icon.mjs 32）
  const sizes = process.argv.slice(2).map(Number).filter((size) => Number.isInteger(size) && size > 0);
  const targets = sizes.length > 0 ? sizes : [512, 256];
  for (const size of targets) {
    const png = await renderPng(svg, size, join(ASSETS, `icon-${size}.png`));
    console.log(`✓ icon-${size}.png（${png.length} 字节）`);
  }

  // 索引里内联的是矢量 SVG：32px 的市场卡片到 512px 的详情页都清晰，而且字节数最小。
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  const match = DATA_ICON.exec(dataUrl);
  if (!match) fail('生成的 data URL 过不了官方 DATA_ICON 正则（mime 或 base64 不合规）');
  assertInsideLimit('icon.svg 内联', match[1]);

  writeFileSync(join(ASSETS, 'icon.dataurl.txt'), `${dataUrl}\n`, 'utf8');
  console.log(`✓ 已写 market/assets/icon.dataurl.txt（${dataUrl.length} 字符，整行即 index.json 的 icon 值）`);
  console.log('  下一步：把这一行填进 market/index.json 的 plugins[0].icon，再跑 node market/scripts/check-index.mjs');
}

main().catch((error) => fail(error?.stack ?? String(error)));

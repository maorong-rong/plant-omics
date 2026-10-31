#!/usr/bin/env node
/**
 * 截图脚本（CDP，零依赖）：精确控制视口宽度、主题与整页高度。
 *
 * 为什么不用 `chrome --screenshot`：那种方式拿不到「指定视口宽度 + 整页」两个条件同时成立，
 * 窄屏会被 Windows 的最小窗口宽度顶住，截出来是被裁的 390 宽——看起来像页面溢出，实际是工具骗人。
 * 这里用 Emulation.setDeviceMetricsOverride 真正把布局视口设成 390。
 *
 * 用法：
 *   node site/scripts/shot.mjs --url http://127.0.0.1:8091/ --out shot.png \
 *        [--width 1440] [--height 900] [--scheme light|dark] [--full] [--wait 800]
 *
 * 退出即关闭浏览器；任何一步失败非零退出（不静默出一张空白图）。
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function parseArgs(argv) {
  const out = { width: 1440, height: 900, scheme: 'light', full: false, wait: 900 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--url') { out.url = value; i += 1; }
    else if (key === '--out') { out.out = value; i += 1; }
    else if (key === '--width') { out.width = Number(value); i += 1; }
    else if (key === '--height') { out.height = Number(value); i += 1; }
    else if (key === '--scheme') { out.scheme = value; i += 1; }
    else if (key === '--wait') { out.wait = Number(value); i += 1; }
    else if (key === '--full') { out.full = true; }
  }
  if (!out.url || !out.out) {
    console.error('用法：node site/scripts/shot.mjs --url <URL> --out <PNG> [--width 1440] [--scheme light|dark] [--full]');
    process.exit(2);
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error('✗ 找不到 Chrome/Edge 可执行文件');
  process.exit(1);
}

const profileDir = `C:/Temp/plantomics-shot-${process.pid}`;
const child = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profileDir}`,
  '--remote-debugging-port=0',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let stderr = '';
const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`启动浏览器超时：${stderr.slice(-400)}`)), 20000);
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`浏览器退出（${code}）：${stderr.slice(-400)}`));
  });
});

const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
});

let nextId = 1;
const pending = new Map();
const events = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
    else resolve(message.result);
    return;
  }
  if (message.method) events.push(message);
});

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  socket.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function waitForEvent(method, sessionId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const index = events.findIndex((e) => e.method === method && (!sessionId || e.sessionId === sessionId));
      if (index >= 0) {
        const [found] = events.splice(index, 1);
        clearInterval(tick);
        resolve(found.params);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`等不到事件 ${method}`));
      }
    }, 30);
  });
}

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', {
    width: options.width,
    height: options.height,
    deviceScaleFactor: 1,
    mobile: options.width < 700,
  }, sessionId);
  await send('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'prefers-color-scheme', value: options.scheme }],
  }, sessionId);

  const loaded = waitForEvent('Page.loadEventFired', sessionId);
  await send('Page.navigate', { url: options.url }, sessionId);
  await loaded;
  await new Promise((resolve) => setTimeout(resolve, options.wait));

  const metrics = await send('Page.getLayoutMetrics', {}, sessionId);
  const content = metrics.cssContentSize || metrics.contentSize;
  const width = Math.ceil(content.width);
  const offsetY = Number(process.env.SHOT_Y || 0);
  const maxHeight = Number(process.env.SHOT_H || 0);
  let height = options.full ? Math.ceil(content.height) - offsetY : options.height;
  if (maxHeight > 0) height = Math.min(height, maxHeight);

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: options.full,
    clip: { x: 0, y: offsetY, width, height, scale: 1 },
  }, sessionId);

  writeFileSync(options.out, Buffer.from(shot.data, 'base64'));
  console.log(`✓ ${options.out}  ${width}×${height}  (布局视口 ${options.width}px, 内容高 ${Math.ceil(content.height)}px, ${options.scheme})`);
  if (width > options.width) {
    console.error(`⚠ 横向溢出：内容宽 ${width}px > 视口 ${options.width}px`);
    process.exitCode = 3;
  }
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
} finally {
  socket.close();
  child.kill();
}

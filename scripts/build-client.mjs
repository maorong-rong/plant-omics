#!/usr/bin/env node
/**
 * 把浏览器半边构建出来：`dist/client/panel.js`。
 *
 * 为什么不用 bundler：官方 `clientBundle` 构建预设没随包发布（settings-plugins README 明说
 * 仓外插件得自行复刻），而本插件的客户端代码只有一个文件、只 require 平台表里的
 * react / react-dom。手写 + 一个注入步骤，比引 esbuild 更小也更可审计。
 *
 * 本脚本承担三件「错了一定静默失败」的检查，全部非零退出：
 *   1. 模块 id 必须等于安装后的包名 —— 不一致时 web boot 只会报
 *      `bundle … loaded without registering "<id>"`，人看不出是哪个包的问题；
 *   2. package.json 必须声明 `exports["./client"]` 与 `dsh.client.platform = "web"`，
 *      否则 Node 侧根本不会去扫这个包；
 *   3. 产物必须能通过语法检查，且确实带上了注入的清单。
 *
 * 运行：`npm run build`（tsc 之后执行，因为清单来自 dist 里的注册表）。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog } from '../dist/client/catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => {
  process.stderr.write(`[build-client] ❌ ${message}\n`);
  process.exit(1);
};

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

// ① id 与包名硬绑：DSH 用 Loader 条目的包名当客户端模块 id。
if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
  fail('package.json 缺少 name，无法确定客户端模块 id');
}

// ② 两份声明缺一不可，Node 侧才认这是个带浏览器半边的 web 插件。
const clientExport = pkg.exports?.['./client'];
const expectedExport = './dist/client/panel.js';
if (clientExport !== expectedExport) {
  fail(`package.json exports["./client"] 必须是 "${expectedExport}"，实际是 ${JSON.stringify(clientExport)}`);
}
if (pkg.dsh?.client?.platform !== 'web') {
  fail('package.json 缺少 dsh.client.platform = "web"（没有它，Node 侧不会提供客户端 bundle）');
}

const catalog = buildCatalog();
if (catalog.sources.length === 0) fail('清单里没有任何源，拒绝产出空面板');
if (catalog.tools.length === 0) fail('清单里没有任何工具，拒绝产出空面板');

const sourcePath = path.join(root, 'src', 'client', 'bundle.js');
const source = readFileSync(sourcePath, 'utf8');

// 注入点必须还在：bundle 的清单完全来自这一行，改名会让面板永远显示空表。
if (!source.includes('__PLANT_OMICS_CLIENT__')) {
  fail('bundle.js 里找不到 __PLANT_OMICS_CLIENT__ 注入点，清单注入会静默失效');
}
// 浏览器里没有模块系统：顶层 import/export 会直接语法错误。
if (/^\s*(?:import|export)\s/m.test(source)) {
  fail('bundle.js 里出现了顶层 import/export；客户端 bundle 必须是 classic script + lazy-CJS factory');
}

const builtAt = new Date().toISOString();
const boot = {
  moduleId: pkg.name,
  packageVersion: pkg.version,
  builtAt,
  catalog,
};
const output = `globalThis.__PLANT_OMICS_CLIENT__ = ${JSON.stringify(boot)};\n${source}`;

// ③ 语法检查：编译一次但不执行，能在装机前抓到拼错的客户端代码。
try {
  // eslint-disable-next-line no-new, no-new-func
  new Function(output);
} catch (error) {
  fail(`产物语法错误：${error instanceof Error ? error.message : String(error)}`);
}

const outDir = path.join(root, 'dist', 'client');
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'panel.js');
writeFileSync(outPath, output, 'utf8');

const written = readFileSync(outPath, 'utf8');
if (!written.includes(`"moduleId":${JSON.stringify(pkg.name)}`)) {
  fail('产物里没有找到注入的 moduleId，注入步骤没生效');
}

const bytes = Buffer.byteLength(written, 'utf8');
const sha256 = createHash('sha256').update(written).digest('hex').slice(0, 16);
process.stdout.write(
  `[build-client] ✅ ${path.relative(root, outPath)} · 源 ${catalog.sources.length} · 工具 ${catalog.tools.length}`
    + ` · ${bytes} B · sha256:${sha256} · id=${pkg.name}\n`,
);

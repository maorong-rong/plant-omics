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

import { execFileSync } from 'node:child_process';
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

/**
 * 可复现构建：产物里**不许出现墙钟时间**（2026-10-28 改）。
 *
 * 原先写 `new Date().toISOString()`，导致同一提交每次构建字节都不同：
 * dist 无法与已发布包字节比对，所谓"可复现构建"就无从谈起，diff 里全是噪音。
 *
 * 现在按优先级取确定的来源：
 *   1. `SOURCE_DATE_EPOCH`（Reproducible Builds 约定，单位秒）；
 *   2. git HEAD 的提交时间（同一提交恒相同）；
 *   3. git 不可用 → 版本号 + 短 sha（`v0.6.0@1e3c3cf`），仍可复现；
 *   4. 都没有 → 'unknown'（不编造时间）。
 * 同时记录 `sourceRev`（短 sha，工作区有未提交的已跟踪改动时加 `-dirty`），
 * 让"这份产物来自哪个源码状态"可追溯，而不是靠时间戳猜。
 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function deterministicStamp() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined && epoch !== '') {
    const seconds = Number(epoch);
    if (!Number.isFinite(seconds) || seconds < 0) {
      fail(`SOURCE_DATE_EPOCH 不是合法的非负秒数：${JSON.stringify(epoch)}`);
    }
    return { value: new Date(seconds * 1000).toISOString(), source: 'source-date-epoch' };
  }
  const commitDate = git(['show', '-s', '--format=%cI', 'HEAD']);
  if (commitDate) return { value: commitDate, source: 'git-commit' };
  // git 不可用（无仓库/无提交）时的退化：版本号 + 短 sha，仍可复现；再没有就写未知。
  const rev = git(['rev-parse', '--short', 'HEAD']);
  if (rev) return { value: `v${pkg.version}@${rev}`, source: 'git-rev' };
  return { value: 'unknown', source: 'unknown' };
}

function sourceRevision() {
  const sha = git(['rev-parse', '--short', 'HEAD']);
  if (!sha) return 'unknown';
  /**
   * dirty 判定要包含"新增未跟踪的源码文件"：否则干净树里新加一个 `src/sources/x/`，
   * `sourceRev` 仍显示干净，产物与实际源码不符（审查 P2）。
   * 只计入源码相关路径，避免临时产物/日志把标识弄脏。
   */
  const watched = [
    'src',
    'test',
    'scripts',
    'package.json',
    'package-lock.json',
    // 构建配置也影响产物：tsconfig 改了 tsc 输出会变，cordis.patch.yml 随包分发。
    // 用 glob 魔术，避免将来新增 tsconfig.*.json 又漏掉。
    ':(glob)tsconfig*.json',
    'cordis.patch.yml',
  ];
  const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', ...watched]) !== '';
  return dirty ? `${sha}-dirty` : sha;
}

const stamp = deterministicStamp();
const builtAt = stamp.value;
const sourceRev = sourceRevision();
const boot = {
  moduleId: pkg.name,
  packageVersion: pkg.version,
  builtAt,
  builtAtSource: stamp.source,
  sourceRev,
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

/**
 * 服务端构建标识：写进 dist 供运行时读取，用来拼 `+svc.N.g<sha>`。
 *
 * 为什么不运行时调 git：装到 profile 里的包不是 git 仓库，`git rev-parse` 会失败；
 * 构建期算一次写进产物，运行时只读文件，失败也不致命（退化成没有 sha）。
 */
const serviceDir = path.join(root, 'dist', 'service');
mkdirSync(serviceDir, { recursive: true });
writeFileSync(
  path.join(serviceDir, 'build-info.json'),
  JSON.stringify({ sourceRev, builtAt, packageVersion: pkg.version }, null, 2) + '\n',
  'utf8',
);

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

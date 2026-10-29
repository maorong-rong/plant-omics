#!/usr/bin/env node
/**
 * 一键安装植物组学 DSH 插件。
 *
 * 为什么需要它（2026-10-28 立）：
 *   desktop profile 被 Electron 独占管理，`dsh plugin --profile desktop add` 一定失败：
 *     error: profile "desktop" is managed exclusively by the Electron application
 *   每次手工装都要重复一串易错动作：验包 → 拷到 plugin-archives → 黏路径进插件页 → 重启 → 验证。
 *   其中两个坑踩过：
 *     ① tgz 留在 Temp 里。profile 的 package.json 记的是**绝对路径**，Temp 被清理后
 *        下次 pnpm install 会解析失败。必须搬到 ~/.dsh/plugin-archives/ 再装。
 *     ② 装完不重启，版本号变了但内存里还是旧的（0.3.0 装完侧边栏没入口就是这个原因）。
 *
 * 这个脚本能做什么、不能做什么（**别把它当全自动**）：
 *   能：验包（名字/版本/必需文件/哈希）→ 归档到 plugin-archives → 预检环境 → 校验已装结果。
 *   不能：**替你点击**「添加插件」。那一步在桌面端进程里，没有 CLI 入口。
 *         脚本会打印可直接黏贴的路径并写入剪贴板，但最后一下是你点。
 *
 * 用法：
 *   node scripts/install-dsh.mjs                          # 用 git 里的版本号找 plugin-archives 里的包
 *   node scripts/install-dsh.mjs <tgz 路径>                # 指定包
 *   node scripts/install-dsh.mjs <tgz> --dry-run           # 只验包与预检，什么都不改
 *   node scripts/install-dsh.mjs <tgz> --no-clipboard      # 不写剪贴板
 *
 * 退出码：
 *   0 = 验包与预检通过（并把包放到了正确位置）
 *   1 = 包不合规 / 环境不对
 *   2 = 参数用法错误
 *
 * 注意：本脚本**不修改** profile 的 package.json，也不跑 pnpm。
 * 真正落盘由桌面端的插件管理器执行——绕过它属于 README 明确不推荐的做法。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PKG_NAME = 'plantomics-hub';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positionals = argv.filter((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const noClipboard = flags.has('--no-clipboard');

const fail = (msg) => {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(1);
};
const step = (n, msg) => process.stdout.write(`\n[${n}] ${msg}\n`);
const ok = (msg) => process.stdout.write(`    ✅ ${msg}\n`);
const warn = (msg) => process.stdout.write(`    ⚠️  ${msg}\n`);
const info = (msg) => process.stdout.write(`    ·  ${msg}\n`);

// ── 定位包 ────────────────────────────────────────────────────────────────
const repoVersion = (() => {
  try {
    return JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
})();

const archivesDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-archives');

/** 没给路径就按仓库版本找归档目录里的包。 */
function locateTgz() {
  if (positionals.length > 0) {
    const p = resolve(positionals[0]);
    if (!existsSync(p)) fail(`找不到指定的包：${p}`);
    return p;
  }
  if (!repoVersion) fail('读不到本仓 package.json 的 version，无法推断包名；请显式给出 tgz 路径。');
  const guess = join(archivesDir, `${PKG_NAME}-${repoVersion}.tgz`);
  if (!existsSync(guess)) {
    fail(
      `归档目录里没有 ${PKG_NAME}-${repoVersion}.tgz。\n`
        + `   期望位置：${guess}\n`
        + '   先打包：npm run build && npm pack --pack-destination "%USERPROFILE%\\.dsh\\plugin-archives"\n'
        + '   或直接给出 tgz 路径：node scripts/install-dsh.mjs <tgz>',
    );
  }
  return guess;
}

const tgz = locateTgz();

process.stdout.write('植物组学插件 · 一键安装\n');
process.stdout.write('='.repeat(60) + '\n');
info(`包：${tgz}`);

// ── [1] 校验包 ────────────────────────────────────────────────────────────
step(1, '校验包');

const size = statSync(tgz).size;
const sha256 = createHash('sha256').update(readFileSync(tgz)).digest('hex');
info(`大小 ${(size / 1024).toFixed(1)} KB`);
info(`sha256 ${sha256}`);

/** 用 tar 取包内清单，不落盘解压。 */
let entries;
try {
  entries = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
} catch (error) {
  fail(`不是可读的 tgz（tar 解不开）：${error.message}`);
}
info(`包内 ${entries.length} 个条目`);

// 必需文件：少了任何一个，DSH 侧的表现都是「装了但没反应」，属静默失效，直接拦。
const REQUIRED = [
  'package/package.json',
  'package/dist/dsh/index.js',
  'package/cordis.patch.yml',
];
const missing = REQUIRED.filter((r) => !entries.includes(r));
if (missing.length > 0) fail(`包内缺必需文件：\n     ${missing.join('\n     ')}`);
ok('必需文件齐全（package.json / dist/dsh/index.js / cordis.patch.yml）');

/** 读出包内 package.json，核对名字、版本、出口声明。 */
let pkg;
try {
  pkg = JSON.parse(
    execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }),
  );
} catch (error) {
  fail(`读不出包内 package.json：${error.message}`);
}

if (pkg.name !== PKG_NAME) {
  fail(`包名不符：期望 ${PKG_NAME}，实际 ${pkg.name}。\n   装错包会变成「多了一个陌生插件」，不是升级。`);
}
ok(`包名 ${pkg.name}`);

if (!pkg.version) fail('包内没有 version 字段。');
ok(`版本 ${pkg.version}`);

if (repoVersion && pkg.version !== repoVersion) {
  warn(`包版本 ${pkg.version} ≠ 仓库 package.json 版本 ${repoVersion}`);
  warn('若刚改过源码未重新打包，装下去的就不是你以为的那份。');
}

if (pkg.main !== './dist/dsh/index.js') {
  fail(`main 字段异常：${pkg.main}（期望 ./dist/dsh/index.js）。DSH 按它加载插件入口。`);
}
ok(`main ${pkg.main}`);

// cordis.patch.yml 里的 name 必须等于包名，否则 dsh 对 unknown name 静默跳过。
const patchText = execFileSync('tar', ['-xzOf', tgz, 'package/cordis.patch.yml'], { encoding: 'utf8' });
const patchName = patchText.match(/^\s*name:\s*(\S+)\s*$/m)?.[1];
if (!patchName) fail('cordis.patch.yml 里找不到 name 字段。');
if (patchName !== pkg.name) {
  fail(
    `cordis.patch.yml 的 name（${patchName}）≠ 包名（${pkg.name}）。\n`
      + '   这个不一致的表现是「插件已装、工具不出现」，dsh 不会报错。',
  );
}
ok(`cordis.patch.yml name 与包名一致（${patchName}）`);

// 客户端半边：0.3.0 起有。缺了不会报错，只是侧边栏没入口。
const hasClient = entries.includes('package/dist/client/panel.js');
const clientDeclared = pkg.dsh?.client?.platform;
if (hasClient && clientDeclared !== 'web') {
  warn(`包内有 dist/client/panel.js，但 dsh.client.platform = ${clientDeclared ?? '(未声明)'}`);
} else if (hasClient) {
  ok(`客户端半边存在，platform=${clientDeclared}`);
} else if (clientDeclared) {
  warn(`声明了 dsh.client.platform=${clientDeclared} 但包里没有 dist/client/panel.js`);
} else {
  info('本包不含客户端半边（0.3.0 之前的行为）');
}

// ── [2] 归档 ──────────────────────────────────────────────────────────────
step(2, dryRun ? '归档（dry-run，跳过）' : '归档到 plugin-archives');

const targetName = `${pkg.name}-${pkg.version}.tgz`;
const targetPath = join(archivesDir, targetName);

if (dryRun) {
  if (existsSync(targetPath)) {
    const existingHash = createHash('sha256').update(readFileSync(targetPath)).digest('hex');
    if (existingHash !== sha256) {
      warn(`归档里已有同名包但内容不同（${targetName}）；实际运行会被拒绝覆盖`);
    } else {
      info('归档里已有同内容同名包，实际运行会跳过复制');
    }
  }
  info(`将会复制到 ${targetPath}`);
} else {
  mkdirSync(archivesDir, { recursive: true });
  if (resolve(tgz) === resolve(targetPath)) {
    ok('包已经在归档目录里，无需复制');
  } else if (existsSync(targetPath)) {
    /**
     * 同版本不同内容 ⇒ 必须拒绝覆盖（2026-10-28 加固）。
     *
     * 归档目录是回滚依据：profile 的 package.json 记的是绝对路径，旧包被同名新包顶掉后，
     * 「回滚到上一版」就变成了「重装一个外观相同、内容不同的包」，且失败时无法察觉。
     * 所以这里不做「静默使用新的」也不做「静默保留旧的」，而是停下来让人做决定。
     * 不提供 --force：覆盖回滚依据应当是显式的人工动作，不是命令行开关。
     */
    const existingHash = createHash('sha256').update(readFileSync(targetPath)).digest('hex');
    if (existingHash !== sha256) {
      fail(
        `同名包已存在但内容不同，拒绝覆盖：\n`
          + `     已有：${targetPath}\n`
          + `     已有 sha256：${existingHash}\n`
          + `     本次 sha256：${sha256}\n`
          + '     归档目录是回滚依据，覆盖会让「回滚到旧版」变成装回一个内容不同的包。\n'
          + '     处理办法（二选一）：\n'
          + '       · 升版本号重新打包（推荐，让新旧包同时存在）；\n'
          + '       · 如果确认旧包不要了，先手工把它移出 plugin-archives，再重跑本脚本。',
      );
    }
    ok(`归档里已有同内容包（sha256 一致），跳过复制：${targetPath}`);
  } else {
    copyFileSync(tgz, targetPath);
    // 复制后必须校验，否则「搬了但搬坏了」会一直查不出来。
    const copiedHash = createHash('sha256').update(readFileSync(targetPath)).digest('hex');
    if (copiedHash !== sha256) fail(`复制后哈希不一致，归档失败：${targetPath}`);
    ok(`已复制并校验：${targetPath}`);
  }
  if (resolve(tgz) !== resolve(targetPath)) {
    info('原包留在原处不动（Temp 里的那份会在系统清理时消失，以归档为准）');
  }
}

// ── [3] 预检环境 ──────────────────────────────────────────────────────────
step(3, '预检环境');

const profileDir = process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE ?? 'desktop');
const profilePkg = join(profileDir, 'package.json');

if (!existsSync(profilePkg)) {
  fail(`找不到 profile 的 package.json：${profilePkg}\n   需在 DSH 运行时执行本脚本，或先设 DSH_PROFILE_DIR。`);
}
ok(`profile：${profileDir}`);

const installedDir = join(profileDir, 'node_modules', PKG_NAME);
let installedVersion;
if (existsSync(join(installedDir, 'package.json'))) {
  try {
    installedVersion = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')).version;
  } catch { /* ignore */ }
}

if (installedVersion) {
  info(`当前已装：${installedVersion}`);
  if (installedVersion === pkg.version) {
    warn(`已经是 ${pkg.version}，重装同版本没有意义（除非上次装坏了）。`);
  } else {
    info(`将升级：${installedVersion} → ${pkg.version}`);
  }
} else {
  info('当前未安装本插件（首次安装）');
}

// 检查 profile 是否已把本插件选进 bundles —— 进了 dependencies 但没进 bundles 不会加载。
try {
  const profileJson = JSON.parse(readFileSync(profilePkg, 'utf8'));
  const bundles = profileJson.dsh?.profile?.bundles ?? [];
  if (bundles.includes(PKG_NAME)) ok('已在 profile 的 dsh.profile.bundles 里');
  else warn('尚未在 profile 的 dsh.profile.bundles 里（装完才会写入；若装完仍不在，插件不会加载）');
} catch (error) {
  warn(`读 profile package.json 失败：${error.message}`);
}

// ── [4] 给人看的手动步骤 ──────────────────────────────────────────────────
step(4, '接下来这一步必须由你点（桌面端没有 CLI 入口）');

process.stdout.write(
  '\n'
  + '  为什么不能全自动：desktop profile 由 Electron 独占管理。\n'
  + '  实测 `dsh plugin --profile desktop add …` 会直接报：\n'
  + '      error: profile "desktop" is managed exclusively by the Electron application\n'
  + '  绕过它去手改 package.json + 跑 pnpm 是 README 明确不推荐的做法（出问题难查）。\n'
  + '\n'
  + '  你要做的：\n'
  + '    1. 打开 DSH 侧边栏 →「插件」→ 右上「添加插件」\n'
  + '    2. 粘贴下面这个完整路径（没有文件选择器，只能黏）：\n'
  + '\n'
  + `         ${targetPath}\n`
  + '\n'
  + '    3. 装完按提示重启 DSH（托盘退出再打开），**不是**只关窗口\n'
  + '    4. 重启后新开一个会话再验证——已开着的会话不会重排工具清单\n',
);

if (!noClipboard && !dryRun) {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Set-Clipboard -Value "${targetPath}"`], { stdio: 'ignore' });
    ok('路径已写入剪贴板，可以直接 Ctrl+V');
  } catch {
    info('（剪贴板写入失败，请手动复制上面的路径）');
  }
}

// ── [5] 装完怎么验 ────────────────────────────────────────────────────────
step(5, '装完之后怎么验（三条都要看）');

process.stdout.write(
  '\n'
  + '  a) 版本对上了吗\n'
  + `       node -e "console.log(require('${installedDir.replace(/\\/g, '/')}/package.json').version)"\n`
  + '\n'
  + '  b) 装下去的和仓库构建一致吗\n'
  + '       npm run doctor\n'
  + '       （实质一致才算；只差注释会明确说「不影响行为」）\n'
  + '\n'
  + '  c) 工具和侧边栏入口真的出现吗\n'
  + '       · 工具：在新会话里问一句需要查库的话，看模型能否选中 wheatomics_* / strawberry_* 等工具\n'
  + '       · 入口：侧边栏底部（设置按钮旁）应多出「组学」入口\n'
  + '       装完版本号变了但入口没出现 = 没重启，或客户端半边没随包分发。\n'
  + '\n'
  + `${dryRun ? '（dry-run：以上路径尚未生成，实际使用时才是真路径）' : ''}\n`,
);

process.stdout.write('='.repeat(60) + '\n');
process.stdout.write(dryRun ? '✅ 验包与预检通过（未做任何改动）\n' : '✅ 包已就位，等待你在插件页点装\n');

#!/usr/bin/env node
/**
 * 装机快照自检：已装插件 vs 仓库构建 的逐文件差异。
 *
 * 为什么要有这个脚本（2026-10-28 立的规矩）：
 *   DSH 的 profile 是 pnpm 托管的安装，插件是 **tgz 解包后的物理拷贝**，不是软链。
 *   于是同一份代码同时存在两处：仓库 dist/（我改的）和已装目录（会话里真跑的）。
 *   两者一分叉，最危险的动作就是「改完代码 → 用工具调用验证 → 以为验过了」——
 *   实际验的是旧拷贝。这属于 §五 说的静默失效。
 *
 *   软链曾被视为解法，但在 desktop profile 上不成立：
 *   ① 软链＝热更新，与本项目「攒一批再装」的做法相反；
 *   ② pnpm 下次 install 会按 lockfile 对账，手工放的软链会被静默还原成拷贝。
 *   所以改为「不改变安装方式，但让差异变成随时可见的事实」。
 *
 * 为什么区分「注释差异」与「实质差异」（2026-10-28 首次实跑后补）：
 *   首跑时报出 3 个文件漂移，逐一剥掉注释后发现**实质代码完全相同**，
 *   只是另一个会话改了注释文字并重新构建。如果这种情形算失败，
 *   那每次整理注释都会亮红灯——而红灯一旦泛滥就会被 --skip，等于没有检查。
 *   所以：.js 文件先剥注释再哈希，只有实质变化才算漂移。
 *
 * 用法：
 *   npm run build && npm run doctor          # 有实质漂移 → 退出码 1
 *   node scripts/doctor.mjs --allow-drift    # 明知未重装，只看报告 → 退出码 0
 *   node scripts/doctor.mjs --json
 *   node scripts/doctor.mjs --installed <目录>   # 指定别的已装副本
 *
 * 退出码：
 *   0 = 实质一致（注释差异不算），或 --allow-drift
 *   1 = 有实质漂移 / 找不到已装副本 / 未构建
 *
 * 刻意**不进** `npm run check`：开发期未重装是常态，把常态做成红灯
 * 等于逼人 --skip（§四 的原话）。它是排障与验收用的显式命令。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const REPO_DIST = join(REPO, 'dist');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const allowDrift = argv.includes('--allow-drift');
const installedFlag = argv.indexOf('--installed');
const installedOverride = installedFlag >= 0 ? argv[installedFlag + 1] : undefined;

/** `--installed` 必须带值。缺值时静默回退到默认目录 = 看着 A 却报了 B，属于静默失效。 */
if (installedFlag >= 0 && (!installedOverride || installedOverride.startsWith('--'))) {
  process.stderr.write('❌ --installed 后面必须跟目录路径，例如：\n   node scripts/doctor.mjs --installed "C:\\path\\to\\dsh-plugin-plant-omics"\n');
  process.exit(2);
}

/** 已装副本的默认位置：跟着 DSH 当前 profile 走，不写死用户名。 */
function defaultInstalledDirs() {
  const home = process.env.DSH_HOME;
  const profileDir = process.env.DSH_PROFILE_DIR;
  const profile = process.env.DSH_PROFILE;
  const out = [];
  if (profileDir) out.push(join(profileDir, 'node_modules', 'dsh-plugin-plant-omics'));
  if (home && profile) out.push(join(home, 'profiles', profile, 'node_modules', 'dsh-plugin-plant-omics'));
  if (home) out.push(join(home, 'profiles', 'desktop', 'node_modules', 'dsh-plugin-plant-omics'));
  return [...new Set(out)];
}

function findInstalled() {
  if (installedOverride) return resolve(installedOverride);
  for (const dir of defaultInstalledDirs()) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return undefined;
}

/** 递归列出目录下所有文件（相对路径，正斜杠统一），跳过 node_modules。 */
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(root, full).split('\\').join('/'));
    }
  };
  walk(root);
  return out.sort();
}

const hashFile = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * 剥掉注释与多余空白后取哈希，用于判断「实质代码」是否相同。
 * 字符串字面量先占位，避免把里面的 // 或 /* 当注释删掉。
 */
function semanticHash(file) {
  let src = readFileSync(file, 'utf8');
  const strings = [];
  src = src.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => {
    strings.push(m);
    return `\u0000S${strings.length - 1}\u0000`;
  });
  src = src.replace(/\/\*[\s\S]*?\*\//g, '');
  src = src.replace(/(^|[^:])\/\/.*$/gm, '$1');
  src = src.replace(/\u0000S(\d+)\u0000/g, (_, i) => strings[Number(i)]);
  /**
   * 构建时间戳不代表行为差异（2026-10-28 二次修正）。
   *
   * 客户端 bundle 的 `builtAt` 每次 `npm run build` 都会变。若把它算进实质差异，
   * 那么「改个 README 顺手跑了一次 check」也会让 doctor 亮红灯——纯噪音。
   * 但**只抹掉这一个字段**，不连带抹掉 packageVersion（版本变了必须看得出来）。
   */
  src = src.replace(/("builtAt"\s*:\s*)"[^"]*"/g, '$1"<BUILD_TS>"');
  src = src.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(src).digest('hex');
}

/** 运行时产物 vs 类型/调试产物：只有前者影响会话里的实际行为。 */
function kindOf(rel) {
  if (rel.endsWith('.js')) return 'runtime';
  if (rel.endsWith('.d.ts') || rel.endsWith('.map')) return 'meta';
  return 'other';
}

function readVersion(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? '(未知)';
  } catch {
    return '(读不到)';
  }
}

function newestMtime(root) {
  let newest = 0;
  for (const rel of listFiles(root)) {
    const t = statSync(join(root, rel)).mtimeMs;
    if (t > newest) newest = t;
  }
  return newest;
}

function fmtTime(ms) {
  if (!ms) return '(无)';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function bail(message) {
  process.stderr.write(`❌ ${message}\n`);
  process.exitCode = 1;
}

const installed = findInstalled();

if (!existsSync(REPO_DIST)) {
  bail(`仓库还没构建：找不到 ${REPO_DIST}\n   先跑 npm run build，否则无从比对。`);
} else if (!installed || !existsSync(join(installed, 'dist'))) {
  const tried = installedOverride ? [resolve(installedOverride)] : defaultInstalledDirs();
  bail(
    `找不到已装插件的 dist。\n   试过这些位置：\n${tried.map((p) => `     - ${p}`).join('\n')}\n`
      + '   如果插件确实没装，这是正常状态；若以为装了，用 --installed <目录> 指定。',
  );
} else {
  const installedDist = join(installed, 'dist');
  const repoFiles = listFiles(REPO_DIST);
  const instFiles = listFiles(installedDist);
  const repoSet = new Set(repoFiles);
  const instSet = new Set(instFiles);

  const onlyRepo = repoFiles.filter((f) => !instSet.has(f));
  const onlyInst = instFiles.filter((f) => !repoSet.has(f));

  /**
   * 内容不同 → 再分「非实质差异」与「实质不同」。
   * 非实质 = 只差注释、只差构建时间戳、或只差 sourcemap（sourcemap 跟着注释走）。
   */
  const changedRaw = repoFiles.filter(
    (f) => instSet.has(f) && hashFile(join(REPO_DIST, f)) !== hashFile(join(installedDist, f)),
  );
  const benign = [];
  const substantive = [];
  for (const f of changedRaw) {
    const a = join(REPO_DIST, f);
    const b = join(installedDist, f);
    if (f.endsWith('.map')) benign.push(f);
    else if (semanticHash(a) === semanticHash(b)) benign.push(f);
    else substantive.push(f);
  }

  // 只在一侧存在的文件：运行时文件一律算实质差异（少了/多了都影响加载）
  const driftRuntime = [...substantive, ...onlyRepo, ...onlyInst].filter((f) => kindOf(f) === 'runtime');
  const drift = substantive.length + onlyRepo.length + onlyInst.length > 0;

  const report = {
    repo: { dir: REPO_DIST, files: repoFiles.length, version: readVersion(REPO), newest: newestMtime(REPO_DIST) },
    installed: {
      dir: installed,
      files: instFiles.length,
      version: readVersion(installed),
      newest: newestMtime(installedDist),
    },
    drift,
    /** 只有实质差异才会让「会话里调到的行为」和你的代码不一致 */
    runtimeAffected: driftRuntime.length > 0,
    summary: {
      substantive: substantive.length,
      benign: benign.length,
      onlyRepo: onlyRepo.length,
      onlyInst: onlyInst.length,
    },
    substantive,
    benign,
    onlyRepo,
    onlyInst,
    driftRuntime,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = [
      '植物组学插件 · 装机快照自检',
      '='.repeat(60),
      `仓库构建   ${REPO_DIST}`,
      `           ${repoFiles.length} 个文件，最新 ${fmtTime(report.repo.newest)}，版本 ${report.repo.version}`,
      `已装快照   ${installed}`,
      `           ${instFiles.length} 个文件，最新 ${fmtTime(report.installed.newest)}，版本 ${report.installed.version}`,
      '',
    ];

    if (!drift) {
      if (benign.length > 0) {
        lines.push('结论：✅ 实质一致（有非实质差异，不影响行为）。');
        lines.push(`      ${benign.length} 个文件内容不同，但去掉注释与构建时间戳后完全相同：`);
        for (const f of benign.slice(0, 10)) lines.push(`         - ${f}`);
        if (benign.length > 10) lines.push(`         … 另有 ${benign.length - 10} 个`);
        lines.push('      会话里调到的工具，跑的就是你当前的逻辑。');
      } else {
        lines.push('结论：✅ 完全一致。');
        lines.push('      会话里调到的工具，跑的就是当前仓库构建的代码。');
      }
    } else {
      lines.push('结论：⚠️ 有实质漂移 —— 会话里调到的工具，跑的不是你当前的代码。');
      lines.push(
        `      实质改动 ${substantive.length} / 仅仓库有 ${onlyRepo.length} / 仅已装有 ${onlyInst.length}`
          + (benign.length ? ` / 非实质差异 ${benign.length}` : ''),
      );
      if (report.runtimeAffected) {
        lines.push('      其中**运行时产物**（.js）有实质差异 —— 这是行为不一致的真正原因。');
      } else {
        lines.push('      运行时产物未见实质差异，差异集中在类型/调试产物。');
      }
      const section = (title, list) => {
        if (!list.length) return;
        lines.push('', title);
        for (const f of list.slice(0, 40)) lines.push(`   - ${f}`);
        if (list.length > 40) lines.push(`   … 另有 ${list.length - 40} 个`);
      };
      section('实质内容不同的文件：', substantive);
      section('只在仓库构建里（已装副本缺）：', onlyRepo);
      section('只在已装副本里（仓库已删）：', onlyInst);
      section('非实质差异（注释/构建时间戳/sourcemap）：', benign);
      lines.push('');
      lines.push('怎么读这份报告：');
      lines.push('  · 想验「我刚改的代码」→ 别用会话里的工具调用，用 npm test / npm run probe。');
      lines.push('  · 想让会话里也生效 → npm pack 后在插件页重装（攒一批再做，见工作方式约定）。');
    }

    process.stdout.write(`${lines.join('\n')}\n`);
  }

  if (drift && !allowDrift) process.exitCode = 1;
}

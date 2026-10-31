#!/usr/bin/env node
/**
 * 市场双闸的单一入口：**数字闸**（发布包口径）+ **措辞闸**（索引文案 vs `copy.json`）。
 *
 * 为什么不写成 `node scripts/counts.mjs --published && node market/scripts/check-index.mjs`：
 * 那样任一道红都只给一个 exit 1，跑的人不知道**该去改数字还是改措辞**——两件完全不同的事，
 * 改错方向会把已经对的半边弄坏。这里两道**都跑**（第一道红也继续第二道），逐道报红，
 * 并给出方向。
 *
 * 两道闸的判定范围（实测过，不是按说明写的）：
 *
 * | 变异 | 数字闸 | 措辞闸 |
 * |---|---|---|
 * | 描述里 `34 个` → `35 个` | ❌ 红 | ❌ 红 |
 * | 描述里「薄插件」→「插件」（数字没动） | ✅ 绿 | ❌ 红 |
 *
 * 所以「数字闸绿」不等于市场描述被锁住，必须两道同绿。
 *
 * 联网：数字闸要下载 npm 最新 tarball 并核 sha512；因此本命令**刻意不进** `npm run check`。
 * 什么时候跑：发布前、改 `market/` 描述或 `copy.json` 后、以及装完新包之后。
 *
 * 用法：`npm run check:market`（等价 `node scripts/check-market.mjs`）
 * 退出码：任一道红 → 1。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkPublishedScope, collectPublishedCounts } from './counts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * 两道闸
 * ------------------------------------------------------------------ */

/** 数字闸：market 描述里的数量短语必须等于 npm 最新 tarball 的真实数量。 */
export async function runNumberGate() {
  let published;
  let market;
  try {
    published = await collectPublishedCounts();
    market = JSON.parse(readFileSync(path.join(ROOT, 'market', 'index.json'), 'utf8'));
  } catch (error) {
    // 取不到 ≠ 数字不一致：网络/registry 问题不能报成「描述写错了」，否则人会去改本来没错的数字。
    return { ok: false, kind: 'fetch-error', problems: [error.message], counts: null };
  }
  const problems = checkPublishedScope({ counts: published.counts, market });
  return {
    ok: problems.length === 0,
    kind: problems.length === 0 ? 'ok' : 'mismatch',
    problems,
    counts: published.counts,
    latest: published.latest,
    tarball: published.tarball,
    integrity: published.integrityVerified,
  };
}

/** 措辞闸：索引文案逐字等于 `market/copy.json`，外加官方校验器、版本、图标。 */
export function runWordingGate() {
  const script = path.join(ROOT, 'market', 'scripts', 'check-index.mjs');
  try {
    const output = execFileSync(process.execPath, [script], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: String(output) };
  } catch (error) {
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout ?? '') : '';
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '';
    return { ok: false, output: `${stdout}${stderr}` };
  }
}

/* ------------------------------------------------------------------ *
 * 汇报
 * ------------------------------------------------------------------ */

const indent = (text) =>
  text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => `    ${line}`)
    .join('\n');

/** 两道闸的结果 → 给人看的报告行。纯函数，测试直接喂假结果。 */
export function renderReport({ number, wording }) {
  const lines = ['市场双闸（联网：数字读 npm 最新 tarball；措辞读 market/copy.json）', ''];

  lines.push('[1/2] 数字闸 —— 发布包口径（市场描述的数量短语 vs tarball 真实数量）');
  if (number.ok) {
    const counts = number.counts;
    lines.push(
      `  ✅ 通过：latest ${number.latest}，${counts.sources} 源 / ${counts.tools} 工具`
        + `（源工具 ${counts.sourceTools} + 元工具 ${counts.metaTools}）`,
    );
    lines.push(`     tarball ${number.tarball}`);
    lines.push(`     完整性 ${number.integrity}`);
  } else if (number.kind === 'fetch-error') {
    lines.push('  ❌ 红：取不到发布口径（联网失败 / registry 不可达 / tarball 校验失败）');
    if (number.problems.length > 0) lines.push(indent(number.problems.map((p) => `- ${p}`).join('\n')));
    lines.push('     → 先解决取数：换网络或 registry 后重跑本命令。**这不是「描述写错了」**，');
    lines.push('       别在这种红下去改市场描述里的数字。');
  } else {
    lines.push('  ❌ 红：市场描述里的数字与发布包对不上');
    if (number.problems.length > 0) lines.push(indent(number.problems.map((p) => `- ${p}`).join('\n')));
    lines.push('     → 方向是**数字**：先确认 market/copy.json 是否过期（node market/scripts/build-copy.mjs →');
    lines.push('       node market/scripts/apply-copy.mjs），再改描述里的数量短语；不要为了过闸改发布包。');
  }
  lines.push('');

  lines.push('[2/2] 措辞闸 —— 索引文案 vs copy.json（官方校验器 / 文案 / 版本 / 图标）');
  if (wording.ok) {
    lines.push('  ✅ 通过：索引文案与生成结果逐字一致，图标同步');
  } else {
    lines.push('  ❌ 红：索引里的字与 copy.json 不一致（数量可能是对的）');
    if (wording.output.trim() !== '') lines.push(indent(wording.output));
    lines.push('     → 方向是**措辞**：node market/scripts/build-copy.mjs 后 node market/scripts/apply-copy.mjs，');
    lines.push('       再跑本命令；不要手改 market/index.json 的字。');
  }
  lines.push('');

  if (number.ok && wording.ok) {
    lines.push('✅ 市场双闸通过：数量对得上发布包，措辞对得上生成结果。');
  } else {
    const red = [];
    if (!number.ok) red.push('数字闸');
    if (!wording.ok) red.push('措辞闸');
    lines.push(`❌ 市场双闸未通过：${red.join(' + ')}红。`);
    if (number.ok && !wording.ok) {
      lines.push('   注意：数字闸是绿的——说明数量没错、错的是字，别去动数字。');
    }
    if (!number.ok && wording.ok) {
      lines.push(
        number.kind === 'fetch-error'
          ? '   注意：数字闸没得出结论（取数失败），不能当通过；措辞闸是绿的。'
          : '   注意：措辞闸是绿的——字与 copy.json 一致，问题在发布包与 copy.json 的同步。',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const number = await runNumberGate();
  const wording = runWordingGate();
  process.stdout.write(renderReport({ number, wording }));
  if (!number.ok || !wording.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`❌ 双闸入口自身出错：${error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
/**
 * 一次性生成 eval-public/scorer.mjs（公开版判分器）。
 *
 * 原则：**照抄私有判分器的全部判定逻辑**，只把四处"身份 / 期望来源"改成命令行提供。
 * 这样公开版与私有版是同一把尺子，不会出现"公开的是另一套判据"。
 *
 * 用法：node scripts/build-eval-public.mjs
 * 任何一处替换没命中即非零退出（私有判分器结构变了就先核对，不生成半成品）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SRC = 'eval/r1b-20261031/scorer.mjs';
const OUT = 'eval-public/scorer.mjs';
const src = readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '');
const patches = [];

const must = (name, from, to) => {
  if (!src.includes(from)) throw new Error(`补丁「${name}」没命中——私有判分器结构变了，先核对再生成`);
  patches.push({ name, from, to });
};

// ① 头部说明 + 命令行取值助手
must(
  'header+getArg',
  "import { fileURLToPath } from 'node:url';",
  "import { fileURLToPath } from 'node:url';\n\n"
  + "// ───────────────────────────────────────────────────────────────────────────\n"
  + '// 公开版（eval-public/）：判定逻辑照抄私有判分器 eval/r1b-20261031/scorer.mjs，\n'
  + '// 只把「期望来源 / runner 身份 / 题集哈希」改成命令行参数（见下方 getArg 与 loadExpect）。\n'
  + '// **题面与期望值不公开**：公开判分器是为了让人复核"判定是怎么算的"，不是给人照题刷分。\n'
  + '// 用法：node scorer.mjs <产物.json> --expect <期望.json> [--expect-sha <sha>] [--tasks-sha <sha>] [--runner-sha <sha>]\n'
  + "// ───────────────────────────────────────────────────────────────────────────\n"
  + "const getArg = (name) => {\n"
  + "  const i = process.argv.indexOf(name);\n"
  + '  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith(\'--\') ? process.argv[i + 1] : undefined;\n'
  + '};',
);

// ② 期望来源：私有读同目录 tasks.json（带冻结哈希）→ 公开按 --expect 提供
must(
  'loadExpect',
  `function loadExpect() {
  const p = join(HERE, 'tasks.json');
  const sha = sha256(p);
  if (sha !== FROZEN_EXPECT_SHA) {
    console.error(\`期望文件哈希不符！期望 \${FROZEN_EXPECT_SHA}，实得 \${sha}\`);
    process.exit(4);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}`,
  `function loadExpect() {
  // 公开版：期望由调用方提供（题面与期望值不入公开仓）
  const p = getArg('--expect');
  if (!p) {
    console.error('公开版判分器需要 --expect <期望.json>（本仓不公开题面与期望值）');
    process.exit(2);
  }
  if (!existsSync(p)) {
    console.error('找不到期望文件：' + p);
    process.exit(2);
  }
  const wantSha = getArg('--expect-sha');
  if (wantSha) {
    const sha = sha256(p);
    if (sha !== wantSha.toUpperCase()) {
      console.error(\`期望文件哈希不符！期望 \${wantSha}，实得 \${sha}\`);
      process.exit(4);
    }
  } else {
    console.error('注：未提供 --expect-sha，期望文件哈希未校验');
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}`,
);

// ③ runner 身份：公开版不带 runner，用 --runner-sha 对账；未给就明说未核对
must(
  'runnerIdentity',
  `  const runnerPath = join(HERE, 'runner.mjs');
  if (!existsSync(runnerPath)) {
    console.error('找不到同目录 runner.mjs：无法核对"跑的 runner 与记录的是否同一个"');
    process.exit(4);
  }
  const runnerSha = sha256(runnerPath);
  if (artifact.scriptSha256 !== runnerSha) {
    console.error(\`产物自报脚本哈希(\${String(artifact.scriptSha256).slice(0, 16)}…)≠仓内 runner(\${runnerSha.slice(0, 16)}…)：这份产物不是本 runner 出的\`);
    process.exit(4);
  }`,
  `  // 公开版：不附带 runner；用 --runner-sha 对账，未提供则明说未核对（不静默放过）
  const runnerPath = join(HERE, 'runner.mjs');
  let runnerSha = getArg('--runner-sha');
  if (!runnerSha && existsSync(runnerPath)) runnerSha = sha256(runnerPath);
  if (!runnerSha) {
    console.error('注：未提供 --runner-sha 且同目录无 runner.mjs，产物与 runner 的身份未核对');
    runnerSha = String(artifact.scriptSha256 ?? '未报');
  } else if (artifact.scriptSha256 !== runnerSha) {
    console.error(\`产物自报脚本哈希(\${String(artifact.scriptSha256).slice(0, 16)}…)≠给定 runner(\${runnerSha.slice(0, 16)}…)：这份产物不是该 runner 出的\`);
    process.exit(4);
  }`,
);

// ④ 题集哈希：允许 --tasks-sha 或期望文件自带 tasksSha256
must(
  'tasksSha',
  `  if (artifact.tasksSha256 !== FROZEN_TASKS_SHA) {
    console.error('产物记录的题集哈希与冻结值不符：这份产物跑的不是本套题集');
    process.exit(4);
  }`,
  `  const wantTasksSha = getArg('--tasks-sha') ?? expectData.tasksSha256;
  if (wantTasksSha && artifact.tasksSha256 !== wantTasksSha) {
    console.error('产物记录的题集哈希与给的期望不符：这份产物跑的不是这套题集');
    process.exit(4);
  }
  if (!wantTasksSha) console.error('注：未提供 --tasks-sha、期望文件也没写 tasksSha256，题集哈希未核对');`,
);

let out = src;
for (const { from, to } of patches) out = out.replace(from, to);

const srcSha = createHash('sha256').update(src).digest('hex').toUpperCase();
// 出处注释必须放在 shebang **之后**（shebang 只能在第一行）
out = out.replace(
  '#!/usr/bin/env node\n',
  '#!/usr/bin/env node\n'
  + `// 本文件由 scripts/build-eval-public.mjs 从私有判分器生成；源 eval/r1b-20261031/scorer.mjs（sha256=${srcSha}）\n`,
);

writeFileSync(OUT, out, 'utf8');
console.log(`生成 ${OUT}：${Buffer.byteLength(out, 'utf8')} B；${patches.length} 处补丁全部命中`);

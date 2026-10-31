#!/usr/bin/env node
/**
 * 预算自检（源 ≤ 20 / 工具 ≤ 40）。
 *
 * 为什么要有这个脚本：上限如果只写在文档里，等你想起来查的时候早就超了。
 * 做成命令 + 非零退出，才能像 §五 的断言一样被信任。
 *
 * 2026-10-30 起**不再自己数工具**：数量事实的唯一实现在 `scripts/counts.mjs`，
 * 这里只做预算判定与排版。两套算法必然会漂移，README 里那两次翻车就是这么来的。
 *
 * 用法：
 *   npm run build && npm run stats
 *   node scripts/stats.mjs --json
 *
 * 退出码：超预算 → 1（按项目规约，断言必须非零退出）。
 */

import { createRegistry } from '../dist/sources/index.js';

import { buildBudgetReport, collectCounts, renderStatsText } from './counts.mjs';

const asJson = process.argv.includes('--json');
const report = buildBudgetReport(collectCounts(createRegistry()));

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(renderStatsText(report));
}

if (report.overBudget) process.exitCode = 1;

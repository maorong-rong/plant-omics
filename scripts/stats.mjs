#!/usr/bin/env node
/**
 * 预算自检（v2.3「源市场」制，2026-10-31 本涛确认）。
 *
 * **唯一硬阈值：单次订阅集 ≤ 80 工具。** 全库源数与工具数只报数、不拦截——
 * 上下文成本由「这次装了哪些源」决定，不由库房总量决定（AGENTS.md §10）。
 *
 * 订阅集怎么取：与运行时**同一个环境变量** `PLANTOMICS_SOURCES`（同一个 `parseSourceList`），
 * 因为那正是服务启动时加载的集合；这里另立一套解析就会与线上漂移。
 * 未设该变量 = 没指定订阅集 → 只报默认集，绝不因全库大而失败。
 *
 * 2026-10-30 起**不再自己数工具**：数量事实的唯一实现在 `scripts/counts.mjs`，
 * 这里只做订阅集解析、预算判定与排版。两套算法必然会漂移。
 *
 * 用法：
 *   npm run build && npm run stats
 *   PLANTOMICS_SOURCES=wheatomics,icg npm run stats      # 校验某个订阅集是否 ≤ 80
 *   node scripts/stats.mjs --json
 *
 * 退出码：**订阅集**超 80 → 1（§五 断言铁律，不用 warn 糊过去）。
 */

import { createRegistry, parseSourceList } from '../dist/sources/index.js';

import { buildBudgetReport, collectCounts, renderStatsText } from './counts.mjs';

const asJson = process.argv.includes('--json');

const counts = collectCounts(createRegistry());

// 与运行时同一份解析：环境变量决定"这次装哪些源"，也就是订阅集。
const enabled = parseSourceList(process.env.PLANTOMICS_SOURCES);
let subscription;
if (enabled) {
  const subset = collectCounts(createRegistry({ enabled }));
  subscription = { requested: enabled, sources: subset.sources, tools: subset.tools };
}

const report = buildBudgetReport(counts, subscription);

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(renderStatsText(report));
}

if (report.overBudget) process.exitCode = 1;

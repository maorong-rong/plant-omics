#!/usr/bin/env node
/**
 * 预算自检（当前工程预算）。
 *
 * 为什么要有这个脚本：源上限 20、工具上限 40 这两条如果只写在文档里，
 * 等你想起来查的时候早就超了。做成命令 + 非零退出，才能像 §五 的断言一样被信任。
 *
 * 2026-10-28 修正（审查 R08）：原版把"还能加 34 个工具、19 个源"并列输出，
 * 容易让人以为两者都能同时用满——实际上**工具额度才是紧约束**：
 * 34 个工具按每源 4–8 个算，只够再加 4–8 个源，根本到不了 20 个。
 *
 * 用法：
 *   npm run build && npm run stats
 *   node scripts/stats.mjs --json
 *
 * 退出码：超预算 → 1（按项目规约，断言必须非零退出）。
 */

import { createRegistry } from '../dist/sources/index.js';

/** 与 当前工程预算 保持一致；改这里必须同时改文档。 */
const MAX_SOURCES = 20;
const MAX_TOOLS = 40;
/** §二.1：每源 4–8 个工具 */
const MIN_TOOLS_PER_SOURCE = 4;
const MAX_TOOLS_PER_SOURCE = 8;

const asJson = process.argv.includes('--json');
const registry = createRegistry();

const perSource = registry.listSources().map((bundle) => ({
  id: bundle.manifest.id,
  displayName: bundle.manifest.displayName,
  tier: bundle.manifest.tier,
  tools: bundle.tools.length,
}));
const toolCount = registry.listTools().length;

const toolRoom = Math.max(0, MAX_TOOLS - toolCount);
const sourceRoom = Math.max(0, MAX_SOURCES - perSource.length);
/** 按每源最多 8 个工具算的**保守**可加源数；按每源最少 4 个算的乐观值。 */
const sourcesByToolsMin = Math.floor(toolRoom / MAX_TOOLS_PER_SOURCE);
const sourcesByToolsMax = Math.floor(toolRoom / MIN_TOOLS_PER_SOURCE);

const report = {
  sources: perSource.length,
  maxSources: MAX_SOURCES,
  tools: toolCount,
  maxTools: MAX_TOOLS,
  toolRoom,
  sourceRoom,
  sourcesByToolsMin,
  sourcesByToolsMax,
  /** 40 以内可以全量暴露；超过就必须先做检索层（§10.2） */
  needsRetrievalLayer: toolCount > MAX_TOOLS,
  /** 紧约束是工具额度，不是源额度 */
  bindingConstraint: toolRoom / MAX_TOOLS_PER_SOURCE < sourceRoom ? 'tools' : 'sources',
  perSource,
  overBudget: perSource.length > MAX_SOURCES || toolCount > MAX_TOOLS,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const lines = [
    `源：${report.sources} / ${MAX_SOURCES}`,
    `工具：${report.tools} / ${MAX_TOOLS}`,
    '',
    '| 源 | 等级 | 工具数 |',
    '|---|---|---|',
    ...perSource.map((s) => `| ${s.id} | ${s.tier} | ${s.tools} |`),
    '',
  ];

  if (report.sources > MAX_SOURCES) {
    lines.push(`❌ 源数超上限（${report.sources} > ${MAX_SOURCES}）：按当前工程预算 不许再加。`);
  }
  if (report.needsRetrievalLayer) {
    lines.push(`⚠️ 工具数 ${report.tools} > ${MAX_TOOLS}：**必须先实现检索层**再继续加源（§10.2）。`);
  }

  if (!report.overBudget && !report.needsRetrievalLayer) {
    lines.push(
      `✅ 第 1 阶段（全量暴露）。工具余量 ${toolRoom} 个 —— 这是**紧约束**：`
        + `按每源 4–8 个工具算，还能加约 ${sourcesByToolsMin}–${sourcesByToolsMax} 个源；`,
    );
    lines.push(
      `   距源上限还差 ${sourceRoom} 个，但按工具额度算**到不了 20 个源**——`
        + `铺到约 ${perSource.length + sourcesByToolsMin} 个源时，检索层就是下一件必须做的事。`,
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

if (report.overBudget) process.exitCode = 1;

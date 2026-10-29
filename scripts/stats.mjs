#!/usr/bin/env node
/**
 * 预算自检（当前工程预算）。
 *
 * 为什么要有这个脚本：源上限 20、工具上限 40 这两条如果只写在文档里，
 * 等你想起来查的时候早就超了。做成命令 + 非零退出，才能像 §五 的断言一样被信任。
 *
 * 2026-10-28 修正（审查 R08）：原版把"还能加 34 个工具、19 个源"并列输出，
 * 容易让人以为两者都能同时用满。补充说明（后续复核指出旧解释不严谨）：
 * 两者不是同一维度，**紧约束取决于每源实际工具数**——这里是情景估算，不是硬结论。
 * 若按每源 4–8 工具的假设，剩余工具额度只够再加约 4–8 个源；但规则允许能力较窄的源
 * 少于 4 个工具（须说明理由并独立审查），实际可接源数可能高于该估算。
 * 因此：**4–8 只是估算假设，不是每源最低/最高数量校验，也不作为接入门禁。**
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
/** 仅用于情景估算；不是每源最低/最高数量校验。能力较窄可少于4，须另经审查。 */
const ASSUMED_TOOLS_LOW = 4;
const ASSUMED_TOOLS_HIGH = 8;

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
/** 仅计算工具余量在每源8/4工具假设下能容纳多少源；实际还受sourceRoom约束。 */
const sourcesByToolsMin = Math.floor(toolRoom / ASSUMED_TOOLS_HIGH);
const sourcesByToolsMax = Math.floor(toolRoom / ASSUMED_TOOLS_LOW);

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
  /** 保留既有字段；其判定只在每源8工具假设下成立，不是硬门禁。 */
  bindingConstraint: toolRoom / ASSUMED_TOOLS_HIGH < sourceRoom ? 'tools' : 'sources',
  capacityEstimateAssumption: { toolsPerSourceLow: ASSUMED_TOOLS_LOW, toolsPerSourceHigh: ASSUMED_TOOLS_HIGH,
    isMinimumRequirement: false, bindingConstraintToolsPerSource: ASSUMED_TOOLS_HIGH },
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
      `✅ 第 1 阶段（全量暴露）。实际工具余量 ${toolRoom} 个，实际源余量 ${sourceRoom} 个。`,
    );
    lines.push(
      `   情景估算：仅假设新增源各有4–8工具，工具余量可容纳约 ${sourcesByToolsMin}–${sourcesByToolsMax} 个源（另受源余量限制）。`,
      `   4不是每源最低工具数；较窄能力可少于4个，须说明理由并独立审查，不凑数。`,
      `   按每源8工具假设的紧约束：${report.bindingConstraint === 'tools' ? '工具额度' : '源额度'}；接入门禁只按实际源≤20、工具≤40检查。`,
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

if (report.overBudget) process.exitCode = 1;

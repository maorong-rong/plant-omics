#!/usr/bin/env node
/**
 * 契约闸（P1「契约单一真相」）：断言默认集三处读数一致。
 *
 * 三处读数必须来自**运行时接口**，不读源码常量——否则这个闸就是被测对象自己给自己打分：
 *   - `/catalog.budget.defaultSetTools`：临时 HTTP 服务 `GET /catalog`；
 *   - `hub_status`：同一服务走 MCP `tools/call`，解析正文「默认推荐集：N 个工具」；
 *   - `tools/list`：同一服务走 MCP `tools/list`，数返回的 tool 条数。
 *
 * 复用 P0 `status-report.mjs` 的采集层与纯判定函数（不复制读取逻辑、不改 P0 产物）：
 * P0 的职责是「能报告并报红」，P1 的职责是「读数已经一致，且以后不一致就挡住合并」。
 *
 * 退出码：三处都读到整数且相等 → 0；任一处读不到或不相等 → 1。
 *
 * 用法：
 *   npm run build && npm run check:contracts
 *   node scripts/check-contracts.mjs
 *
 * 边界：本闸只核「默认会话（不带订阅头）」的读数。为排除本机 `PLANTOMICS_SOURCES`
 * 把默认会话变成子集，脚本在加载 dist 前会清掉这个环境变量。
 */

import { pathToFileURL } from 'node:url';

import {
  collectLocalReadings,
  evaluateDefaultSetConsistency,
  READING_LABELS,
} from './status-report.mjs';

/** 把三处读数排成一行，供通过 / 失败两种输出共用，避免两套说法。 */
export function formatReadings(values) {
  return [
    READING_LABELS.catalogDefaultSetTools,
    READING_LABELS.hubStatusDefaultSetTools,
    READING_LABELS.toolsListCount,
  ].map((label) => `${label}=${values?.[label] ?? '读不到'}`).join('；');
}

/**
 * 纯判定：把采集结果转成 CLI 需要的 `{ code, values, problems, detail }`。
 *
 * 独立成纯函数，方便单测直接喂构造读数（不需要起服务 / 读 dist）。
 */
export function evaluateContracts(readings) {
  const result = evaluateDefaultSetConsistency(readings);
  return {
    code: result.consistent ? 0 : 1,
    values: result.values,
    problems: result.problems,
    detail: formatReadings(result.values),
  };
}

export async function main({
  collectLocal = collectLocalReadings,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  // 契约闸只测“不带订阅头”的默认会话；环境变量会把默认会话变成子集，先清掉。
  delete process.env.PLANTOMICS_SOURCES;

  let readings;
  try {
    readings = await collectLocal({});
  } catch (error) {
    stderr(`❌ 读不到契约三处读数（先 npm run build）：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const result = evaluateContracts(readings);
  if (result.code === 0) {
    stdout(`✅ 默认集契约一致：${result.detail}\n`);
    return 0;
  }
  stderr(`❌ 默认集契约不一致：${result.detail}\n`);
  for (const problem of result.problems) {
    // 三处数值已在上一行给出；这里只补「哪一处读不到」这类额外信息，避免同一句话打两遍
    if (!problem.includes(result.detail)) stderr(`  - ${problem}\n`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`❌ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

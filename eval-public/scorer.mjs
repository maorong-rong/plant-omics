#!/usr/bin/env node
// 本文件由 scripts/build-eval-public.mjs 从私有判分器生成；源 eval/r1b-20261031/scorer.mjs（sha256=3F478E93309109407C9EB238E660C0F92E63A48D50574CA01E6B1FE978EF0609）
/**
 * R1b 判据评分器（v2.2 口径，2026-10-31 draft-2）。
 *
 * 观测边界（R1B-03 裁定，2026-10-31）：
 *   判据**可以**读工具返回的行为型输出：`text`、`raw.candidates`、`state`、`toolUniverse`；
 *   **不得**读实现自己产出的判定字段（如 `speciesVerdicts`、`vetoed`）。
 *   区别：前者是被测对象的行为，后者是被测对象的自述。M-3 的病是信自述，不是禁止看行为。
 *
 * 负控纪律（R1B-01）：
 *   负控 = **固定期望 + 构造错误观测**，看判据会不会红。
 *   不许用"删断言"制造负控——删断言只会扩大接受集合，正常输出永远不会因此变红。
 *   断言存在性由 `assertionKeys` 统一检查：一条期望里没有任何断言 → 直接判 FAIL。
 *
 * 完整性 vs 合法性（R1B-03）：
 *   `mustGiveTools` 只保证"至少给了这些"；`expectedToolsExact` 才是完整集合（少给/多给都红）。
 *   本仪器覆盖单物种、无方向歧义的题；多物种/方向题的完整性由 ①-b 与 E1/E2 分别覆盖。
 *
 * 预算路径（R1B-04）：
 *   "预算没触发"与"语义错了"分开报——前者是量具未覆盖（记 note，不判 FAIL），后者才红。
 *
 * 输出：逐题 PASS/FAIL + 失败检查名 + note。**不给总分、不给通过率。**
 *
 * 用法：
 *   node scorer.mjs <产物.json>
 *   node scorer.mjs --selftest
 *
 * 退出码：任一题 FAIL → 1；--selftest 未通过 → 1；输入/仪器身份不符 → 4。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ───────────────────────────────────────────────────────────────────────────
// 公开版（eval-public/）：判定逻辑照抄私有判分器 eval/r1b-20261031/scorer.mjs，
// 只把「期望来源 / runner 身份 / 题集哈希」改成命令行参数（见下方 getArg 与 loadExpect）。
// **题面与期望值不公开**：公开判分器是为了让人复核"判定是怎么算的"，不是给人照题刷分。
// 用法：node scorer.mjs <产物.json> --expect <期望.json> [--expect-sha <sha>] [--tasks-sha <sha>] [--runner-sha <sha>]
// ───────────────────────────────────────────────────────────────────────────
const getArg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : undefined;
};

const HERE = dirname(fileURLToPath(import.meta.url));
/** 期望文件字节指纹；改期望必须同步改这里并升版本 */
const FROZEN_EXPECT_SHA = 'C574CC7BC84F95DBFB84A7EEAEE9E09B8F1C0BF0077AA4CE6356EB23FC0664CC';
/** 题集字节指纹（与 runner.mjs 内常量、manifest.json 同值） */
const FROZEN_TASKS_SHA = '639ACDDEA978D62873E943B06BF7049BCAD74FE6A6EDA995C2C95CDD181F2E05';

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();

/** 正文里渲染出来的源（①–⑳ 起头的行） */
const renderedSources = (text) => {
  const set = new Set();
  for (const m of text.matchAll(/^[\u2460-\u2473]\s+([a-z0-9]+)｜/gmu)) set.add(m[1]);
  return set;
};

/**
 * 只取"可被判定的正文"（R1B 局部B 整改）：
 *   ① 丢弃出处尾注（首行 `——` 及其后所有内容）——尾注里有 `question=…` 回显，
 *      拿它匹配物种/覆盖语义等于让题面自己证明答案；
 *   ② 丢弃首行 `识别：…`——那是"识别结果"，不是"交代"，把它算成交代会自证。
 * 语义断言一律在这段文本上跑。
 */
const judgedBody = (text) => {
  const lines = String(text ?? '').split('\n');
  const cut = lines.findIndex((l) => l.trim() === '——');
  const body = cut >= 0 ? lines.slice(0, cut) : lines;
  return body.filter((l) => !l.startsWith('识别：')).join('\n');
};

/** 一条期望里"算得上断言"的字段：一个都没有就该判 FAIL，防止删断言当负控 */
const ASSERTION_KEYS = [
  'state', 'candidatesExact', 'candidatesMin', 'mustGiveTools', 'mustNotGivePrefixes',
  'mustSayRegex', 'mustSaySameLine', 'mustNotSayRegex', 'noBusinessToolInText',
  'expectedToolsExact', 'expectedSourcesExact', 'budgetTriggered', 'budgetNote',
  'maxTotalBytes', 'tailIntact', 'exampleOnlySources', 'renderedLessThanCandidates',
];

/**
 * 把正文切成"源块"：以 ①–⑳ 起头的行开启一个块，直到下一个块或正文结束。
 * 用途：把"该源覆盖了哪几个物种"绑定在**同一个源**上，避免 A 源的工具块
 * 被 B 源行的物种名凑过去（R1B-06 的源级绑定）。
 */
const sourceBlocks = (body) => {
  const blocks = [];
  let cur = null;
  for (const line of body.split('\n')) {
    const m = line.match(/^[\u2460-\u2473]\s+([a-z0-9]+)｜/u);
    if (m) { if (cur) blocks.push(cur); cur = { sourceId: m[1], lines: [line] }; }
    else if (cur) cur.lines.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks;
};

const budgetNumber = (text, pattern) => {
  const re = pattern ? new RegExp(pattern, 'u') : new RegExp("(?:另有|还有|剩余)\\s*(\\d+)\\s*个?(?:命中)?(?:源|来源|库)\\s*(?:未|没有|尚未)\\s*(?:展示|列出|显示|给出)", 'u');
  const m = text.match(re);
  return m ? Number(m[1]) : null;
};

/**
 * 判一题。返回 { fails, notes }。
 * fails 非空 = FAIL；notes 只是说明（如"预算路径未覆盖"），不影响判定。
 */
export function judgeCase(expect, row, toolUniverse) {
  const fails = [];
  const notes = [];
  // —— 观测结构合法性：缺字段不能当成"空"来判（否则删掉 candidates 的产物会被放过）
  if (!row || typeof row !== 'object') { fails.push('观测不是对象'); return { fails, notes }; }
  if (!Array.isArray(row.candidates)) fails.push('观测缺 candidates 字段（缺字段不等于空数组）');
  if (typeof row.state !== 'string' || row.state === '') fails.push('观测缺 state 字段');
  if (typeof row.text !== 'string') fails.push('观测缺 text 字段');
  const text = String(row.text ?? '');
  /** 语义断言用「可判定正文」：已剥掉出处尾注与识别回显 */
  const body = judgedBody(text);
  const candidates = Array.isArray(row.candidates) ? row.candidates : [];
  const given = candidates.flatMap((c) => c.tools ?? []);
  const sourceIds = candidates.map((c) => c.sourceId);

  // —— 断言存在性（R1B-01）：没有断言的期望不是期望
  if (!ASSERTION_KEYS.some((k) => expect[k] !== undefined)) {
    fails.push('该题没有任何断言（删断言不能当负控）');
    return { fails, notes };
  }

  if (expect.state && row.state !== expect.state) fails.push(`state≠${expect.state}（实得 ${row.state}）`);

  if (typeof expect.candidatesExact === 'number' && candidates.length !== expect.candidatesExact) {
    fails.push(`候选数≠${expect.candidatesExact}（实得 ${candidates.length}）`);
  }
  if (typeof expect.candidatesMin === 'number' && candidates.length < expect.candidatesMin) {
    fails.push(`候选数<${expect.candidatesMin}（实得 ${candidates.length}）`);
  }
  if (new Set(sourceIds).size !== sourceIds.length) fails.push('候选里有重复源条目');

  /**
   * 通用语义检查一：候选非空时，正文必须给出每个候选工具名
   * （§二.3：工具名是给模型看的界面；正文不出现等于没给）。
   */
  {
    const blocks0 = sourceBlocks(body);
    const missingInBlock = [];
    // 预算截断时，未展示的源本来就没有源块——只在没有"未展示"提示时要求每个候选源都有块
    const hasOmitNote = new RegExp("(?:另有|还有|剩余)\\s*(\\d+)\\s*个?(?:命中)?(?:源|来源|库)\\s*(?:未|没有|尚未)\\s*(?:展示|列出|显示|给出)", 'u').test(body);
    if (!hasOmitNote) {
      for (const cap of candidates) {
        if (!blocks0.some((b) => b.sourceId === cap.sourceId)) missingInBlock.push(cap.sourceId + ':(无源块)');
      }
    }
    for (const b of blocks0) {
      const cap = candidates.find((c) => c.sourceId === b.sourceId);
      if (!cap) continue;
      const t = b.lines.join('\n');
      for (const tool of cap.tools ?? []) if (!t.includes(tool)) missingInBlock.push(b.sourceId + ':' + tool);
    }
    if (missingInBlock.length) fails.push(`源块内未给出工具名：${missingInBlock.join(',')}`);
  }
  /**
   * 通用语义检查二：正文不得出现"未在候选中列出"的工具名。
   * 防两类错：删掉某个候选工具、或正文凭空写出一个没给的工具（幽灵工具）。
   */
  {
    const mentioned = toolUniverse.filter((n) => !n.startsWith('hub_') && body.includes(n));
    const ghost = mentioned.filter((n) => !given.includes(n));
    if (ghost.length) fails.push(`正文出现了未列在候选里的工具名：${ghost.join(',')}`);
  }
  /**
   * 通用语义检查三：逐物种否定式覆盖交代（speciesNegation）。
   * 每个被点名的物种必须在**同一行**出现否定语义，且该行不得有肯定式覆盖表述；
   * 这直接防"把不覆盖反写成覆盖"（R1B-06 的极性要求）。
   */
  if (Array.isArray(expect.speciesUncovered)) {
    const NEG = /(不覆盖|未覆盖|不在|没有任何源|没有(相应)?(数据)?源|没有覆盖|无覆盖|未接入|未收录|不在目录)/u;
    const POS = /(有源覆盖|已覆盖|可以查询|支持查询)/u;
    for (const sp of expect.speciesUncovered) {
      const lines = body.split('\n').filter((l) => l.includes(sp) && l.trim().startsWith('-'));
      if (lines.length === 0) { fails.push('正文未交代物种未覆盖：' + sp); continue; }
      if (!lines.some((l) => NEG.test(l) && !POS.test(l))) fails.push('物种 ' + sp + ' 缺少否定式未覆盖交代（或出现肯定覆盖）');
    }
  }
  if (Array.isArray(expect.capabilityGap)) {
    const GAP = /(没有|缺|不提供|不支持|未提供|无此)/u;
    const POS = /(可以查询|支持查询|可直接查)/u;
    for (const sp of expect.capabilityGap) {
      const lines = body.split('\n').filter((l) => l.includes(sp) && l.trim().startsWith('-'));
      if (lines.length === 0) { fails.push('正文未交代能力缺口：' + sp); continue; }
      if (!lines.some((l) => /覆盖/u.test(l) && GAP.test(l) && !POS.test(l))) fails.push('物种 ' + sp + ' 缺少"覆盖但缺能力"的同句交代');
    }
  }
  if (Array.isArray(expect.directionClaim)) {
    const lines = body.split('\n').filter((l) => l.trim().startsWith('-'));
    const ok = lines.some((l) => expect.directionClaim.some((w) => l.includes(w)) && /(方向|目标端|目标物种)/u.test(l));
    if (!ok) fails.push('方向题缺少点明方向/目标端的同句交代');
  }

  if (expect.requireHeadline) {
    const first = body.split('\n').find((l) => l.trim() !== '') ?? '';
    if (!/^(没有(可用)?覆盖|未覆盖|无覆盖|本服务没有覆盖)/u.test(first.trim())) fails.push('缺少以「没有覆盖」起头的标题行');
  }
  // —— R1B-06 语义绑定：同一行内绑定物种与否定/肯定关系
  if (Array.isArray(expect.lineChecks)) {
    const lines = body.split('\n');
    for (const lc of expect.lineChecks) {
      const ok = lines.some((l) => (lc.mustAll ?? []).every((w) => l.includes(w))
        && (!lc.mustAny || lc.mustAny.some((w) => l.includes(w)))
        && (!lc.mustNone || !lc.mustNone.some((w) => l.includes(w))));
      if (!ok) fails.push(`缺少判定行：${lc.label}`);
    }
  }
  // —— R1B-06 源级绑定：同一源块内必须交代的物种/禁止出现的词
  if (Array.isArray(expect.blockChecks)) {
    const blocks = sourceBlocks(body);
    for (const bc of expect.blockChecks) {
      const blk = blocks.find((b) => b.sourceId === bc.sourceId);
      if (!blk) { fails.push(`缺少源块：${bc.sourceId}`); continue; }
      const t = blk.lines.join('\n');
      const missing = (bc.mustAll ?? []).filter((w) => !t.includes(w));
      if (missing.length) fails.push(`源块 ${bc.sourceId} 未交代：${missing.join(',')}`);
      const banned = (bc.mustNone ?? []).filter((w) => t.includes(w));
      if (banned.length) fails.push(`源块 ${bc.sourceId} 出现禁止词：${banned.join(',')}`);
    }
  }
  // —— 候选合法性：返回的工具/源必须属于该题允许集合（R1B-07 的另一半）
  if (Array.isArray(expect.allowedTools)) {
    const illegal = given.filter((t) => !expect.allowedTools.includes(t));
    if (illegal.length) fails.push(`非法候选工具：${illegal.join(',')}`);
  }
  if (Array.isArray(expect.allowedSources)) {
    const illegal = sourceIds.filter((s) => !expect.allowedSources.includes(s));
    if (illegal.length) fails.push(`非法候选源：${illegal.join(',')}`);
  }
  if (new Set(given).size !== given.length) fails.push('候选工具重复（同一工具被反复计入）');

  // —— 完整性（R1B-03）：全量集合比对，少给/多给都红
  if (Array.isArray(expect.expectedToolsExact)) {
    const want = [...new Set(expect.expectedToolsExact)].sort();
    const got = [...new Set(given)].sort();
    const missing = want.filter((t) => !got.includes(t));
    const extra = got.filter((t) => !want.includes(t));
    if (missing.length) fails.push(`缺工具（完整性）：${missing.join(',')}`);
    if (extra.length) fails.push(`多出不该有的工具：${extra.join(',')}`);
  }
  if (Array.isArray(expect.expectedSourcesExact)) {
    const want = [...new Set(expect.expectedSourcesExact)].sort();
    const got = [...new Set(sourceIds)].sort();
    const missing = want.filter((s) => !got.includes(s));
    const extra = got.filter((s) => !want.includes(s));
    if (missing.length) fails.push(`缺源（完整性）：${missing.join(',')}`);
    if (extra.length) fails.push(`多出不该有的源：${extra.join(',')}`);
  }

  for (const name of expect.mustGiveTools ?? []) {
    if (!given.includes(name)) fails.push(`缺少必给工具 ${name}`);
  }
  for (const prefix of expect.mustNotGivePrefixes ?? []) {
    const hit = given.filter((n) => n.startsWith(prefix));
    if (hit.length) fails.push(`不得给的源工具出现：${hit.join(',')}`);
  }
  for (const re of expect.mustSayRegex ?? []) {
    if (!new RegExp(re, 'u').test(body)) fails.push(`正文缺少语义 /${re}/`);
  }
  for (const re of expect.mustNotSayRegex ?? []) {
    if (new RegExp(re, 'u').test(body)) fails.push(`正文出现禁止表述 /${re}/`);
  }
  if (Array.isArray(expect.nextStepRegex)) {
    const nextStep = body.split('\n').filter((l) => /^(下一步|建议|请)/u.test(l.trim())).join('\n');
    for (const re of expect.nextStepRegex) {
      if (!new RegExp(re, 'u').test(nextStep)) fails.push(`下一步缺少语义 /${re}/`);
    }
  }
  if (Array.isArray(expect.mustSaySameLine)) {
    const lines = body.split('\n');
    const missing = expect.mustSaySameLine.filter(([a, b]) => !lines.some((l) => l.includes(a) && l.includes(b)));
    if (missing.length) fails.push(`同一行缺少「${missing.map(([a, b]) => a + '+' + b).join('、')}」`);
  }
  if (expect.noBusinessToolInText) {
    const business = toolUniverse.filter((n) => !n.startsWith('hub_'));
    const leaked = business.filter((n) => body.includes(n));
    if (leaked.length) fails.push(`正文出现了业务工具名：${leaked.join(',')}`);
  }
  /**
   * example-only 源的口径（2026-10-31 批准，**按语义判，不认实现措辞**）：
   *   - 必须有一条含该源的行带"示例性限定"：示例 / 仅实测 / 仅已验 / 非承诺 —— 四者任一即可；
   *   - 不得有含该源、且声称覆盖该物种、却没有上述限定词的行。
   * 这样实现写「示例源无此能力：icg：仅已验示例」「icg（示例非承诺）」都能过，
   * 换成"有覆盖但没能力：icg"这类混写则被判掉。
   */
  if (Array.isArray(expect.exampleOnlySources)) {
    const QUALIFY = /(示例|仅实测|仅已验|非承诺)/u;
    const CLAIM = /(有源覆盖|覆盖该物种|已覆盖该物种|可查该物种)/u;
    for (const src of expect.exampleOnlySources) {
      const lines = body.split('\n').filter((l) => l.includes(src));
      if (!lines.some((l) => QUALIFY.test(l))) {
        fails.push(`example-only 源缺少示例性限定（示例/仅实测/仅已验/非承诺）：${src}`);
      }
      const bad = lines.filter((l) => CLAIM.test(l) && !QUALIFY.test(l));
      if (bad.length) fails.push(`example-only 源被写成覆盖且无限定：${src}（${bad[0].trim().slice(0, 60)}）`);
    }
  }

  // —— 预算路径（R1B-04）：先判"是否触发"，再判"N 对不对"；未触发只记 note
  const U = new Set(sourceIds);
  const R = renderedSources(text);
  if (expect.budgetTriggered) {
    if (R.size >= U.size) {
      notes.push('预算路径未覆盖：正文渲染源数不少于命中源数，本锚未触发预算分支（不判语义错）');
    } else {
      const extraRendered = [...R].filter((s) => !U.has(s));
      if (extraRendered.length) fails.push(`正文渲染了不在候选里的源：${extraRendered.join(',')}`);
      if (expect.budgetNote) {
        const n = budgetNumber(body, expect.budgetNotePattern);
        const want = U.size - R.size;
        if (n === null) fails.push('缺少「另有 N 个源未展示」的明示');
        else if (n !== want) fails.push(`未展示数 N=${n} ≠ 差值 ${want}（U=${U.size}, R=${R.size}）`);
      }
    }
  } else if (expect.renderedLessThanCandidates) {
    if (!(R.size < U.size)) fails.push(`渲染源数(${R.size})未小于命中源数(${U.size})，预算分支没触发`);
  }

  if (typeof expect.maxTotalBytes === 'number') {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > expect.maxTotalBytes) fails.push(`整包 ${bytes} B 超过 ${expect.maxTotalBytes} B`);
  }
  if (expect.tailIntact) {
    const last = text.trimEnd().split('\n').pop() ?? '';
    if (!/查询时刻/.test(last)) fails.push('尾注最后一行不是查询时刻（出处被截断）');
  }
  return { fails, notes };
}

function loadExpect() {
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
      console.error(`期望文件哈希不符！期望 ${wantSha}，实得 ${sha}`);
      process.exit(4);
    }
  } else {
    console.error('注：未提供 --expect-sha，期望文件哈希未校验');
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function judgeArtifact(artifactPath) {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  if (artifact.phase !== 'r1b') {
    console.error('不是 R1b 产物（phase≠r1b），拒绝判');
    process.exit(4);
  }
  // 公开版：不附带 runner；用 --runner-sha 对账，未提供则明说未核对（不静默放过）
  const runnerPath = join(HERE, 'runner.mjs');
  let runnerSha = getArg('--runner-sha');
  if (!runnerSha && existsSync(runnerPath)) runnerSha = sha256(runnerPath);
  if (!runnerSha) {
    console.error('注：未提供 --runner-sha 且同目录无 runner.mjs，产物与 runner 的身份未核对');
    runnerSha = String(artifact.scriptSha256 ?? '未报');
  } else if (artifact.scriptSha256 !== runnerSha) {
    console.error(`产物自报脚本哈希(${String(artifact.scriptSha256).slice(0, 16)}…)≠给定 runner(${runnerSha.slice(0, 16)}…)：这份产物不是该 runner 出的`);
    process.exit(4);
  }
  const expectData = loadExpect();
  // —— 每題 basis 的目录版本：期望钉在设计时那份目录上，运行时目录变了必须显式报错
  const catNow = artifact.dist?.['retrieval/capability-catalog.js']?.sha256 ?? null;
  const catBasis = expectData.designBasis?.catalogDistSha256 ?? null;
  if (catBasis && catNow !== catBasis) {
    console.error('BASIS-DRIFT：期望依据的目录版本 = ' + String(catBasis).slice(0, 16) + '…，本次 base 的目录 = ' + String(catNow ?? '缺失').slice(0, 16) + '…');
    console.error('判据拒绝在目录已变的情况下默默判定：请先复核每題 basis、更新 designBasis 并升版本，再重跑。');
    process.exit(3);
  }
  const wantTasksSha = getArg('--tasks-sha') ?? expectData.tasksSha256;
  if (wantTasksSha && artifact.tasksSha256 !== wantTasksSha) {
    console.error('产物记录的题集哈希与给的期望不符：这份产物跑的不是这套题集');
    process.exit(4);
  }
  if (!wantTasksSha) console.error('注：未提供 --tasks-sha、期望文件也没写 tasksSha256，题集哈希未核对');
  if (!Array.isArray(artifact.toolUniverse) || artifact.toolUniverse.length === 0) {
    console.error('产物缺 toolUniverse：无法核对正文里的工具名');
    process.exit(4);
  }

  const basisMismatch = (expectData.cases ?? []).filter((c) => c.basisCatalogSha256 && c.basisCatalogSha256 !== expectData.designBasis?.catalogDistSha256);
  if (basisMismatch.length) {
    console.error('期望文件自相矛盾：以下题目的 basisCatalogSha256 与 designBasis 不一致 → ' + basisMismatch.map((c) => c.id).join(','));
    process.exit(4);
  }
  const rows = new Map(artifact.rows.map((r) => [r.id, r]));
  let failed = 0;
  const lines = [];
  const skipped = (expectData.cases ?? []).filter((c) => c.status && c.status !== 'judged');
  for (const c of expectData.cases) {
    if (c.status && c.status !== 'judged') { lines.push('SKIP(' + c.status + ') ' + c.id); continue; }
    const row = rows.get(c.id);
    if (!row) {
      lines.push(`FAIL ${c.id} 产物缺这一行`);
      failed += 1;
      continue;
    }
    const { fails, notes } = judgeCase(c, row, artifact.toolUniverse);
    if (fails.length) {
      failed += 1;
      lines.push(`FAIL ${c.id}｜${fails.join('；')}`);
    } else {
      const extra = [c.scopeNote, ...notes].filter(Boolean);
      lines.push(`PASS ${c.id}${extra.length ? '（' + extra.join('；') + '）' : ''}`);
    }
  }
  console.log('题集哈希=' + artifact.tasksSha256.slice(0, 16) + '…｜runner=' + runnerSha.slice(0, 16) + '…｜base=' + artifact.base);
  console.log('dist：' + Object.entries(artifact.dist ?? {}).map(([k, v]) => `${k}=${v ? v.sha256.slice(0, 16) : '缺失'}`).join('｜'));
  console.log(lines.join('\n'));
  console.log(`逐题判定完成：${failed === 0 ? '无 FAIL' : `FAIL ${failed} 题`}`);
  return failed === 0;
}

// ——————————————————————————————————————————————————————————
// 自检：固定期望 + 构造错误观测（R1B-01）。每项给出"希望出现的失败片段"或"应当 PASS"。
// ——————————————————————————————————————————————————————————
/**
 * 自检（--selftest <产物>）：**用正式期望**，不另写一套较弱的期望（负责人 2026-10-31 裁定）。
 *
 * 做法：
 *   1. 读 tasks.json 的正式期望（哈希校验）；
 *   2. 对每题用产物里的**真实观测**跑一次：PASS 的题即『正确措辞正控』；
 *   3. 对基线 PASS 的题逐条施加变异（加非法工具/重复源/重复工具/删工具/删字段/
 *      否定反转/N+1/截尾注/删交代行/删源块/清空正文），**每一条都必须被拒**；
 *   4. 基线已 FAIL 的题（实现待改）单独标 BASE-FAIL：它证明判据会红，但不构成正控；
 *      这类题不计入『无盲题』的证明，也不掩盖。
 *
 * 退出码：存在『变异被放过』→ 1；只有 BASE-FAIL 而没有盲题 → 0（并在输出里写明正控缺口）。
 */
/**
 * 变异集（在内存里把观测改错）。每条都对应一种"真实可能犯的错"：
 * 加非法工具、重复源、重复工具、删工具、删字段、否定反转、N+1、截尾注、删交代行、删源块、清空正文。
 * 变异只在内存，不写文件。
 */
const MUTATORS = [
  ['加非法工具', (row) => { row.candidates.push({ sourceId: 'zzfake', tools: ['zzfake_tool'] }); }],
  ['重复源条目', (row) => { if (row.candidates.length) row.candidates.push(JSON.parse(JSON.stringify(row.candidates[0]))); }],
  ['重复工具', (row) => { const c = row.candidates.find((x) => (x.tools ?? []).length); if (c) c.tools.push(c.tools[0]); }],
  ['删一个工具', (row) => { const c = row.candidates.find((x) => (x.tools ?? []).length); if (c) c.tools.pop(); }],
  ['删 candidates 字段', (row) => { delete row.candidates; }],
  ['删 state 字段', (row) => { delete row.state; }],
  ['否定反转（全部交代行反写）', (row) => {
    row.text = row.text.split('\n').map((l) => (l.trim().startsWith('-')
      ? l.replace(/(不覆盖|未覆盖|不在)/g, '覆盖')
      : l)).join('\n');
  }],
  ['未展示数 N+1', (row) => { row.text = row.text.replace(/另有\s*(\d+)/, (m, n) => '另有 ' + (Number(n) + 1)); }],
  ['截掉尾注', (row) => { const lines = row.text.split('\n'); row.text = lines.filter((l) => !l.includes('查询时刻')).join('\n'); }],
  ['删掉全部交代行', (row) => {
    row.text = row.text.split('\n')
      .filter((l) => !(l.trim().startsWith('-') && /不覆盖|未覆盖|不在|有源覆盖/.test(l)))
      .join('\n');
  }],
  ['删掉首个源块', (row) => {
    const lines = row.text.split('\n');
    const isBlock = (l) => /^[\u2460-\u2473]\s+[a-z0-9]+｜/u.test(l);
    const i = lines.findIndex(isBlock);
    if (i >= 0) {
      let j = i + 1;
      while (j < lines.length && !isBlock(lines[j]) && !/^下一步：/.test(lines[j])) j++;
      lines.splice(i, j - i);
    }
    row.text = lines.join('\n');
  }],
  ['正文清空', (row) => { row.text = ''; }],
];

/** 审查者 2026-10-31 给出的五类错法，逐条做成内存变异 */
const REVIEW_MUTATORS = [
  ['把覆盖写成不支持', (row) => {
    row.text = row.text.split('\n').map((l) => (l.trim().startsWith('-') ? l.replace(/覆盖/g, '不支持') : l)).join('\n');
  }],
  ['工具挂到错误的源', (row) => {
    const a = row.candidates.find((c) => (c.tools ?? []).length);
    if (a) {
      const others = row.candidates.map((c) => c.sourceId).filter((x) => x !== a.sourceId);
      a.sourceId = others[0] ?? 'gwh';
    }
  }],
  ['建议未知工具', (row) => {
    row.text = row.text + '\n- 建议调用 zz_unknown_tool 完成本次查询';
  }],
  ['双重否定冒充未覆盖', (row) => {
    row.text = row.text.replace(/(不覆盖|未覆盖|不在)/g, '并非$1');
  }],
  ['假未展示句隐藏全部工具', (row) => {
    row.candidates.length = 0;
    row.text = row.text + '\n另有 99 个命中源未展示';
  }],
];

function triage(artifactPath) {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const expectData = loadExpect();
  const rows = new Map(artifact.rows.map((r) => [r.id, r]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const out = [];
  for (const c of expectData.cases) {
    const row0 = rows.get(c.id);
    if (!row0) continue;
    const base = judgeCase(c, clone(row0), artifact.toolUniverse);
    if (base.fails.length) { out.push({ id: c.id, base: 'FAIL', slipped: ['(基线已 FAIL，不参与)'] }); continue; }
    const slipped = [];
    for (const [name, mutate] of REVIEW_MUTATORS) {
      const row = clone(row0);
      try { mutate(row); } catch { continue; }
      if (JSON.stringify(row) === JSON.stringify(row0)) continue;
      if (judgeCase(c, row, artifact.toolUniverse).fails.length === 0) slipped.push(name);
    }
    out.push({ id: c.id, base: 'PASS', slipped });
  }
  for (const r of out) console.log((r.slipped.length ? 'DROP ' : 'KEEP ') + r.id + '\uff1a' + (r.slipped.length ? '漏检 → ' + r.slipped.join('\u3001') : '五类变异全被拒'));
  const keep = out.filter((r) => r.base === 'PASS' && r.slipped.length === 0).map((r) => r.id);
  console.log('\n保留：' + (keep.join(',') || '(无)') + '\uff08' + keep.length + ' 题）');
  return keep.length;
}

function selfCheckWithArtifact(artifactPath) {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const expectData = loadExpect();
  const rows = new Map(artifact.rows.map((r) => [r.id, r]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let blind = 0, baseFail = 0, checked = 0;
  const lines = [];
  for (const c of expectData.cases) {
    if (c.status && c.status !== 'judged') continue;
    const row0 = rows.get(c.id);
    if (!row0) { lines.push('MISSING ' + c.id + '\uff1a\u4ea7\u7269\u7f3a\u8fd9\u4e00\u884c'); blind += 1; continue; }
    const base = judgeCase(c, clone(row0), artifact.toolUniverse);
    if (base.fails.length > 0) {
      baseFail += 1;
      lines.push('BASE-FAIL ' + c.id + '\uff1a\u57fa\u7ebf\u5df2 FAIL\uff0c\u4e0d\u6784\u6210\u6b63\u63a7\uff1b\u53d8\u5f02\u5ba1\u8ba1\u4e0d\u8ba1\u5165\u65e0\u76f2\u9898\u8bc1\u660e');
      continue;
    }
    checked += 1;
    const slipped = [];
    for (const [name, mutate] of MUTATORS) {
      const row = clone(row0);
      try { mutate(row); } catch { continue; }
      if (JSON.stringify(row) === JSON.stringify(row0)) continue;
      const { fails } = judgeCase(c, row, artifact.toolUniverse);
      if (fails.length === 0) slipped.push(name);
    }
    if (slipped.length) { blind += 1; lines.push('BLIND ' + c.id + '\uff1a\u53d8\u5f02\u88ab\u653e\u8fc7\uff1a' + slipped.join('\u3001')); }
    else lines.push('OK ' + c.id + '\uff1a\u6b63\u63a7\u901a\u8fc7\uff0c\u4e14\u5168\u90e8\u9002\u7528\u53d8\u5f02\u88ab\u62d2');
  }
  console.log(lines.join('\n'));
  console.log('\n\u81ea\u68c0\uff1a\u53ef\u9a8c\u8bc1\u9898 ' + checked + '\uff0c\u57fa\u7ebf FAIL \u9898 ' + baseFail + '\uff0c\u76f2\u9898 ' + blind + '\uff08\u53d8\u5f02\u53ea\u5728\u5185\u5b58\uff09');
  return blind === 0;
}
const arg = process.argv[2];
if (!arg) {
  console.error('用法：node scorer.mjs <产物.json> ｜ node scorer.mjs --selftest');
  process.exit(2);
}
/**
 * --selftest 与 --mutate 现在是同一件事：都用**正式期望**跑真实观测，
 * 再做内存变异看是否被拒。区别只是一个跑产物、一个必须显式给产物路径。
 */
if (arg === '--triage') {
  if (!process.argv[3]) { console.error('用法：node scorer.mjs --triage <产物.json>'); process.exit(2); }
  triage(process.argv[3]);
  process.exit(0);
}
const selftestTarget = arg === '--mutate' ? process.argv[3] : process.argv[3];
if (arg === '--selftest' || arg === '--mutate') {
  if (!selftestTarget) {
    console.error('用法：node scorer.mjs --selftest <产物.json>（必须给真实产物：自检要用正式期望 + 真实观测，不另写弱期望）');
    process.exit(2);
  }
  process.exit(selfCheckWithArtifact(selftestTarget) ? 0 : 1);
}
process.exit(judgeArtifact(arg) ? 0 : 1);

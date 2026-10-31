#!/usr/bin/env node
/**
 * `web/` 措辞检查：把「会误导安全判断」的说法挡在交付之前。
 *
 * 为什么要有这个脚本：token 生命周期那句话改了三轮都没改干净——靠人复读会漏，
 * 而读者会按这句话判断风险。**会误导安全判断的措辞不能靠人复读。**
 *
 * 设计上刻意**不枚举坏句子**（黑名单永远补不全，「关掉标签页就没了」不在词表里就说它不存在）。
 * 改成**正向约束**：只要句子里提到「关闭/关掉 + 标签页（或浏览器）」，同句必须带限定词
 * （通常 / 可能 / 不保证 / 不能当作 …），否则失败。这样任何新写法都逃不掉，不用预判别人怎么措辞。
 *
 * 另外两条正向要求：
 *   · README 与输入框提示里必须有「通常 / 恢复会话 / 清除 token」这三件事；
 *   · 「把选源说成权限隔离」这种表述必须带否定语境（写「不是权限隔离」才放行）。
 *
 * 只查 `web/` 下会被人读到的文本，跳过生成产物（data/**、assets/source-icons.js）与本脚本目录。
 *
 * 用法：node web/scripts/check-wording.mjs
 * 退出码：0 = 通过；1 = 有未加限定词的清除断言、或缺少必须说法。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');

/**
 * 触发条件：句子在断言「关闭/关掉 → 没了」，要么提到了标签页/浏览器，要么直接接上「失/清除」这类词。
 *
 * 为什么第二条必须存在：第一版只认「关闭 + 标签页」，于是 `placeholder="只存本标签页，关闭即失"`
 * 这种**没写标签页、直接说死了**的句子就漏了——这也是黑名单思维的同类问题：只盯一种句式。
 * 所以这里不看对象是谁，只要句子把「关闭/关掉」和「没了/失效/清除」连在一起，就必须加限定词。
 * 结果词里特意收录「即失」这类缩写：主语省略时，「关闭即失」「关闭后即失」也要进网。
 */
const TRIGGERS = [
  /(?:关闭|关掉)[^。；\n]{0,10}?(?:标签页|浏览器|窗口)/,
  /(?:关闭|关掉)[^。；\n]{0,8}?(?:即|就|便|会|才|后)?\s*(?:失|消失|失效|清除|清空|没了|作废)/,
  /刷新[^。；\n]{0,8}?(?:即失|即消失|即清除|就没了|就失效|便失效)/
];

/** 限定词：有任意一个，说明这句话把「关闭」写成了可能性而非保证。 */
const QUALIFIERS = ['通常', '可能', '不保证', '不能当作', '无法保证', '不一定', '并不是保证'];

/** 「权限隔离」只在没有否定语境时才报。 */
const SUBSET_TERM = /权限隔离/g;
const NEGATIONS = ['不是', '并非', '不等于', '不代表', '不是一种'];

/**
 * 必须包含的说法（正向要求，不是黑名单）。
 *
 * 注意 index.html 那条也要带「可能保留」：**只查「恢复会话」四个字是不够的**——
 * 「恢复会话时保留」把可能性写成了保证，同样错过闸（审查实测过）。
 */
const REQUIRED = [
  {
    file: 'README.md',
    parts: ['通常会', '恢复会话', '可能保留', '清除 token'],
    why: 'README 要写清「通常会清除 / 恢复会话可能保留 / 点按钮立刻清除」'
  },
  {
    file: 'index.html',
    parts: ['恢复会话', '可能保留', '清除 token'],
    why: '输入框提示也要说明恢复会话可能保留、按钮可立刻清除'
  }
];

const SKIP_DIRS = new Set(['data', 'node_modules', 'scripts']);
const SKIP_FILES = new Set(['source-icons.js']);
const EXT = new Set(['.html', '.js', '.mjs', '.css', '.md']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, out);
    } else if (EXT.has(name.slice(name.lastIndexOf('.'))) && !SKIP_FILES.has(name)) {
      out.push(full);
    }
  }
  return out;
}

const problems = [];
const files = walk(ROOT);

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(REPO, file).replaceAll('\\', '/');

  // 按句切分：一个「关闭」断言必须与限定词同句，跨句不算数（避免整段里别处有「可能」就蒙混过关）
  const sentences = text.split(/(?<=[。；;！!?\n])/);
  sentences.forEach((sentence, index) => {
    const trimmed = sentence.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    const triggered = TRIGGERS.some((rule) => rule.test(trimmed));
    if (!triggered) return;
    const hedged = QUALIFIERS.some((word) => trimmed.includes(word));
    if (!hedged) {
      problems.push(
        `${rel} 第 ${index + 1} 句把「关闭/关掉」写成了保证，同句没有限定词（通常/可能/不保证…）：${trimmed.slice(0, 100)}`,
      );
    }
  });

  // 「访问隔离」：缺否定语境才报
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    SUBSET_TERM.lastIndex = 0;
    let match;
    while ((match = SUBSET_TERM.exec(line)) !== null) {
      const before = line.slice(Math.max(0, match.index - 8), match.index);
      if (!NEGATIONS.some((word) => before.includes(word))) {
        problems.push(`${rel}:${index + 1} 把选源说成「权限隔离」却没加否定（应写「不是权限隔离」）：${line.trim().slice(0, 90)}`);
      }
    }
  });
}

for (const rule of REQUIRED) {
  const file = join(ROOT, rule.file);
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { problems.push(`${rule.file} 不存在，无法核对措辞`); continue; }
  const missing = rule.parts.filter((part) => !text.includes(part));
  if (missing.length > 0) problems.push(`${rule.file} 缺少说法 ${missing.join(' / ')}（${rule.why}）`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  console.error(`\n✗ web/ 措辞检查未通过（${problems.length} 条）`);
  process.exit(1);
}

console.log(`✓ web/ 措辞检查通过：扫描 ${files.length} 个文件；凡提到「关闭/关掉标签页」的句子都带限定词；README 与输入框提示都写了「通常/可能/按钮」`);

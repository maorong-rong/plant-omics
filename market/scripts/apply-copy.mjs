#!/usr/bin/env node
/**
 * 把生成好的卡片文案与图标写进 `market/index.json`。
 *
 * 为什么要有这一步：文案与图标都是「算出来的」（数字来自注册表、图标来自 icon.svg），
 * 手抄进 JSON 迟早抄错或抄旧。这里只做两件事——改 `plugins[0].description` 的中英两段、
 * 写 `plugins[0].icon` 的内联 data URL——其余字段一个字节都不动（原文替换，不重新序列化整个文件，
 * 这样 diff 里只有真正变了的两三行，审查看得清）。
 *
 * 用法：node market/scripts/apply-copy.mjs
 * 前置：node market/scripts/build-copy.mjs && node market/scripts/build-icon.mjs
 * 之后：node market/scripts/check-index.mjs 必须通过
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail } from './card-copy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const INDEX_PATH = join(ROOT, 'market', 'index.json');
const COPY_PATH = join(ROOT, 'market', 'copy.json');
const ICON_PATH = join(ROOT, 'market', 'assets', 'icon.dataurl.txt');

function main() {
  for (const path of [COPY_PATH, ICON_PATH]) {
    if (!existsSync(path)) fail(`缺少 ${path}：先跑 build-copy.mjs 与 build-icon.mjs`);
  }
  const copy = JSON.parse(readFileSync(COPY_PATH, 'utf8'));
  const icon = readFileSync(ICON_PATH, 'utf8').trim();
  let text = readFileSync(INDEX_PATH, 'utf8');
  const before = JSON.parse(text);
  const plugin = before.plugins?.[0];
  if (!plugin) fail('market/index.json 里没有 plugins[0]');

  let changed = [];

  for (const lang of ['en', 'zh']) {
    const current = plugin.description?.[lang];
    const next = copy.description[lang];
    if (current === next) continue;
    if (typeof current !== 'string') fail(`plugins[0].description.${lang} 缺失，无法原地替换；请手工补上再跑`);
    const from = JSON.stringify(current);
    const to = JSON.stringify(next);
    if (!text.includes(from)) fail(`在文件里找不到描述原文（${lang}），格式可能被改过，停止以免写坏`);
    text = text.replace(from, to);
    changed.push(`description.${lang}`);
  }

  if (plugin.icon !== icon) {
    if (typeof plugin.icon === 'string') {
      text = text.replace(JSON.stringify(plugin.icon), JSON.stringify(icon));
    } else {
      // 插在 author 之前：位置无所谓，但固定下来可以让 diff 稳定
      const anchor = '"author":';
      if (!text.includes(anchor)) fail('找不到 "author": 锚点，无法插入 icon；请手工加一行 icon');
      text = text.replace(anchor, `"icon": ${JSON.stringify(icon)},\n      ${anchor}`);
    }
    changed.push('icon');
  }

  if (changed.length === 0) {
    console.log('✓ market/index.json 已是最新，无需改动');
    return;
  }
  writeFileSync(INDEX_PATH, text, 'utf8');

  // 写完立刻自检：解析得回来、字段确实是新值（模板字符串拼错了会在这里露出来）
  const after = JSON.parse(readFileSync(INDEX_PATH, 'utf8')).plugins[0];
  if (after.description.en !== copy.description.en || after.description.zh !== copy.description.zh) {
    fail('写入后读回来的描述与新文案不一致');
  }
  if (after.icon !== icon) fail('写入后读回来的 icon 与 icon.dataurl.txt 不一致');
  console.log(`✓ 已更新 market/index.json：${changed.join('、')}`);
  console.log(`  源 ${copy.counts.sources} / 工具 ${copy.counts.tools}`);
}

main();

#!/usr/bin/env node
/**
 * 市场卡片文案的**取数口径**：发布口径（装上能拿到什么），不是源码口径。
 *
 * 两个口径必须分开，否则就会重演「README 写 8 源 37 工具、装出来 7 源 34 工具」那次翻车：
 *   - 源码口径 = 本地 `dist/` 注册表 → 落地页用它，标「当前源码口径」；
 *   - 发布口径 = `market/index.json` 里 install spec 指向的 npm tarball → **市场卡片用它**，
 *     因为它描述的是用户装完之后手里有什么。
 *
 * 数字的唯一定义在 `scripts/counts.mjs`（`collectPublishedCounts()`，联网解包 tarball 后跑包内
 * `createRegistry()`）。本文件不自己数数，只把它算出来的数字拼成一句话，所以不会出现第二套算法。
 *
 * 联网：`--published` 要下载 npm tarball，按规则不进 `npm test`，只在改市场文案前跑。
 *
 * 用法：node market/scripts/build-copy.mjs
 * 产出：market/copy.json（scope=published）
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { auditSpeciesLabels, cropsFromSpecies, fail, renderCardDescription } from './card-copy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OUT = join(ROOT, 'market', 'copy.json');

async function main() {
  // 物种表只能从源码注册表拿：tarball 里的 dist 只有工具数与 id，没有 manifest.species 之外的展示信息。
  // 用「发布包有哪些源 id」去源码注册表里查这些 id 的 species，两边 id 是同一套，不会串。
  const speciesBySource = await readSpeciesBySource();

  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'counts.mjs'), '--published', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  // 退出码 1 表示「市场索引文案与发布包不一致」——那正是本脚本要修的状态，所以不当作失败；
  // 但只要拿不到可解析的 JSON 就必须失败，不能凭旧数字继续往下写。
  if (run.error) fail(`跑不动 scripts/counts.mjs：${run.error.message}`);
  let published;
  try {
    published = JSON.parse(run.stdout);
  } catch {
    fail(`scripts/counts.mjs --published --json 没有输出可解析的 JSON：\n${run.stdout}\n${run.stderr}`);
  }
  const counts = published.counts;
  if (!counts || typeof counts.sources !== 'number' || typeof counts.tools !== 'number') {
    fail('scripts/counts.mjs --published --json 的输出里没有 counts.sources / counts.tools，接口变了？');
  }

  const publishedIds = counts.perSource.map((source) => source.id);
  const missing = publishedIds.filter((id) => !speciesBySource[id]);
  if (missing.length > 0) {
    fail(`发布包里的源在源码注册表里找不到 species：${missing.join(', ')}（两边 id 对不上，不能推断覆盖物种）`);
  }
  const species = [...new Set(publishedIds.flatMap((id) => speciesBySource[id]))];
  const crops = cropsFromSpecies(species);
  // 反向对账：文案表不能留着源码注册表里已经没有的物种
  auditSpeciesLabels([...new Set(Object.values(speciesBySource).flat())]);

  // 数字短语用 counts.mjs 的渲染，别在这里再写一遍「N 个数据库、M 个工具」。
  const { renderDescriptionClause } = await import(
    pathToFileURL(join(ROOT, 'scripts', 'counts.mjs')).href
  );
  const description = renderCardDescription({ clause: renderDescriptionClause(counts), crops });
  const copy = {
    schemaVersion: 1,
    scope: 'published',
    generatedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    installed: {
      spec: `plantomics-hub@${counts.buildInfo?.packageVersion ?? '未知'}`,
      tarball: published.tarball ?? null,
      integrity: published.integrityVerified ?? null,
      latest: published.latest ?? null,
      builtFrom: counts.buildInfo?.sourceRev ?? null,
      builtAt: counts.buildInfo?.builtAt ?? null,
    },
    counts: {
      sources: counts.sources,
      tools: counts.tools,
      sourceTools: counts.sourceTools,
      metaTools: counts.metaTools,
    },
    sourceIds: publishedIds,
    namedCrops: crops.named,
    description,
    note: '本文件由 market/scripts/build-copy.mjs 生成（发布口径，联网解包 npm tarball），勿手改。',
  };

  writeFileSync(OUT, `${JSON.stringify(copy, null, 2)}\n`, 'utf8');
  console.log(`✓ 已生成 market/copy.json（发布口径）`);
  console.log(`  装的是 ${copy.installed.spec}，包含 ${counts.sources} 源 / ${counts.tools} 工具`);
  console.log(`  源 id：${publishedIds.join(', ')}`);
  console.log(`  zh: ${copy.description.zh}`);
  console.log(`  en: ${copy.description.en}`);
}

/** 源码注册表：源 id → manifest.species（原文）。读 dist/，不读 src/。 */
async function readSpeciesBySource() {
  const entry = join(ROOT, 'dist', 'sources', 'index.js');
  if (!existsSync(entry)) fail('找不到 dist/sources/index.js：先 npm run build（物种表要从源码注册表取）');
  const { createRegistry } = await import(pathToFileURL(entry).href);
  const registry = createRegistry();
  const map = {};
  for (const bundle of registry.listSources()) {
    map[bundle.manifest.id] = [...(bundle.manifest.species ?? [])];
  }
  return map;
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

main().catch((error) => fail(error?.stack ?? String(error)));

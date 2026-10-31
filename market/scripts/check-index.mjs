#!/usr/bin/env node
/**
 * 市场索引检查器（离线）：`market/index.json` 的格式、文案、版本、图标四道关。
 *
 * **口径**：市场卡片描述的是「装上能拿到什么」= 发布口径，不是源码口径。
 * 所以这里比对的对象是 `market/copy.json`（由 `build-copy.mjs` 联网解包 npm tarball 生成），
 * 而不是本地 `dist/` 注册表——本地 8 源 37 工具，发布包 7 源 34 工具，两者本来就不同，
 * 用源码口径去核市场文案只会得到错误的红。
 *
 * 分工：
 *   - 本文件：格式（官方校验器）+ 文案与 copy.json 一致 + 版本/engines 与 package.json 一致 + 图标同步。离线，可进 npm run check。
 *   - `node scripts/counts.mjs --published`：联网重下 tarball 核「copy.json 是否还等于当前发布包」。发布前跑。
 *
 * 用法：
 *   node market/scripts/check-index.mjs
 *   $env:PLANTOMICS_MARKET_VALIDATOR = '<path>/@deepseek-ai/dsh-plugin-market-index/lib/index.js'
 *   （指向官方校验器入口；不给时按包名解析，解析不到就失败——不许静默跳过格式校验）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fail } from './card-copy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const INDEX_PATH = join(ROOT, 'market', 'index.json');
const COPY_PATH = join(ROOT, 'market', 'copy.json');
const ICON_SVG = join(ROOT, 'market', 'assets', 'icon.svg');
const ICON_DATAURL = join(ROOT, 'market', 'assets', 'icon.dataurl.txt');

/** 与官方校验器一致的两条常量。 */
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u;
const MAX_INLINE_ICON_BYTES = 32 * 1024;

const problems = [];
const notes = [];

function check(ok, message) {
  if (!ok) problems.push(message);
  // 必须返回结果：下面 `if (check(...))` 靠它决定要不要继续查内层字段。
  // 早一版这里忘了 return，图标整段校验被静默跳过——负控（改坏图标应报错）才抓出来。
  return ok === true;
}

async function loadValidator() {
  const fromEnv = process.env.PLANTOMICS_MARKET_VALIDATOR;
  if (fromEnv) {
    if (!existsSync(fromEnv)) fail(`PLANTOMICS_MARKET_VALIDATOR 指向的文件不存在：${fromEnv}`);
    return import(pathToFileURL(fromEnv).href);
  }
  try {
    return await import('@deepseek-ai/dsh-plugin-market-index');
  } catch {
    fail(
      '解析不到官方校验器 @deepseek-ai/dsh-plugin-market-index：格式 1 的规则不能自己写一份来替代。\n' +
        '  它是 devDependency（精确锁版本），跑 npm install 即可；\n' +
        '  要临时指向别的版本，用环境变量：$env:PLANTOMICS_MARKET_VALIDATOR = "<路径>/@deepseek-ai/dsh-plugin-market-index/lib/index.js"',
    );
  }
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));

  if (!existsSync(COPY_PATH)) {
    fail('缺少 market/copy.json：先跑 node market/scripts/build-copy.mjs（需联网，解包 npm tarball 取发布口径数字）');
  }
  const copy = JSON.parse(readFileSync(COPY_PATH, 'utf8'));
  if (copy.scope !== 'published') {
    fail(`market/copy.json 的 scope 是 "${copy.scope}"，市场文案必须是 published（源码口径只用于落地页）`);
  }

  const plugins = Array.isArray(index.plugins) ? index.plugins : [];
  const plugin = plugins.find((entry) => entry.name === pkg.name);
  if (!plugin) fail(`索引里没有名为 ${pkg.name} 的插件（package.json 的 name 与索引必须一致）`);

  // ① 文案：必须与发布口径算出来的文本逐字一致
  for (const lang of ['en', 'zh']) {
    const actual = plugin.description?.[lang]?.trim();
    check(
      actual === copy.description[lang],
      `plugins[0].description.${lang} 与 market/copy.json（发布口径 ${copy.installed?.spec}，`
        + `${copy.counts?.sources} 源 / ${copy.counts?.tools} 工具）不一致。\n`
        + `  索引：${actual ?? '（缺）'}\n  期望：${copy.description[lang]}`,
    );
  }

  // ② 版本与发布元数据：索引里的 install spec 必须就是 copy.json 那份
  const versions = Array.isArray(plugin.versions) ? plugin.versions : [];
  const newest = versions[0];
  if (newest) {
    const spec = `${plugin.name}@${newest.version}`;
    check(
      copy.installed?.spec === spec,
      `发布口径取的是 ${copy.installed?.spec ?? '（未知）'}，索引装的是 ${spec}：重跑 build-copy.mjs 让两边一致`,
    );
    const enginesDsh = newest.engines?.dsh;
    check(
      enginesDsh === pkg.engines?.dsh,
      `versions[0].engines.dsh = ${enginesDsh ?? '（缺）'}，package.json 是 ${pkg.engines?.dsh ?? '（缺）'}`,
    );
  }
  check(
    newest !== undefined,
    'versions 为空：索引至少要列一个可安装版本',
  );

  // ③ 图标
  if (check(typeof plugin.icon === 'string', 'plugins[0].icon 缺失：市场卡片没有图标，且图标不必等托管——用内联 data URL')) {
    const match = DATA_ICON.exec(plugin.icon);
    if (check(match !== null, 'plugins[0].icon 不是官方认可的 data URL（只接受 base64 的 svg+png/jpeg/webp）')) {
      const payload = match[1];
      const bytes = Math.floor((payload.length / 4) * 3) -
        (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
      check(bytes <= MAX_INLINE_ICON_BYTES, `plugins[0].icon 解码后 ${bytes} 字节，超过 ${MAX_INLINE_ICON_BYTES} 字节上限`);
    }
    if (existsSync(ICON_DATAURL)) {
      check(
        plugin.icon === readFileSync(ICON_DATAURL, 'utf8').trim(),
        'plugins[0].icon 与 market/assets/icon.dataurl.txt 不一致：改过 icon.svg 就要重跑 node market/scripts/build-icon.mjs',
      );
    } else if (existsSync(ICON_SVG)) {
      notes.push('market/assets/icon.dataurl.txt 不存在，未核对图标与 icon.svg 是否同步');
    }
  }

  // ④ 官方校验器（格式 1 的规则集）
  const { parseMarketIndex, marketInstallTarget } = await loadValidator();
  let parsed;
  try {
    parsed = parseMarketIndex(index, 'https://example.invalid/plantomics/index.json');
  } catch (error) {
    fail(`官方校验器拒绝：${error.path ?? ''} ${error.reason ?? error.message}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exit(1);
  }

  const target = marketInstallTarget(parsed.plugins[0].name, parsed.plugins[0].versions[0]);
  console.log('✓ 官方校验器通过（format 1）');
  console.log(`  安装目标：${target.spec}`);
  console.log(`  卡片口径：发布口径 ${copy.installed?.spec} —— ${copy.counts.sources} 源 / ${copy.counts.tools} 工具（源工具 ${copy.counts.sourceTools} + 元工具 ${copy.counts.metaTools}）`);
  console.log(`  点名物种：${copy.namedCrops.join('、')}`);
  console.log('✓ 索引文案与 copy.json 一致');
  console.log(`✓ 图标：内联 ${plugin.icon.length} 字符，解码 ${Math.floor((DATA_ICON.exec(plugin.icon)[1].length / 4) * 3)} 字节`);
  for (const note of notes) console.log(`  · ${note}`);
  console.log('  下一步（联网）：node scripts/counts.mjs --published —— 重下 tarball 核 copy.json 是否还等于当前发布包');
  console.log('  （索引托管后仍需再核：绝对 URL、可直达、不可重定向、无 query/fragment）');
}

main().catch((error) => fail(error?.stack ?? String(error)));

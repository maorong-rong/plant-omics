#!/usr/bin/env node
/**
 * `GET /catalog` 本地 stub —— 只用来验证「市场页走真实 fetch 路径」。
 *
 * 为什么需要它：以前市场页靠 `window.__PMH_CATALOG__` 注入数据，那验证的是渲染，不是取数。
 * 这个 stub 让页面用**真正的 `fetch('/catalog')`** 拿 JSON，走同一条 HTTP 路径；
 * 上线时把同源地址换成 `https://datamcp.moilab.net` 即可，**渲染逻辑一行都不用改**。
 *
 * 契约（与后端冻结版一致，两边不许各写一套）：
 *   { version, generatedAt, budget:{librarySources,libraryTools,defaultSetTools,defaultSetSoftMax,
 *     defaultSetOverSoftMax,subsetToolsHardMax,estTokensPerTool,subsetToolsHardMaxTokens},
 *     totals:{sources,tools,metaTools},
 *     sources:[{id,name,tier,toolCount,coverage,tools:[…],homepage,lastProbe}] }
 *
 * 场景（query 或环境变量）：
 *   ?time=ok       带 generatedAt（默认）
 *   ?time=header   不带 generatedAt/fetchedAt，只留响应头 Date → 页面应显示「响应时间，非数据生成时间」
 *   ?time=none     连响应头都不给（删除 Date）→ 页面应显示「未知」
 *   ?load=warn     让订阅集超过 40（软建议）
 *   ?load=over     让订阅集超过 80（硬上限）
 *   ?fail=404      返回 404，验证「停在 pending 骨架、不降级快照」
 *
 * 用法：node web/catalog-stub.mjs 8096
 *       # 另开：PLANTOMICS_CATALOG_UPSTREAM=http://127.0.0.1:8096 node web/dev-server.mjs 8094
 */

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || process.env.PLANTOMICS_CATALOG_STUB_PORT || 8096);

/** 8 个源；默认每源工具数之和 + 2 个元工具 = 37，与真实服务一致。 */
const SOURCES = [
  { id: 'strawberry', name: 'Strawberry Data Hub', tier: 'T1', toolCount: 5, coverage: ['Fragaria vesca', 'Fragaria × ananassa'], homepage: 'https://example.org/strawberry' },
  { id: 'wheatomics', name: 'WheatOmics 小麦多组学平台', tier: 'T1', toolCount: 11, coverage: ['Triticum aestivum'], homepage: 'https://example.org/wheatomics' },
  { id: 'gwh', name: 'GWH 基因组仓库（NGDC）', tier: 'T1', toolCount: 2, coverage: ['Taraxacum kok-saghyz'], homepage: 'https://example.org/gwh' },
  { id: 'icg', name: 'ICG 内参基因（NGDC）', tier: 'T1', toolCount: 2, coverage: ['Zea mays'], homepage: 'https://example.org/icg' },
  { id: 'ic4r', name: 'IC4R 水稻信息资源（NGDC）', tier: 'T1', toolCount: 6, coverage: ['Oryza sativa'], homepage: 'https://example.org/ic4r' },
  { id: 'gramene', name: 'Gramene v69', tier: 'T1', toolCount: 4, coverage: ['Oryza sativa'], homepage: 'https://example.org/gramene' },
  { id: 'scod', name: 'SCOD 甘蔗多组学（NGDC）', tier: 'T2', toolCount: 2, coverage: ['Saccharum spontaneum'], homepage: 'https://example.org/scod' },
  { id: 'ensemblplants', name: 'Ensembl Plants（EMBL-EBI）', tier: 'T1', toolCount: 3, coverage: ['Arabidopsis thaliana'], homepage: 'https://example.org/ensemblplants' }
];

const META_TOOLS = ['hub_find_sources', 'hub_status'];

function toolNamesFor(source, count) {
  return Array.from({ length: count }, (_, index) => `${source.id}_tool_${index + 1}`);
}

function buildCatalog({ load }) {
  const sources = SOURCES.map((source) => {
    const count = load === 'over' ? source.toolCount * 3 : load === 'warn' ? source.toolCount * 2 : source.toolCount;
    return {
      ...shapeSource(source),
      toolCount: count,
      tools: toolNamesFor(source, count),
      // 盲区：只返回 5 条、但声明共 9 条 —— 验证「截断必须说出来」
      blindSpots: ['上游未提供版本口径', '仅覆盖已测物种', '大响应会先聚合', '不做批量下载', 'T3 源只登记不实现'],
      blindSpotsTotal: 9,
      lastProbe: '2026-10-31'
    };
  });
  const sourceTools = sources.reduce((sum, source) => sum + source.toolCount, 0);
  const tools = sourceTools + META_TOOLS.length;
  return {
    version: '0.1.0',
    generatedAt: new Date().toISOString(),
    budget: {
      librarySources: sources.length,
      libraryTools: tools,
      defaultSetTools: tools,
      defaultSetSoftMax: 40,
      defaultSetOverSoftMax: tools > 40,
      subsetToolsHardMax: 80,
      estTokensPerTool: 280,
      subsetToolsHardMaxTokens: 80 * 280
    },
    totals: { sources: sources.length, tools, metaTools: META_TOOLS.length },
    sources
  };
}

/**
 * 形状开关：验证「字段名/类型漂了会不会炸」。
 *   STUB_SHAPE=contract（默认，覆盖范围用 coverage 字符串 + 盲区带 total）
 *   STUB_SHAPE=coverage-array（coverage 用数组）
 *   STUB_SHAPE=species-string（老写法：species 是字符串——页面不许因此崩）
 *   STUB_SHAPE=no-coverage（两个字段都不给 → 页面应写「未登记覆盖范围」）
 */
const SHAPE = process.env.STUB_SHAPE || 'contract';

function shapeSource(source) {
  const base = { id: source.id, name: source.name, tier: source.tier, toolCount: source.toolCount, homepage: source.homepage };
  if (SHAPE === 'species-string') {
    return { ...base, species: source.coverage.join('；') };
  }
  if (SHAPE === 'coverage-array') {
    return { ...base, coverage: source.coverage };
  }
  if (SHAPE === 'no-coverage') {
    return { ...base };
  }
  return { ...base, coverage: source.coverage.join('；') };
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname !== '/catalog') {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found', hint: '这个 stub 只提供 /catalog' }));
    return;
  }

  const fail = url.searchParams.get('fail');
  if (fail) {
    res.writeHead(Number(fail) || 500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'stub failure', status: Number(fail) || 500 }));
    return;
  }

  const time = url.searchParams.get('time') || 'ok';
  const load = url.searchParams.get('load') || 'normal';
  const catalog = buildCatalog({ load });
  // budget 字段缺失场景：STUB_BUDGET=none（整块缺）/ partial（只给 subsetToolsHardMax）
  if (process.env.STUB_BUDGET === 'none') delete catalog.budget;
  if (process.env.STUB_BUDGET === 'partial') {
    catalog.budget = { subsetToolsHardMax: 60 };
  }
  if (SHAPE === 'broken') {
    // 200 但形状不对：验证页面「schema 错误单报、不回退骨架」
    catalog.sources = 'oops-not-an-array';
  }
  if (time !== 'ok') delete catalog.generatedAt;

  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  // time=none：连 Date 都不给，验证「都没有 → 未知」
  if (time === 'none') res.sendDate = false;
  if (time === 'header') {
    // 固定一个过去时刻，和浏览器当前时间区分开：页面若显示它，说明取的是响应头
    headers.date = 'Wed, 01 Oct 2026 12:00:00 GMT';
  }

  res.writeHead(200, headers);
  res.end(JSON.stringify(catalog, null, 2));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[catalog-stub] http://127.0.0.1:${PORT}/catalog`);
  console.log('  场景：?time=ok|header|none  ?load=normal|warn|over  ?fail=404');
});

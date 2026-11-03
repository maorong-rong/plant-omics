import type { SourceManifest } from '../../core/types.js';

/**
 * UniProt（UniProt Consortium）蛋白知识库。
 *
 * 定级 T1：文档**正文已取得**——SPA 人读页 `/help/api` 是 6,577 B 空壳，
 * 但同路径加 `.json` 即可拿到结构化正文：
 *   GET https://www.uniprot.org/help/api.json         → 200 / 1,733 B
 *   GET https://www.uniprot.org/help/api_queries.json → 200 / 22,393 B（查询语法全文）
 * ⇒ 「SPA 空壳」不等于「文档不可读」，判定方法是先试 `<同路径>.json`。
 *
 * 反例（防误判）：`rest.uniprot.org/` → 403 nginx、`/help` → 404 nginx。
 * **不能拿 REST 根路径或 `/help` 判可用性**，会误判成"源坏了"。
 */
export const manifest: SourceManifest = {
  id: 'uniprot',
  displayName: 'UniProt 蛋白知识库',
  homepage: 'https://www.uniprot.org/',
  apiBase: 'https://rest.uniprot.org',
  tier: 'T1',
  docs: 'https://www.uniprot.org/help/api.json',
  auth: 'none',
  // 只列已实测覆盖数的物种；其余物种未核，不列。
  species: ['Arabidopsis thaliana', 'Triticum aestivum', 'Oryza sativa', 'Zea mays'],
  network: 'direct',
  probe: {
    // 用最小查询探活：只取 1 条、只取 accession，体积可控（不写 fields 会 44 KB）
    path: '/uniprotkb/search?query=accession:P46290&format=json&size=1&fields=accession',
    expectStatus: 200,
    expect: 'json',
  },
  lastProbe: {
    date: '2026-10-31',
    ok: true,
    status: 200,
    ms: 870,
    note: '调研者实测：search 200（fields 裁剪后 2,787 B）、单条 200 / 4,773 B、空 200 + {"results":[]} 14 B、'
      + '语法错 400 / 103 B。本适配未重新联网，联网检测归 probe。',
  },
  versionNote:
    '上游自报数据版本见响应头 `x-uniprot-release`（调研时观测 2026_03）；本仓不把该值硬编码，'
    + '每次调用从响应头读取，读不到就写未知',
  caveats: [
    '**`fields` 是必须项，不是优化项**：不写它，2 条结果就 44,257 B（15.9 倍）；`size=2` 的物种查询更达 78,534 B。'
      + '本仓请求恒定带 `fields`，参数里不暴露该开关',
    '**`entryType` 必须标**：同一基因常返回多条（`gene:FT AND organism_id:3702` → `Q9SXZ2` reviewed + `A0A1P8AMK0` unreviewed）。'
      + '不标的话用户拿到同一蛋白的两个版本却不知道为什么',
    '**`length` 是氨基酸数，不是碱基数**——组学里单位写错是硬错误。正文明确写"氨基酸"，不写"bp"',
    '**分页是 cursor，不是 offset**：响应头 `x-total-results`（总数）+ `link`（含 cursor 的下一页）。'
      + '本仓**不暴露翻页参数**，正文只给"缩小查询"这一条可执行路径；这不是上游限制，是本仓取舍',
    '**`idmapping` 本批不接，是技术阻塞不是价值判断**：GET 三组组合全 500，POST 一组即 200——'
      + '该端点**只接受 POST**，而公共层目前只发 GET。'
      + '注意这类 `500 + "Internal server error"` **不是服务故障**，是"方法不对"的表现',
    '**`400` 有两种形态，必须分开**：① 检索语法错 `{"url","messages":["query parameter has an invalid syntax"]}` 103 B；'
      + '② accession 格式错 `{"url","messages":["The \'accession\' value has invalid format…"]}` 147 B。两者都是入参问题',
    '**`404` 也有两种含义，按端点区分**（实测）：单条查询 404 = `{"url","messages":["Resource not found"]}` 88 B，'
      + '是**该 accession 不存在**（查无）；根路径 403、`/help` 404 才是路径不存在（nginx HTML）。'
      + '把前者说成"源坏了"会让用户以为服务挂了',
    '**物种覆盖**（`x-total-results` 实测）：拟南芥 54,642 / 小麦 136,740 / 水稻 61,200 / 玉米 105,155 条。'
      + '其余物种未实测，不在白名单内，也不宣称覆盖',
    '空结果是 `200 + {"results":[]}` + `x-total-results: 0`（**14 B**）——有明确计数头，'
      + '所以能确定地说"命中 0 条"，不像 STRING 那样必须并列两种可能',
    '不接：序列分析、结构预测、批量 ID 映射（`idmapping` 见上）、TSV/XML/FASTA 其它格式',
    '**`secondaryAccession` 本批不支持**（诚实降级，不是漏做）：本仓单条查询要求返回的 `primaryAccession` '
      + '与请求值逐字相等，因此**拿 secondary accession（如 `Q96C63`）去查会被拒答**。'
      + '实测上游对此会返回 303 指向 canonical（`Location: /uniprotkb/Q99999?from=Q96C63`），'
      + '但公共层 `redirect: "follow"` 会把最终地址吞掉，源层拿不到这条凭据，'
      + '而"最终地址里带 from="本身也不能单独证明记录身份（它可能只是来源参数）。'
      + '⇒ **建议先用 `uniprot_search_proteins` 拿到 primary accession 再用本工具。**',
  ],
};

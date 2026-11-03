# `GET /catalog` 契约（v1 · 2026-11-01）

> 定位：**市场首屏与订阅集计数的唯一运行时数据源**。只读、免鉴权、不含任何凭据。
> 归属：契约由 plantomics后端负责人定（`/mcp` 同属对外契约面）；实现由代码改动者写；页面由前端线按本文件接。
> 冲突处理：本文件与页面实现不一致时**以本文件为准**，改契约必须走后端负责人。

## 一、为什么要有它

`site/data/catalog.json` 是**构建快照**，源一改就得手动重建。市场页要算「选中的源 → 工具总数 → 超 40 警示 / 超 80 拒绝」，算错就是给用户装了个调不动的集合。所以源级聚合必须**由运行中注册表实时生成**。

## 二、请求

```
GET /catalog
```
- **免鉴权**（源清单本属公开信息，README 已有工具表）
- 不支持方法 → `405`
- 不读请求体、不看 `x-plantomics-sources`（本端点永远返回全库视图）

响应头：
- `Content-Type: application/json; charset=utf-8`
- `Cache-Control: public, max-age=60`
- `ETag: "<内容哈希>"`
- `Date`：服务器时刻。**页面显示的「数据时刻」必须取它或取 `generatedAt`，不许取浏览器时钟**

## 三、响应结构

```jsonc
{
  "version": "0.1.0+svc.6.g6a7a7ff",   // 服务端版本，与 /healthz 的 version 一致
  "generatedAt": "2026-11-01T04:12:00.000Z",  // ISO8601 UTC

  "totals": { "sources": 8, "tools": 37, "metaTools": 2 },

  "budget": {
    "defaultSources": ["wheatomics", "gramene", "ensemblplants", "ic4r", "strawberry", "gwh", "icg"],
                                        // 默认推荐集包含的源 id，顺序即推荐顺序；页面初始选中必须照它
    "defaultSetTools": 35,              // 不带订阅头时实际下发的工具数（= 清单内源工具 + 元工具）
    "defaultSetSoftMax": 40,            // 软建议；超了只警示
    "defaultSetOverSoftMax": false,     // 上一条的直接结论，页面直接用，别自己比
    "subsetToolsHardMax": 80,           // 唯一硬阈值；超了服务端 400
    "estTokensPerTool": 280,            // 实测 37 工具 10,274 token 折算
    "subsetToolsHardMaxTokens": 22400   // 80 × 280，给页面预估用
  },

  "sources": [
    {
      "id": "wheatomics",
      "name": "WheatOmics",
      "tier": "T1",
      "toolCount": 11,
      "coverage": "小麦族；…盲区一句话写清",
      "tools": ["wheatomics_search_known_genes", "…"],
      "homepage": "http://wheatomics.sdau.edu.cn/",
      "lastProbe": { "date": "2026-10-31", "ok": true, "status": 200, "ms": 790 }
    }
  ]
}
```

### 与前端草案的两处不同（唯一真相在此）

1. **`budget.librarySources` / `budget.libraryTools` 取消**，改用 `totals.sources` / `totals.tools`。同一个数字在响应里出现两次，下次一定不一致——今天我们已经在 `/healthz`、`npm run stats`、面板三处踩过这个坑。
2. **新增 `budget.defaultSetOverSoftMax`**，页面不要自己拿 `defaultSetTools > defaultSetSoftMax` 再判一次。

## 三.1、v1.2 新增：给用户看的字段（2026-11-03 本涛定的三条）

**本涛的三条要求**：① 数据库说明不要讲「多少个 tools」，要讲「支持哪些服务」；② 不要把「缺失/盲区」写进页面；③ 源名与内部代号改成大众熟悉的叫法。

**处置原则**：**数据不动、呈现变**。`toolCount`、`coverage`、`blindSpots` 仍然下发（内部统计与检索层要用），但**页面一个字都不展示**；新增给人看的字段，规则如下。

```jsonc
{
  // 顶层新增：全局服务字典，只有一份
  "servicesCatalog": [
    { "key": "gene",         "label": "基因查询",   "hint": "按基因 ID 或名称取注释" },
    { "key": "expression",   "label": "表达谱",     "hint": "组织或处理下的表达量" },
    { "key": "variant",      "label": "变异查询",   "hint": "区间内的变异位点" },
    { "key": "interaction",  "label": "互作网络",   "hint": "蛋白互作伙伴" },
    { "key": "homology",     "label": "同源与共线", "hint": "跨物种对应关系" },
    { "key": "id-convert",   "label": "编号换算",   "hint": "不同数据库的 ID 互转" },
    { "key": "sequence",     "label": "序列",       "hint": "基因组或蛋白序列" },
    { "key": "taxonomy",     "label": "物种分类",   "hint": "覆盖与分类单元信息" },
    { "key": "genome",       "label": "基因组与装配", "hint": "基因组版本、组装级别与下载入口" },
    { "key": "sample-meta",  "label": "项目与样本", "hint": "项目号、样本号及其元数据" }
  ],

  "sources": [
    {
      "id": "wheatomics",                                  // 内部 id，前端只做 key，不上页面
      "displayName": "小麦多组学平台（WheatOmics）",        // 大众称呼，上页面
      "services": ["gene", "expression", "variant"],        // 服务 key 数组，上页面
      "species": ["小麦", "硬粒小麦", "节节麦"],            // 中文物种名，上页面
      "tier": "T1",                                        // 保留，页面要翻成人话或不上
      "toolCount": 11,                                     // 内部统计，页面不展示
      "coverage": "…",                                     // 内部，页面不展示
      "blindSpots": "…",                                   // 内部，页面不展示
      "tools": ["wheatomics_search_known_genes", "…"]      // 内部，页面不展示
    }
  ]
}
```

**四条硬规则（实现方按这个写，审查按这个核）**

1. **`services` 只允许字典里存在的 key**，每个源 `services` 必须非空。**全局字典只有一份在顶层**，源只引用 key——否则同一个能力在不同源上会写成「基因查询 / 基因信息 / 基因注释」，用户以为是不一样的东西。
2. **`services` 必须由 manifest 显式声明，不许从工具名推断**。推断会造出"这个源支持变异查询"而实际只有数据集目录的假象。**宁可少列：列了一个查不到的服务，比不列更伤。**
3. **`species` 用中文常用名**（小麦、水稻、拟南芥、玉米、甘蔗、草莓…）。**真相仍是 manifest 里的拉丁名**（给检索层与物种核验用），中文名是**呈现层翻译**：映射表放**单一文件** `src/service/species-names.ts`，不许散落在各源。**新增源若带来映射表里没有的物种，`createRegistry()` 直接拒绝启动**（与 budget 门禁同级），并有离线断言——不许默默回落到拉丁名，也不许在请求期抛 500。
4. **`displayName` 格式：`中文常用名（原名简称）`**，例如「蛋白互作数据库（STRING）」「水稻信息平台（IC4R）」。原名只作括注，不做主标题。

**`generatedAt` 语义同时收紧**：它是**数据生成时刻**，不是请求时刻。实现上取「注册表快照时刻」（服务启动时冻结，注册表变更时更新），不再每请求 `new Date()`。这既符合语义，也让 ETag 稳定——两件事本来就该是同一个原因。

## 四、一致性铁律（四条，缺一条不算通过）

1. **工具集合逐一相等**：`union(sources[].tools) ∪ metaToolNames` **必须等于** `tools/list` 返回的全集。元工具（`hub_find_sources`、`hub_status`）不进任何 `sources[]`，只计入 `totals.metaTools`——所以「选 2 个源的 4 个工具」实际下发 **6 个**，页面算 token 必须把元工具算进去。
2. **三处数字同源**：`/catalog.totals` = `/healthz` 的 `sources/tools/metaTools` = `npm run stats` 的读数。
3. **阈值只有一个来源**：`subsetToolsHardMax` 必须直接取 `budget.ts` 的 `SUBSET_TOOLS_HARD_MAX`，`defaultSetSoftMax` 取 `DEFAULT_SET_TOOLS_SOFT_MAX`。**禁止在 catalog 里写字面量 80/40**。
4. **默认集可被页面复算**：`budget.defaultSources` 必须逐项来自 `budget.ts` 的 `DEFAULT_SET_SOURCES`（顺序照抄），且 `defaultSetTools` **必须等于**「这些源的工具数之和 + `totals.metaTools`」。页面初始选中态、全选态一律照 `defaultSources` 来，**不许自己全选所有源**——全库 41 而默认 35，页面若全选就必然谎报"默认会报警"。

> 前端注意：**作用范围是 `web/` 与 `site/`（所有页面源，以实际发布的那份为准）**——此前只写 `web/`，结果"检查挡的是不发布的那份，放过真正上线的那份"（`site/assets/market.js` 带 `40`/`80`/`280` 字面量而 `web/` 干净，按旧条文核反而判合规）。
>
> **判据不看"字符串有没有出现"，看"页面实际取值从哪里来"**：页面上显示的阈值、默认集、token 估算，必须能追溯到本次 `/catalog` 响应的对应字段；字段缺失时**不许用自带常量兜底假装正常**——必须进入显式不可判定态（阈值显示 `—`、禁用开始），否则一旦删掉兜底常量，`undefined` 参与比较会让"超限告警/拒绝"全部变成 `false`，页面看起来一切正常。
>
> 为什么措辞要改这么细：曾经出现过兜底常量与响应取值**恰好相同**（`40`/`80`/`280`），当天删不删页面都一模一样，只有将来把阈值调成别的数才会分叉——这属于静默失效，凭页面观感验收不出来。这条由前端审查者按本文件核，不由实现自己声明"已改"。

## 五、禁止项

- 不返回工具 `inputSchema`、不返回上游 URL 模板、不返回 `TOKEN`/`/etc/plantomics-hub/env` 任何值。
- 不返回 `HISTORICAL_SOURCE_LIMIT` / `MAX_SOURCES` / `MAX_TOOLS` 这类**已废止**的历史常量（v2.3 起只作注释保留）。
- 不读 `site/data/catalog.json` 快照。
- 不为了"字段齐"编造 `coverage`；取不到就写「未登记覆盖范围」，不要留空，也不要写"支持全部物种"。

## 六、验收（实现方交付时必须逐条贴输出）

| # | 断言 |
|---|---|
| 1 | `GET /catalog` → 200，字段与类型齐全 |
| 2 | `union(sources[].tools)+metaTools` 与 `tools/list` 集合逐一相等（不是子集，不是数量相等） |
| 3 | 同一时刻 `/catalog`、`/healthz`、`stats` 三处数字一致 |
| 4 | **负控**：把 `SUBSET_TOOLS_HARD_MAX` 改成 81 编译后，`/catalog` 报 81（证明没有第二处字面量）；改回 |
| 5 | 响应全文不含 token 字样、不含 env 值 |
| 6 | `POST /catalog` → 405 |
| 7 | `generatedAt` 在同一注册表状态下**恒定**（连续两次请求相同）；它与 `Date` **不必**接近——`Date` 是响应时刻，`generatedAt` 是注册表快照时刻，两者语义不同，页面也不得把二者的差当"数据新鲜度" |
| 8 | 不带 `x-plantomics-sources` 与带上它，`/catalog` 输出**完全相同**（本端点不看订阅头） |

## 七、不做

- 不做用户账号与订阅持久化（服务无状态，订阅集走请求头，这是既定架构）
- 不做工具 schema 下发（那是 `tools/list` 的职责，重复等于两份契约）
- 不做历史趋势与缓存落盘

---

变更记录：

| 日期 | 变更 | 依据 |
|---|---|---|
| 2026-11-01 | 初版：定字段、三条一致性铁律、八条验收；与前端草案两处差异（去 library*、加 defaultSetOverSoftMax） | 本涛 2026-11-01「推进 /catalog」；前端已冻结草案，本文件为其权威版本 |
| 2026-11-03 | v1.1：新增 `budget.defaultSources`（默认清单源 id，顺序即推荐顺序），一致性铁律加第 4 条「默认集可被页面复算」；明确 `web/` 不得写阈值字面量与读已取消的 `budget.tools` | 默认推荐集改为显式清单（7 源 35 工具、全库 41）后，页面否则无法知道"默认"是哪些源；由后端负责人定 |
| 2026-11-03 | v1.2：服务字典补 `genome`（基因组与装配）、`sample-meta`（项目与样本），gwh 不再无处归类；`species` 明确「真相是 manifest 拉丁名、中文是单文件映射、缺映射拒绝启动」；验收第 7 条改为「`generatedAt` 恒定」，取消「与 `Date` 相差 < 2 s」这条自相矛盾的要求 | 源适配者实测 `SourceManifest` 无 `publicName`、gwh 无字典项；对抗审查者指出冻结的 `generatedAt` 不可能永远贴近响应 `Date`；由后端负责人定 |
| 2026-11-03 | v1.3：前端注意的作用范围从 `web/` 扩到 `web/` 与 `site/`，判据从"字符串是否出现"改为"页面实际取值从哪里来"；明确字段缺失必须进入显式不可判定态，不许用自带常量兜底 | 前端审查者实测：`site/assets/market.js:22-24` 有 `40/80/280` 字面量、`web/` 已清干净，而旧条文只写 `web/`，等于挡了不发布的那份；线上 `/catalog` 三个兜底字段与响应取值恰好相同，属静默失效；由后端负责人定 |

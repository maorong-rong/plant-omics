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

## 四、一致性铁律（四条，缺一条不算通过）

1. **工具集合逐一相等**：`union(sources[].tools) ∪ metaToolNames` **必须等于** `tools/list` 返回的全集。元工具（`hub_find_sources`、`hub_status`）不进任何 `sources[]`，只计入 `totals.metaTools`——所以「选 2 个源的 4 个工具」实际下发 **6 个**，页面算 token 必须把元工具算进去。
2. **三处数字同源**：`/catalog.totals` = `/healthz` 的 `sources/tools/metaTools` = `npm run stats` 的读数。
3. **阈值只有一个来源**：`subsetToolsHardMax` 必须直接取 `budget.ts` 的 `SUBSET_TOOLS_HARD_MAX`，`defaultSetSoftMax` 取 `DEFAULT_SET_TOOLS_SOFT_MAX`。**禁止在 catalog 里写字面量 80/40**。
4. **默认集可被页面复算**：`budget.defaultSources` 必须逐项来自 `budget.ts` 的 `DEFAULT_SET_SOURCES`（顺序照抄），且 `defaultSetTools` **必须等于**「这些源的工具数之和 + `totals.metaTools`」。页面初始选中态、全选态一律照 `defaultSources` 来，**不许自己全选所有源**——全库 41 而默认 35，页面若全选就必然谎报"默认会报警"。

> 前端注意：`web/` 里**不得出现阈值字面量**（`80`/`40`）与 `budget.tools`（已取消）。阈值与默认集一律从 `/catalog` 现读；这条由前端审查者按本文件核，不由实现自己声明"已改"。

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
| 7 | `Date` 头与 `generatedAt` 同一请求内相差 < 2 s |
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

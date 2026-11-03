# `web/screenshots/` 截图（真实渲染，不是设计稿冒充）

生成方式：无头 Chrome + CDP，**真实加载页面**后截图；视口宽度精确设定（`Emulation.setDeviceMetricsOverride`），
不是 `chrome --screenshot`（那种会被 Windows 最小窗口宽度顶住，截出来的「窄屏」其实是宽布局被裁）。

**2026-11-02 起源市场页在 `site/market.html`**（原 `web/market-sketch.html`，已删除）。所以：
- 审查者手里那组按 `web/market.js` 冻结的 sha **全部作废**（路径和内容都变了），要重新取；
- 本目录的 PNG 仍留在这里——它们是证据，不是发布物，不随 `site/` 上线；
- 页面走 `fetch('/catalog')`，本地**必须显式开反代**才有数据，见「重新生成」。

## 源市场（`site/market.html`，走真实 `fetch('/catalog')`）

**取数方式**：页面只发同源 `fetch('/catalog')`；**没有注入通道、也没有「读不到就退回构建期快照」的降级**。
本地由 `site/scripts/serve.mjs --catalog-upstream <url>` 显式反代（默认关闭，不开就 404），把同源地址换成
`https://datamcp.moilab.net` 时渲染逻辑一行不用改。

| 文件 | 视口 | 主题 | 状态 | 数据来自 |
|---|---|---|---|---|
| `market-live-1440.png` | 1440 | 浅色 | 正常：9 张源卡，订阅集未选 | **本机 `dist/service` 的真实 `/catalog`**（经 `--catalog-upstream`，9 源 / 39 工具） |
| `market-live-375.png` / `-320.png` | 375 / 320 | 浅色 | 同上，单列；两档均无横向溢出 | 同上 |
| `market-live-dark-1440.png` | 1440 | 暗色 | 同上 | 同上 |
| `market-pending-1440.png` / `-375` / `-320` / `-dark-1440` | 1440/375/320/1440 | 浅色/暗色 | `/catalog` 404 → 停在骨架，**所有数字位「待 /catalog」** | 真实 404（`serve.mjs` 未开反代） |
| `market-threshold-warn.png` | 1440 | 浅色 | 全选 8 源 → 72 工具 ≈ 20 160 token，黄色警示（仍可用） | `web/catalog-stub.mjs` + `?stub=warn` |
| `market-threshold-refuse.png` | 1440 | 浅色 | 全选 8 源 → 107 工具 ≈ 29 960 token，红色拒绝，按钮禁用并写「还差 27 个」 | `web/catalog-stub.mjs` + `?stub=over` |

**这一轮实测出的两件事（截图里看得见）**：

- 本机 `dist/service` 的 `/catalog` 仍是 **`coverage` 整串 string、没有 `blindSpots`**——所以 live 截图里覆盖范围渲染成
  「覆盖物种：Triticum aestivum」一整块、卡片上没有「盲区」一组。这不是前端不肯画：同一份 `market.js` 在 stub 数据
  （`coverage: string[]` + `blindSpots`)下就正常出标签和「盲区 9 · 另有 4 条」（见 threshold 两张）。
  即 FE-01 的字段问题**在本机实现里同样存在**，不是「线上旧版本」独有。
- `STRING` 卡片图标是 `?` 占位：`site/assets/source-icons.js` 只有 8 条，`src/core/source-icons.json` 还没有 `string`。
  生成器会因缺图标非零退出，所以图标补齐与重新生成数据是同一件事。

**数字来源标**：工具数标 `/catalog`；token 标「推算 · 工具数 × 280」；**阈值 40 / 80 也标「来自 /catalog」**——
取自 `budget.defaultSetSoftMax` / `budget.subsetToolsHardMax`，页面不写死。
**覆盖范围**：`coverage` 与 `species` 两种字段名、`string` 与 `string[]` 两种类型都读；都没有时写「未登记覆盖范围」。
**盲区截断**：`blindSpotsTotal > 已返回条数` 时显示「另有 N 条」，展开后写「盲区原文（5 / 共 9）」，**截断必须说出来**。
**数据时刻**：`generatedAt` → `fetchedAt`（标「来自 /catalog」）→ 响应头时间（标「响应时间，非数据生成时间」）→ 都没有则「未知」；
**不用浏览器时钟兜底**。
**200 不回退骨架**：字段形状不对时留在原页显示红色「响应 200，但字段与契约不符…」，**不伪装成「GET /catalog 未就绪」**。

## 落地页（`site/index.html`）

| 文件 | 视口 | 说明 |
|---|---|---|
| `site-hero-market-1440.png` | 1440 | 首屏：**「打开源市场」是主按钮**（绿底、排第一），后面才是「快速开始」「看能查哪些源」；按钮下多一句说明 |
| `site-hero-market-390.png` | 390 | 同上，窄屏三个按钮仍一行排下，导航五项不溢出 |
| `site-hero-market-en-1440.png` | 1440 | 英文态（`?lang=en`）：`Open the source market` / `Get started` / `See coverage` |
| `site-1440.png` | 1440 | 全页；统计条显示 **8** 与 **37**（见下方「口径待重生成」） |
| `site-top.png` | 1440 | 旧版首屏（无市场入口），保留作对照 |

**口径待重生成（已知不一致，未擅自改）**：`site/data/catalog.*` 仍是 `commit 54ef8dd` 干净构建的 **8 源 / 37 工具**，
而当前 `dist/` 是 `022c723-dirty`、`npm run stats` 报 **9 源 / 39 工具**。`build-data.mjs` 默认拒绝在 `-dirty` 构建上生成，
所以本轮没有重跑：要么给一次干净 `022c723` 构建，要么显式 `--allow-dirty`（页面会挂「工作区构建，非发布口径」红条）。

## 试调页（`web/index.html`，本机实例上的真实 MCP 会话）

**证据层级要说准**：这些是**本机 `http://127.0.0.1:8094` 实例**（`dist/service/cli.js` + `web/dev-server.mjs` 同源反代）上的完整会话，
**不是线上 `datamcp.moilab.net`**。线上同源验证要等部署线把新前端上线后才有，那条现在记**未做**。

请求序列实测为 `initialize → notifications/initialized → tools/list`；token 只在请求头。

| 文件 | 视口 | 主题 | 订阅集 | 顶栏与请求预览 | 服务端返回 |
|---|---|---|---|---|---|
| `try-full-37tools-1440.png` | 1440 | 浅色 | 无（= 全集） | 「服务正常 · 8 源 / 37 工具」；预览无子集头 | 37 个工具 |
| `try-subset-6tools-1440.png` | 1440 | 浅色 | `icg,scod` | 「订阅集 icg,scod · 本页只装 6 个工具（含 2 个 hub_*）」 | 6 个工具 |
| `try-subset-6tools-375.png` / `-320.png` | 375 / 320 | 浅色 | 同上 | 同上 | 同上 |
| `try-subset-6tools-dark-1440.png` | 1440 | 暗色 | 同上 | 同上 | 同上 |

> 这批是 `54ef8dd`（8 源 37 工具）时期拍的；试调页仍在 `web/`，未随 `site/` 发布。

## 重新生成

```bash
# 1) 源市场待取态（真实 404，不需要任何服务）
node site/scripts/serve.mjs 8091
node site/scripts/shot.mjs --url 'http://127.0.0.1:8091/market.html?theme=light' \
  --out web/screenshots/market-pending-1440.png --width 1440 --full

# 2) 源市场实时态：本机服务 + 显式反代（两端口，先起服务再起站）
node dist/service/cli.js                      # 或 PLANTOMICS_HUB_PORT=8795 node dist/service/cli.js
node site/scripts/serve.mjs 8093 --catalog-upstream http://127.0.0.1:8787
node site/scripts/shot.mjs --url 'http://127.0.0.1:8093/market.html?theme=light' \
  --out web/screenshots/market-live-1440.png --width 1440 --full

# 3) 阈值两态：stub 供数（8 源，按 query 放大每源工具数）
node web/catalog-stub.mjs 8096
node site/scripts/serve.mjs 8097 --catalog-upstream http://127.0.0.1:8096
# 页面内全选后才触发阈值；用 CDP 脚本点全选再整页截图（本机留档：C:\Temp\pmh\mk-threshold.mjs）
```

**注意**：`?stub=warn|over|fail` 是页面自己的调试开关，会转成 `/catalog?load=…` / `?fail=…`；
不带 `?stub=` 时页面只发 `fetch('/catalog')`，线上不会出现这些参数。

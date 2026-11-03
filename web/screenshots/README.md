# `web/` 截图（真实渲染，不是设计稿冒充）

生成方式：无头 Chrome + CDP，**真实加载页面**后截图；视口宽度精确设定（`Emulation.setDeviceMetricsOverride`），
不是 `chrome --screenshot`（那种会被 Windows 最小窗口宽度顶住，截出来的「窄屏」其实是宽布局被裁）。

## 市场首屏（`market-sketch.html`，走真实 `fetch('/catalog')`）

**取数方式**：页面只发 `fetch('/catalog')`（同源相对路径），本地由 `web/catalog-stub.mjs` 提供数据、经 `web/dev-server.mjs` 反代；
**没有注入通道、也没有「读不到就退回构建期快照」的降级**。把同源地址换成 `https://datamcp.moilab.net` 时渲染逻辑一行不用改。
截图页面上方有橙色提示，写的是「调试参数 `?stub=`：本页请求带调试 query…数据是否来自线上服务，取决于你连的是哪个服务端」——它只描述本页发了什么参数，不断言上游，所以在任何环境下都不假。

| 文件 | 视口 | 主题 | 状态 | 数据 |
|---|---|---|---|---|
| `market-live-1440.png` | 1440 | 浅色 | 正常（选 `icg,scod` → 2 源 / 6 工具 / ≈1 680 token） | stub `?stub=ok`（8 源 37 工具，`totals.metaTools=2`） |
| `market-live-375.png` | 375 | 浅色 | 同上 | 同上 |
| `market-live-320.png` | 320 | 浅色 | 同上 | 同上 |
| `market-live-dark-1440.png` | 1440 | 暗色 | 同上 | 同上 |
| `market-threshold-warn.png` | 1440 | 浅色 | 订阅集 > 40 → 黄色警示（仍可用） | stub `?stub=warn`（每源工具数 ×2） |
| `market-threshold-refuse.png` | 1440 | 浅色 | 订阅集 > 80 → 红色拒绝 + 「开始使用」禁用 | stub `?stub=over`（每源工具数 ×3） |
| `market-pending-1440.png` / `-375` / `-320` / `-dark-1440` | 1440/375/320/1440 | 浅色/暗色 | `/catalog` 404 → 停在骨架，**不降级快照** | 真实 404（stub `?stub=fail`） |

**数字来源标**：工具数标 `/catalog`；token 标「推算 · 工具数 × 280」；**阈值 40 / 80 也标「来自 /catalog」**——它们取自 `budget.defaultSetSoftMax` / `budget.subsetToolsHardMax`，页面不自己写死（契约第 1 条：阈值只有一个来源）。
**覆盖范围**：`coverage` 与 `species` 两种字段名、`string` 与 `string[]` 两种类型都读；两者都没有时写「未登记覆盖范围」（契约文档 §:75 的原话），不留空、也不写成「支持全部物种」。
**盲区截断**：stub 返回 5 条 + `blindSpotsTotal: 9`，卡片显示「盲区 9」并加「另有 4 条」，展开后写「盲区原文（5 / 共 9）」——**截断必须说出来**。
**数据时刻**：`generatedAt` → `fetchedAt`（标「来自 /catalog」）→ 响应头时间（标「响应时间，非数据生成时间」）→ 都没有则「未知」；**不用浏览器时钟兜底**。
**200 不回退骨架**：字段形状不对（如 `sources` 不是数组）时，页面留在原页并显示红色「响应 200，但字段与契约不符…」，**不伪装成「GET /catalog 未就绪」**。

## 落地页（`site/index.html`，v2.3 口径重截）

| 文件 | 视口 | 说明 |
|---|---|---|
| `site-1440.png` | 1440 | 全页；统计条只显示 **8** 与 **37**，不再挂 `/20`、`/40` |
| `site-top.png` | 1440 | 首屏；口径句写「全库只报数、不设上限；订阅集 ≤ 80 是硬阈值」 |

构建身份同上：`dist/` 是 `54ef8dd` 干净构建（8 源 / 37 工具），落地页数据由 `site/scripts/build-data.mjs` 从
`dist/core` 与 `scripts/counts.mjs --json` 生成，快照行写明 `commit 54ef8dd`。站点上线后字节数为 **32,149 B**，与旧值 32,096 不同。

## 试调页（`index.html`，本机实例上的真实 MCP 会话）

**证据层级要说准**：这些是**本机 `http://127.0.0.1:8094` 实例**（`dist/service/cli.js` + `web/dev-server.mjs` 同源反代）上的完整会话，
**不是线上 `datamcp.moilab.net`**。线上同源验证要等部署线把新前端上线后才有，那条现在记**未做**。

请求序列实测为 `initialize → notifications/initialized → tools/list`；token 只在请求头。

**构建身份**：页脚现在写 `commit 54ef8dd · … · build 54ef8dd`，**不再有 `-dirty`**。
做法：用 `git archive HEAD`（HEAD = `54ef8dd`）导出干净树到临时目录、链接同一份 `node_modules`、在那里 `npm run build`，再把它产出的 `dist/` 覆盖本地 `dist/`（可再生件）。
**一处要说明**：归档树没有 `.git`，构建脚本 `sourceRevision()` 取不到 sha 会记 `unknown`，所以 `build-info.json` 里的 `sourceRev` 是按归档来源的 commit 写的 `54ef8dd`——树内容就是该 commit，未掺入任何工作区改动。

| 文件 | 视口 | 主题 | 订阅集 | 顶栏与请求预览 | 服务端返回 |
|---|---|---|---|---|---|
| `try-full-37tools-1440.png` | 1440 | 浅色 | 无（= 全集） | 「服务正常 · 8 源 / 37 工具」；预览无子集头 | 37 个工具 |
| `try-subset-6tools-1440.png` | 1440 | 浅色 | `icg,scod` | 「订阅集 icg,scod · 本页只装 6 个工具（含 2 个 hub_*）；服务端全集 8 源 / 37 工具」；预览含 `x-plantomics-sources: icg,scod` | 6 个工具（2×2 源工具 + `hub_find_sources`/`hub_status`） |
| `try-subset-6tools-375.png` | 375 | 浅色 | `icg,scod` | 同上 | 同上 |
| `try-subset-6tools-320.png` | 320 | 浅色 | `icg,scod` | 同上 | 同上 |
| `try-subset-6tools-dark-1440.png` | 1440 | 暗色 | `icg,scod` | 同上 | 同上 |

页脚在子集态会写「浏览用快照 commit … ｜ 当前订阅集 icg,scod，工具清单以服务端 tools/list 为准」——
把「浏览用的构建期快照」和「这一页实际装了几个工具」分成两句话，避免三个数字三个口径。

## 重新生成

```bash
# 市场页（/catalog 未上线时的真实状态）
node site/scripts/shot.mjs --url 'http://127.0.0.1:8094/market-sketch.html?theme=light' \
  --out web/screenshots/market-pending-1440.png --width 1440

# 试调页（需先起服务与同源 dev server，见 web/README.md）
node web/dev-server.mjs 8094   # 另开：node dist/service/cli.js（带 PLANTOMICS_HUB_TOKEN）
```

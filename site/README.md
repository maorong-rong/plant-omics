# `site/` —— 项目站点（落地页 + 源市场页）

一站两页，都是纯静态、零依赖、不引外部字体或 CDN：
- `index.html` 落地页：一页说清「这是什么、能查什么、怎么接进来」（接入只写两档），给导师会、投稿附件与外部访客看，也是 `web/` 的措辞来源。
- `market.html` 源市场页：按需订阅源，读运行中的 `GET /catalog`（2026-11-02 从 `web/market-sketch.html` 迁入）。

## 1. 怎么跑

```bash
# 1) 先构建，数据从 dist/ 的注册表读（不是 src/）
npm run build

# 2) 生成数据（会顺带跑一次 scripts/stats.mjs 对账）
node site/scripts/build-data.mjs

# 3) 起静态服务
node site/scripts/serve.mjs 8091     # 落地页 → http://127.0.0.1:8091/
```

`site/data/catalog.js` 就是渲染用的数据；用 `file://` 直开也能看到内容（脚本不是 `fetch`，是 `<script>` 注入）。

### 源市场页要 `/catalog`：显式反代开关

`serve.mjs` 默认**只发静态文件**，`fetch('/catalog')` 会 404 —— 市场页于是停在「待 /catalog」骨架。
这是本地真实状态，别把「骨架能渲染」说成「同源跑通」。

要验真实取数，用**显式**开关（只反代 `/catalog` 这一条路径，含 query；其它路径照旧走静态）：

```bash
# 另开一个终端：起本机服务（端口别用 8790/8792，那是 DSH 自己占的）
$env:PLANTOMICS_HUB_PORT='8795'; node dist/service/cli.js

node site/scripts/serve.mjs 8093 --catalog-upstream http://127.0.0.1:8795
# → http://127.0.0.1:8093/market.html
```

启动时会打一行 `⚠ 本地反代已开启：/catalog → …`；不打开关时也会明说「`/catalog` 未反代，市场页将停在骨架」。
它不读任何凭据、只监听回环地址、**不上生产**。

### 脏构建防线（`-dirty` 默认拒绝生成）

`dist/` 是**可变共享目录**：谁跑一次 `npm run build`，`dist/service/build-info.json` 的 `sourceRev` 就变一次。
它以 `-dirty` 结尾时，说明这份产物来自**未提交的工作区**——里面可能有未过审的源。

所以 `build-data.mjs` **默认拒绝在 `-dirty` 构建上生成**（非零退出，并说明先用干净 HEAD 构建）。
**身份读不出来也一样拒绝**：`dist/service/build-info.json` 缺失、不是合法 JSON、或没有 `sourceRev` 时，
生成器不猜「大概没事」——不知道这份 `dist` 从哪来，比知道它脏更没底。
要生成必须显式加逃生口：

```bash
node site/scripts/build-data.mjs --allow-dirty   # 仅供本地看渲染
```

放行时数据里写 `build.dirty: true`，页面顶部显示「**工作区构建，非发布口径**」——不许静静地产出一份
看着正常的快照。起因：2026-11-01 有人为拿干净身份换了 `dist/`，另一边核对时读出旧数，37 vs 39 就是这么来的。

## 2. 数据从哪来（重要）

| 页面上的东西 | 来源 | 谁来保证它对 |
|---|---|---|
| 源数、工具数（全库只报数、**不设上限**） | `dist/` 注册表 | `build-data.mjs` 与 `scripts/counts.mjs --json` 交叉核对，不一致即失败 |
| 每个源的工具数、工具名 | 同上 | 同上 |
| 盲区（`caveats`） | `manifest.caveats` **原文**，不翻译不改写 | 页面 `details` 里逐条列出 |
| 版本口径（`versionNote`） | `manifest.versionNote` | 同上 |
| 每源一句「能查什么」、英文名 | `site/scripts/labels.mjs`（**人写**） | 双向对账：注册表多一个源 / 这里少一条 ⇒ 构建失败 |
| 快照行（commit、时间、包版本） | `git rev-parse` + `package.json` | 自动 |

**不写死数字**是硬要求：写死的数字迟早过期，而过期的数字是公开页面上的错。

**数字要标口径**（2026-10-31 群内定的规则，回应审查边界）：页面上的「8 源 37 工具」一律标成
**当前源码口径**，并写明取自工作区注册表与 `npm run stats`、附取数时间（页面自己从 `catalog.generatedAt`
渲染，不手填）。它**不是已发布 npm 包的能力清单**，所以：

- 与安装命令**分开写**，不并列成「有 37 个工具 → 所以装它」的因果句；
- 安装段落明确「装的是这个已发布版本，它的源与工具以该版本自己的清单为准」；
- 命令里的包 spec 由 `data-install-spec` 从 **`catalog.published.spec`** 填充，**不是** `package.json` 的版本：
  2026-11-03 实测 npm `latest` = 0.1.0 而源码已是 0.1.1，照源码版本号写会让 `npm install …@0.1.1` 直接失败；
  缺 `market/copy.json` 时退回不带版本号的包名，不猜版本。

页面上一共有三个口径，各自的数据来源不同，别混着看：

| 位置 | 口径 | 数据从哪来 |
|---|---|---|
| 首屏数字条 + 下方「统计自当前源码构建，非已发布包」 | 源码口径 | `catalog.budget`（`dist/` 注册表，与 `npm run stats` 对账） |
| 接入段版本绿框「第二档装的是 `plantomics-hub@0.1.0`，实际包含 N 个源、M 个工具；尚未随该版本发布的源：…」 | **发布口径** | `catalog.published`，来自 `market/copy.json`（由 `market/scripts/build-copy.mjs` 联网解包 npm tarball 生成；「尚未发布」的源是两边 id 差集算出的，不手写） |

页面上**不再有本机 `/healthz` 示例**（2026-11-03 起接入只对外承诺两档，起服务属内部实现）：
第一档给的是线上 `https://datamcp.moilab.net/healthz` 链接，读者自己点开就能看到存活与版本。

缺 `market/copy.json` 时，绿框整段替换成「发布口径未取数（缺 market/copy.json）」——不会留一个编出来的数字，也不会留半句残缺话。

### 审查怎么核（数字不在 HTML 里）

`index.html` 里**一个数字都没有**：占位只有 `—`，数字全由 `assets/app.js` 从 `data/catalog.js` 注入。
这是故意的——HTML 里留数字，就等于留了一份会被复制、会过期的手抄副本。所以「抓静态 HTML 找数字」必然找不到，那不是缺内容。

核法二选一：

```bash
npm run build && node site/scripts/build-data.mjs   # 重新生成，顺带与 scripts/stats.mjs 交叉核对；不一致非零退出
```

或直接读 `site/data/catalog.js`（等价 `catalog.json`）：把 `budget.sources/tools`、`sources[].toolCount`、
`published.sources/tools` 与 `npm run stats`、`dist/` 注册表、`market/copy.json` 逐项对数。
`published` 那一块要与 `node scripts/counts.mjs --published`（联网重下 tarball）对得上，
它与源码口径**本来就可以不同**。


## 3. 约定

- **中英双语**靠 `html[lang]` + 元素上的 `lang="zh"` / `lang="en"`，不是两套文件；
  默认中文（`zh`），右上角切换，选择记在 `localStorage('pmh-lang')`。
- 想直接给英文链接：`?lang=en`；想强制主题：`?theme=light|dark`（只用于截图核对与嵌入，界面上不放开关）。
- 公开页面**不带**内部规则、`记录/` 过程、个人绝对路径；`/healthz` 示例只写形状，不放任何 token。
- 安装命令以 `README.md` 为准，本页只是转述；两者不一致时以仓库 README 为准并回来改本页。

## 4. 截图（可复现，不拿设计稿冒充）

```bash
node site/scripts/shot.mjs --url http://127.0.0.1:8091/ --out shot-1440.png --width 1440 --full --scheme light
node site/scripts/shot.mjs --url http://127.0.0.1:8091/ --out shot-390.png  --width 390  --full --scheme light
```

`shot.mjs` 用 CDP（`Emulation.setDeviceMetricsOverride`）真正把布局视口设成目标宽度：
`chrome --screenshot` 会被 Windows 的最小窗口宽度顶住，截出来的「窄屏」其实是宽布局被裁，看着像页面溢出。
它还会在**内容宽 > 视口宽**时报横向溢出并非零退出——这是本次实际踩到的坑（网格子项 `min-width:auto`
被长代码顶宽，390px 下内容宽 539px）。

分页截取：`SHOT_Y=1700 SHOT_H=1700`（起始偏移 / 最大高度）。

## 5. 文件

```
site/
├── index.html            落地页结构（双语并列，靠 CSS 切换；首屏主视觉是内联 SVG）
├── market.html           源市场页：按源订阅 + 订阅集成本，数据走同源 GET /catalog
├── assets/style.css      两页共用的样式（含暗色主题、响应式、打印）
├── assets/app.js         落地页交互：语言切换、数据渲染、复制按钮、可选主题覆盖
├── assets/market.js      市场页逻辑：取数、卡片、订阅集计数、阈值判定、复制参数
├── assets/market.css     市场页专有样式（配色变量仍取 style.css；只做别名不复制调色板）
├── assets/source-icons.js 源图标 + 主色（**生成产物**：从 dist/core/source-icons.json 生成，勿手改）
├── favicon.svg           站点图标（与市场图标同一标记的简化版）
├── data/catalog.js|json  生成产物（勿手改）
└── scripts/
    ├── build-data.mjs    从 dist/ 注册表生成数据 + 与 stats 对账 + 定置顶顺序
    ├── labels.mjs        人写文案：每源英文名与一句概述
    ├── serve.mjs         零依赖静态服务（`--catalog-upstream` 为显式反代开关）
    └── shot.mjs          CDP 截图（宽度/主题/整页/溢出检查）
```

## 5.1 源市场页（`market.html`）的两条约束

- **数字只有一个来源**：`GET /catalog`。源数、工具数、token 估算、两条阈值（40 软建议 / 80 硬上限）**全部**来自响应，
  每个数字位都挂来源标（实时 / 推算 / 待取）。接口没上线就一律「待 /catalog」，**不拿 `data/catalog.json` 顶替**。
- **200 之后不回退骨架**：响应到了但字段形状不对，页面留在原页并显示红色「字段与契约不符」，
  不伪装成「服务未就绪」——把「契约变了」显示成「后端没做」是拿错误信息骗自己。
- **待补的两处**：① 页面目前**中文单语**，落地页是双语（要不要做成同一套 `lang` 机制，等群里定）；
  ② 「复制订阅集参数」按钮复制 `?sources=…`，因为试调页还在 `web/`、没随本站发布，跳过去就是死链。

## 5.2 接入段（`#install`）：只对外承诺两档

2026-11-03 本涛拍板：**只写两档，自建服务那档整段删掉**（不对外承诺用户自己运维服务/证书/反代）。

1. **零安装（推荐）**：连 `POST https://datamcp.moilab.net/mcp` + `Authorization: Bearer <token>`，
   给 Claude Code（`claude mcp add --transport http …`）、Codex（`~/.codex/config.toml` 的 `url` + `bearer_token_env_var`）、
   DSH（宿主的 MCP 服务器条目：streamable-http + 同一条头）三段可直接粘贴的片段。
2. **本地 stdio**：`npx -p plantomics-hub@<published> plant-omics-mcp`，数据不出本机。

写这一段的三条硬约束：

- **包 spec 只从 `catalog.published.spec` 来**，不从 `package.json`（见 §2 的说明）；命令形式必须是 `npx -p <pkg> <bin>`，
  因为 registry 里**没有**叫 `plantomics-hub` 的 bin（只有 `plant-omics-mcp` 与 `plantomics-hub-mcp`）。
- **`401` 与 `403` 分开解释**：`401 {"error":"unauthorized"}` = 没 token / token 不对；`403` = 来源域名不在服务端白名单。
  不写这句，照抄的人会把 401 当成「服务没起来」。
- **对外文案不出现运维词**：`nginx`、`systemd`、`deploy`、`bootstrap`、反向代理、证书，在 `site/` 里应为 0 命中；
  我们自己用 `dist/service` 跑线上，那是内部实现，不是用户选项。

## 6. 视觉与顺序（2026-10-31 本涛要求）

- **草莓置顶**：顺序在 `build-data.mjs` 的 `PINNED_SOURCE_IDS` 里定，生成到 `catalog.sources[0].pinned = true` 和 `order`。
  页面只按数据渲染，不在前端再排一次——否则 Web 应用、侧边栏都得各自记得这个特例。置顶卡片有左侧源色竖线与「置顶 / Pinned」角标。
- **每源一枚图标**：`assets/source-icons.js`，8 条，键是源 id，值是 `{ color, svg }`，24×24 描边图标 + 主色。
  **它现在是生成产物**：唯一来源 `src/core/source-icons.json`（构建复制进 `dist/core/`），`build-data.mjs` 读它并生成
  `site/assets/source-icons.js` 与 `web/assets/source-icons.js`。缺图标 / 颜色不是 `#rrggbb` / `svg` 为空 / 留着已删源的残留，
  `build-data.mjs` 都会**非零退出并点名**，不静默用占位图。与置顶顺序是同一套规矩：一处定义，两处生成。
  缺条目时卡片显示虚线问号占位（不静默消失），title 里写明该补哪个 id。
- **首屏主视觉**：`index.html` 里内联 SVG（叶片 + 数据节点 + 结果行），无外链、无位图，颜色全走 CSS 变量，暗色自动换一套。
- **暗色不是反色**：配色在 `prefers-color-scheme` 与 `html[data-theme="dark"]` 两处同值维护；主视觉与图标都随 `--accent` / `--src` 变化。
- **快照行**写两个时间：读到数据的时刻（`generatedAt`）与产物来自哪次构建（`build.sourceRev`，读 `dist/service/build-info.json`）。

## 7. 还没做的

- 没接任何统计脚本（公开页不埋点）。
- 云服务地址已在用（`datamcp.moilab.net`），页面第一档直接指向它；**托管与部署细节不对外写**（本涛 2026-11-03 定：那是内部实现，不是用户选项）。
- 市场页仍是中文单语，与落地页的双语机制还没统一。

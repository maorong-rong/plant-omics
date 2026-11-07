# 0.1.2 发布 · 落地页「发布口径」前后对照（2026-11-07）

本单把 npm `latest` 与 DSH 市场 `versions` 第一条从 `0.1.1` 推进到 `0.1.2`。落地页有两处
用户可见读数随之变化：`#published-note` 里的「已发布 spec」，以及 stdio 安装命令里的
`npx -p plantomics-hub@<spec>`。两张对照图各自覆盖一处；版式、配色、交互均未改动。

## 场景

| 项 | 值 |
|---|---|
| 页面 | 落地页 `site/index.html`，`?lang=zh&theme=light` |
| 区域 | ① `#published-note`；② `#tier-stdio .code`（Claude Code 命令块） |
| 视口 / 主题 | 1440 × 900 / light（`prefers-color-scheme: light`） |
| 取数 | `node dist/service/cli.js`（10 源 / 41 工具）+ `node site/scripts/serve.mjs 8091 --catalog-upstream http://127.0.0.1:8787` |
| 截图方式 | Chromium 131 headless（CDP），按选择器裁剪；两轮使用同一页面、同一视口、同一主题、同一路径 |
| 数据来源 | `site/data/copy.*` 由 `node site/scripts/build-data.mjs` 从 `market/copy.json` 生成 |

## 基线 / 改动

| | 修订 | 截图 | 页面读数 |
|---|---|---|---|
| 改前 | `a3e2bb4`（发布前的 `origin/main`） | `before-published-note.png`、`before-install-command.png` | 已发布 `plantomics-hub@0.1.1`；安装命令钉 `plantomics-hub@0.1.1`；源码版本 `0.1.2` |
| 改后 | 本 PR head（重新生成 `site/data/copy.*`） | `after-published-note.png`、`after-install-command.png` | 已发布 `plantomics-hub@0.1.2`；安装命令钉 `plantomics-hub@0.1.2`；源码版本 `0.1.2` |

改前的运行日志：`/healthz` = `0.1.2+svc.7.ga3e2bb4`；改后 = `0.1.2+svc.7.g903e580`
（服务只用于给落地页提供 `/catalog` 同源取数，两轮都是 10 源 / 41 工具）。

## 复现

```bash
npm run build
node dist/service/cli.js &                     # 127.0.0.1:8787
node site/scripts/serve.mjs 8091 --catalog-upstream http://127.0.0.1:8787 &
# 用 CDP 打开 http://127.0.0.1:8091/?lang=zh&theme=light，1440×900，
# 分别按 #published-note 与 #tier-stdio .code 裁剪截图
```

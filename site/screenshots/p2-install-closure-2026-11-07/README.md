# P2 装机闭环 · 落地页「发布口径」前后对照（2026-11-07）

这两张图是同一场景的前后对照，用来核对 P2 把市场索引从 0.1.0 更新到 0.1.1 后，
落地页「第二档装的是 npm 上已发布的 …」这一块的文案是否仍然属实。

## 场景

| 项 | 值 |
|---|---|
| 页面 | 落地页 `site/index.html`，`#published-note`（版本口径提示块） |
| 语言 / 主题 | 中文 / light（`?lang=zh&theme=light`） |
| 视口 | 1440 × 900 |
| 取数 | `node site/scripts/serve.mjs 8091 --catalog-upstream http://127.0.0.1:8787`，本地服务 `node dist/service/cli.js`（10 源 / 41 工具） |
| 截图方式 | 本地 Chromium（CDP），按 `#published-note` 选择器裁剪；同一视口、同一主题、同一路径 |

## 基线 / 改动

| | 修订 | 截图 | 页面读数 |
|---|---|---|---|
| 改前 | `e768680`（本单开始时的 `origin/main`） | `before-published-note.png` | 已发布 `plantomics-hub@0.1.0`；未随该版本发布：Ensembl Plants、STRING、UniProt；源码版本 `0.1.1` |
| 改后 | PR head（本目录所在提交） | `after-published-note.png` | 已发布 `plantomics-hub@0.1.1`；未随该版本发布：无；源码版本 `0.1.2` |

改后把「收录的源比当前服务少」改成「**可能**比当前服务少」，因为 0.1.1 已经收录全部
10 个源（`missingSources` 为空），原来的断言不再成立。版式、配色、交互没有改动。

## 复现

```bash
npm run build
node dist/service/cli.js &                     # 127.0.0.1:8787
node site/scripts/serve.mjs 8091 --catalog-upstream http://127.0.0.1:8787 &
# 用 site/scripts/shot.mjs 的 CDP 方式截图；本次按 #published-note 裁剪
```

# 市场索引（`format: 1`）

`index.json` 是给 DSH「插件 → 发现 → 添加索引源」用的**格式 1 索引**，用户添加一次这个 URL，就能在市场里搜到并安装 `plantomics-hub`。

> **当前状态：文件已就绪，尚未托管。** 没有任何公开 URL 指向它之前，界面里不应显示"索引源地址"。

## 一、它现在装的是什么

| 项 | 值 | 出处 |
|---|---|---|
| 插件名 | `plantomics-hub` | npm 包名 |
| 版本 | `0.1.0`（只放这一个） | `npm view plantomics-hub version` |
| `publishTimestamp` | `1793285202` | npm registry 的 `time["0.1.0"]` = `2026-10-29T14:46:42.487Z`，按 Unix **秒** 换算 |
| `source.type` | `npm` | 安装目标即 `plantomics-hub@0.1.0` |
| `engines.dsh` | `>=0.2.1-rc.2` | 与 `package.json` 的 `engines.dsh` 一致 |
| 卡片文案 | 中英两段，**数字按「发布口径」算出**（当前 `0.1.0`：7 源 34 工具） | `market/scripts/build-copy.mjs` 生成，`check-index.mjs` 核对 |
| 图标 | 内联 `data:image/svg+xml;base64,…`，解码 1920 字节（上限 32 KiB） | `market/assets/icon.svg` → `build-icon.mjs` |

**两个口径别混**（2026-10-31 全员定案）：

| 口径 | 真相 | 用在哪 |
|---|---|---|
| 源码口径 | 本地 `dist/` 注册表（今天 8 源 37 工具） | 落地页 `site/`，页面上标「当前源码口径」 |
| **发布口径** | `index.json` 的 install spec 指向的 npm tarball（`0.1.0`：7 源 34 工具，无 ensemblplants） | **市场卡片**，因为它描述「装上能拿到什么」 |

两边不同不代表哪个写错：发布滞后是常态，但**索引不能承诺装不出来的能力**。数字的唯一实现在
`scripts/counts.mjs`（`--json` 出源码口径，`--published` 联网解包 tarball 出发布口径），市场的措辞只取它算出的数，本目录不自己数数。


**为什么没有 `0.0.0-stage`**：它是早期占位版本，语义不明。放进索引会让市场里出现一个用户可能误装的版本，所以只登记 `0.1.0`。

## 二、校验（用官方校验器，不是自己写的规则）

用 `@deepseek-ai/dsh-plugin-market-index@0.2.1-rc.2` 的 `parseMarketIndex` 实跑：

```
PARSE OK
plugins=["plantomics-hub"]
install spec = {"spec":"plantomics-hub@0.1.0"}
```

为了证明"通过"不是空过，同一份校验器对 6 个故意写坏的变体全部拒绝：

| 变体 | 拒绝原因（路径 + 原文） |
|---|---|
| `format` 写成字符串 `"1"` | `$.format must be 1` |
| `publishTimestamp` 写成毫秒 | `must be an integer number of Unix seconds in [0, 10^11)` |
| `source.type` 用 `tgz` | `must be "npm" or "git"` |
| `version` 用范围 `^0.1.0` | `must be an exact SemVer version` |
| 根 `title` 缺 `en` | `$.title must contain en` |
| 插件名带大写 | `must be a valid npm package name` |

## 三、托管要求（托管时按这条核）

1. **必须是绝对 URL**，相对图标按它解析；
2. **可直达、不可重定向**（市场侧拒绝重定向）、无 query、无 fragment；
3. 更新索引后，用户那边的市场列表要重新拉取才生效；
4. `engines.dsh` 在索引与 `package.json` 两处都要有——市场列表读的是索引里的值。

## 四、素材（图标 / 文案 / 截图）

| 文件 | 是什么 | 怎么来 |
|---|---|---|
| `assets/icon.svg` | 图标源文件（六节点 + 叶片，512 画布，圆角 112） | 人画一次；改它就重跑 `build-icon.mjs` |
| `assets/icon-512.png`、`icon-256.png`、`icon-48.png` | 真位图，给 README / 落地页 / 社交预览用 | `node market/scripts/build-icon.mjs`（`48` 这一档单独出：`build-icon.mjs 48`） |
| `assets/icon.dataurl.txt` | 一整行内联 `data:` URL，直接就是 `index.json` 的 `icon` 值 | 同上 |
| `copy.json` | 卡片文案快照：中英描述、关键词、点名物种、数字、快照时间 | `node market/scripts/build-copy.mjs` |
| `scripts/card-copy.mjs` | 文案模板 + 物种中英名表（双向对账） | 人写；新增源后在这里补物种名 |

**图标为什么内联、不走 URL**：`format: 1` 的 `icon` 只接受两种值——`data:` 内联（base64，解码 ≤ 32 KiB），或者能解析到 **https 或索引同源** 的 URL。本仓目前没有公开托管地址，用内联就不必等托管，换域名也不会把图标带坏。位图仍然要出，因为 README 与社交预览读不了 SVG data URL。

**格式 1 没有「截图」字段** —— 实测：给插件条目加 `screenshots` / `gallery` 后跑官方 `parseMarketIndex`，读回来的字段只有 `name,title,description,icon,author,homepage,repository,metadata,versions`，两个字段都被丢弃（校验器约定「格式未定义的成员会被丢弃」）。所以市场卡片能展示的视觉只有图标；使用截图只能放仓库 README 与落地页，不会出现在市场里。

**改文案不要手抄**：数字来自 `scripts/counts.mjs`，手抄迟早过期；而「描述跟着源变化」在这里是这么落地的——

```
node market/scripts/build-copy.mjs      # 联网：解包 index.json 指向的 npm tarball，算出发布口径文案
node market/scripts/build-icon.mjs      # 图标没改可跳过
node market/scripts/apply-copy.mjs      # 原地写进 index.json（描述 2 段 + icon 1 行）
node market/scripts/check-index.mjs     # 离线：官方校验器 + 文案对账 + 版本对账 + 图标对账，必须退出 0
node scripts/counts.mjs --published     # 联网：再核一次「copy.json 是否还等于当前发布包」
```

发布新版本后：先发 npm，再跑上面这一串 —— 卡片描述会自动变成新版本的真实数字与覆盖物种，不需要人改文案。

`check-index.mjs` 需要官方校验器，本仓不把它写进依赖（依赖由代码改动者管）：

```
npm i --prefix C:/Temp/pmh-market @deepseek-ai/dsh-plugin-market-index@0.2.1-rc.2
$env:PLANTOMICS_MARKET_VALIDATOR = "C:/Temp/pmh-market/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js"
```

它挡住四件事，且每条都做过**负控**（故意改坏必须非零退出，否则等于没查）：

| 关 | 改坏成什么 | 实测结果 |
|---|---|---|
| ① 文案对账 | 描述写成源码口径 8/37 | `exit 1`，打印索引原文与期望原文 |
| ② 图标对账 | 图标与 `icon.svg` 不同步 | `exit 1`，提示重跑 `build-icon.mjs` |
| ③ 图标上限 | 塞 41 KiB 的 PNG data URL | `exit 1`，官方校验器 `must not exceed 32 KiB of decoded bytes` |
| ④ 格式 1 | `format` 写成字符串等 6 种 | 官方校验器逐条拒绝（见第二节） |

（这版第一稿真漏过一处：`check()` 忘了 `return`，整个图标段被静默跳过，负控②当场把它抓出来。）


---

## 五、改这个文件时要一起改什么

- 发新版本 → 在 `versions` 里**追加**一条，不要替换旧条目；`publishTimestamp` 从 registry 的 `time` 字段取，不要手算日期。
- 改 `engines.dsh` → 同时改 `package.json`，两边不一致时以索引为准，用户会装不上。
- 改完必须重跑第二节的校验，再托管。

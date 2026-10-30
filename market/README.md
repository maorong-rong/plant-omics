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

## 四、改这个文件时要一起改什么

- 发新版本 → 在 `versions` 里**追加**一条，不要替换旧条目；`publishTimestamp` 从 registry 的 `time` 字段取，不要手算日期。
- 改 `engines.dsh` → 同时改 `package.json`，两边不一致时以索引为准，用户会装不上。
- 改完必须重跑第二节的校验，再托管。

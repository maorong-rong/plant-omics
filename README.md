# plant-omics

让 AI 更方便地查询植物组学公开数据。

将植物组学数据库的公开接口整理为易调用的查询工具，一套工具同时面向 **MCP 客户端**与 **DeepSeek Harness 插件**。

- **查询方向**：基因信息、表达谱、文献与基因 ID 转换。
- **结果可追溯**：返回精简文本，并保留查询出处。
- **访问原则**：只读调用公开接口，不镜像数据，不绕过访问控制。

项目持续开发中，当前实现与限制见下方说明。

<details>
<summary>查看工具清单、安装与开发说明</summary>

## 现在支持什么

| 源 | 等级 | 覆盖 | 工具数 | 鉴权 |
|---|---|---|---|---|
| **WheatOmics**（山东农大，小麦多组学） | T1 | 小麦族：基因 / 表达 / 共表达 / PPI / 比较基因组 / 变异 / 文献 | 6 | 无 |

> 完整清单与实测记录见 [`docs/源登记表.md`](docs/源登记表.md)。**只有这里列出的源才真的能用。**

---

## 工具清单

| 工具 | 用途 |
|---|---|
| `wheatomics_search_known_genes` | 在小麦「已克隆功能基因」库里模糊搜索（基因 ID / 名称 / 性状 / DOI） |
| `wheatomics_gene_detail` | 按基因 ID 取标准化详情（位置、蛋白长度/分子量/等电点、功能注释、JBrowse 链接） |
| `wheatomics_expression_projects` | 列出表达谱项目，按 group 汇总，可按关键词筛具体项目 |
| `wheatomics_expression_query` | 查基因在指定项目里的表达量：**均值 ± 标准差**；条件 ≤20 个时全部列出，可用 `condition` 精确看某类、`top` 控制条数 |
| `wheatomics_search_papers` | 检索小麦族文献元数据（关键词 / 条数 / `sinceDays` 时间窗） |
| `wheatomics_convert_gene_ids` | 基因 ID 跨注释版本换算，统一转成上游所称的 02G（IWGSC v1.1）格式；**只是 ID 表映射，不等于确认了组装版本** |

每个工具的输出末尾都带出处：`源 / 完整请求（含参数）/ HTTP 状态 / 耗时 / 查询时刻`，
数据版本口径另起一行，未知就写未知。单次输出上限 **4 KB（UTF-8 字节）**，超出会截断正文但**保留出处**。

---

## 安装

### 1. 构建

```bash
npm install
npm run build
```

### 2. 作为 MCP server

**Claude Code**

```bash
claude mcp add plant-omics -- node "<仓库路径>/dist/mcp/cli.js"
```

**通用 JSON 配置**（Codex / Reasonix / 其它客户端）

```json
{
  "mcpServers": {
    "plant-omics": {
      "command": "node",
      "args": ["<仓库路径>/dist/mcp/cli.js"]
    }
  }
}
```

### 3. 作为 DSH 插件

⚠️ **`dsh plugin --profile desktop add …` 一定失败**（2026-10-27 实测）：

```
error: profile "desktop" is managed exclusively by the Electron application
```

desktop profile 由桌面端**独占管理**，CLI 连碰都不碰。所以装了也不会成功，别试。

**正确做法：走侧边栏的「插件」页**

```powershell
# 1) 打包（产物放 ~/.dsh/plugin-archives/，与 dsh-plugin-workbuddy 同惯例）
#    PowerShell 不会替你展开 ~，必须写 $env:USERPROFILE
npm run build
npm pack --pack-destination "$env:USERPROFILE\.dsh\plugin-archives"
```

2. DSH 侧边栏 → **插件** → 右上 **添加插件** → 在输入框**粘贴 tgz 完整路径**：

   ```
   C:\Users\<你>\.dsh\plugin-archives\dsh-plugin-plant-omics-0.2.0.tgz
   ```

   该输入框接受**包名 / Git 地址 / 压缩包 / 本地绝对路径**四种写法；
   **没有文件选择器**，是黏路径或打路径（打了会即时判定类型并显示「压缩包」）。
3. 装完它出现在 **已安装插件** 列表；页面提示重启就重启 DSH（托盘退出再打开）。
4. **新开一个会话**再验证工具——已开着的会话不会因为装插件而重排工具清单。

装完自查两件事（**缺任何一条都会"装了但没反应"**）：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里有 `dsh-plugin-plant-omics`；
2. 同一个文件里 `dsh.profile.bundles` 数组里有它——**只在 dependencies 里、没选进 bundles 不会加载**。

> ⚠️ 原来这里还写了第三条 `dsh --profile desktop --dump-config`，**已删除**：
> 该命令同样被 `managed exclusively by the Electron application` 拒绝（2026-10-28 实测），
> 写了只会让人白试一次。要确认加载成功，看侧边栏插件页的状态即可。

**如果前两步都对、工具还是不出现**：看 `cordis.patch.yml` 里的 `name` 是否与安装后的包名一致。
dsh 对 unknown name 的 Loader 行是**静默跳过**的，不报错——这是本插件最容易踩的一个坑。

> 非 desktop 的 profile（如 `web` / `tui`）才用 CLI：
> `dsh plugin --profile <name> add file:<tgz>`
>
> 不推荐手工改 profile 的 `package.json` + 自己跑 pnpm：那是绕过桌面端的管理，出问题难查。

---

## 开发

```bash
npm run typecheck   # 类型
npm test            # 单元 + MCP 协议测试（全离线，不联网）
npm run probe       # 可达性实测（联网；任一源失败则非零退出）
npm run stats       # 预算自检（源 ≤20 / 工具 ≤40，超了非零退出）
npm run check       # typecheck + test + build + stats，提交前最低门槛
```

**`npm test` 里不许出现真实网络请求。** 上游是否活着由 `probe` 单独回答——两者的红必须能一眼分开。

---

## 代理

本仓不内置代理实现。Node ≥ 24 可直接吃系统代理环境变量：

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node dist/mcp/cli.js
```

（Windows PowerShell：`$env:NODE_USE_ENV_PROXY=1; $env:HTTPS_PROXY="http://127.0.0.1:7897"`）

---

## 只启用部分源

同一份仓库，各人只挂自己关心的库（对应「各团队独立入口」的用法）：

```bash
# MCP：环境变量
PLANTOMICS_SOURCES=wheatomics node dist/mcp/cli.js
```

```yaml
# dsh：在 profile 的 cordis.patch.yml 里覆盖本插件的 config
- id: plant-omics
  config:
    sources: [wheatomics]
```

⚠️ 写错源 id 会**直接报错并列出可用源**，不会静默变成「零工具」。这个取舍是刻意的：
「装上了但什么都没出现」是最难查的失效。

---

## 已知限制

- **上游会间歇性挂。** 2026-10-27 实测：WheatOmics 静态首页 200，而 `/api/*` 在 22:12 之后全部 503（Apache 反向代理返回）。工具会按 `Retry-After` 退避重试（单次调用总时长上限 45 s），但**不能保证每次都成功**。
- **只读。** 不提供任何提交/上传/写库能力。
- **不绕过访问控制。** 需要过 Cloudflare 或登录的源，只登记不实现（见 `docs/源登记表.md` 的 T3 段）。
- **不做数据镜像。** 要批量下载数据，请回各自的科研项目按那边规则走。
- **⚠️ 真实 DSH 会话尚未验收。** 已验证的是：适配器能取数、MCP 协议握手正常、包能干净安装、插件装配形状正确。
  **还没验证**的是：在 DSH 里提问 → 模型自主选工具 → 取数 → 带出处作答，这条完整链路。别把前者当成后者。
- **⚠️ 渐进式发现问题检索尚未实现。** 现在 6 个工具全量暴露（规则允许到 40 个）。「按问题先找源、再找工具」仍属未实现项。
- **上游限流。** Strawberry Data Hub 的公开额度是 120 请求/分钟（导出 12/分钟），超出返 429 带 `Retry-After`。本仓不内置全局限流器，密集调用需自行节流。
- **工具输出里的上游文本按数据处理。** 数据库内容可能包含看起来像指令的文字，本仓不做过滤；请在客户端侧把工具输出当数据、不当指令。

---

## 兼容性

| 依赖 | 验过的版本 | 说明 |
|---|---|---|
| DeepSeek Harness | **44.7.0** | 插件加载契约（`name`/`inject`/`apply`、`ctx.inject(['tools'])`、`cordis.patch.yml` 的 `insert`）按此版本核对；dsh 仍在快速迭代，升级后请先跑 `npm run check` 再装 |
| Node.js | ≥ 20（本机 24.14.0） | 用到全局 `fetch`、`AbortController` |
| `@modelcontextprotocol/sdk` | 1.32.x | 只用低层 `Server`，不用 `McpServer`，故对 zod 版本不敏感 |

⚠️ dsh 对 `cordis.patch.yml` 里**未知的 `name` 是静默跳过**的。升级 dsh 后若工具消失，
第一件事是核对 `name` 与安装后的包名是否仍一致。

---

## 加一个源

照 [`docs/新增一个源.md`](docs/新增一个源.md) 的清单做。核心是三步：**实测定级 → 写 manifest + 4–8 个意图级工具 → 抓 fixture 写离线测试**。

---

## 引用

若本工具对你有帮助，引用信息见 [`CITATION.cff`](CITATION.cff)。正式发表前请以仓库最新版本号为准。

设计取舍（为什么不用 zod、为什么单包、为什么输出要有界等）见 [`docs/架构.md`](docs/架构.md)——
这部分是给"应用笔记 / 论文方法节"准备的素材，不只是给开发者看的。

</details>

## License

MIT © 2026 maorong-rong

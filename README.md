# PlantOmics Hub

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
| **WheatOmics**（山东农大，小麦多组学） | T1 | 本仓已封装：小麦族基因、表达、文献、注释ID换算、跨物种同源（wheat/rice/arabidopsis，不区分直系旁系）、变异数据集目录与区间查变异（不含按变异 ID 查）；不代表网站全部模块已接入 | 9 | 无 |
| **Strawberry Data Hub**（海南大学） | T1 | 草莓及相关病原：目录和精确基因注释；表达仅已证实草莓数据集、TF仅Fragaria、共线仅已证实装配 | 5 | 无 |
| **GWH**（NGDC） | T1 | 精确基因组/组装、项目/样本元数据；物种示例非穷尽，不提供物种搜索 | 2 | 无 |
| **ICG**（NGDC） | T1 | 物种目录及研究验证的内参基因/引物；不提供名称搜索，不作通用推荐 | 2 | 无 |
| **IC4R**（NGDC） | T1 | 仅粳稻（japonica）单物种：基因、功能注释、circRNA、lncRNA、ID 映射，并按染色体分页列 locus；文档为 2018 版，不能按基因名/性状/区间检索 | 6 | 无 |
| **Gramene v69** | T1 | 全文检索、基因、差异表达、分类单元；实测物种只有 Oryza sativa / Indica Group，不声称覆盖禾本科；按 ID 或全文查，不按名称精确匹配 | 4 | 无 |
| **SCOD**（NGDC，甘蔗多组学） | T2 | 甘蔗（Saccharum spontaneum）及相关材料：基因组目录、按区间查基因（服务端分页）；区间需**包住整条基因**才返回，0 条不代表该位置没有基因；不是主粮 | 2 | 无 |

> **0.1.0（`plantomics-hub`）：7 源、34 工具（含 2 个元工具）。** 形态已改为「薄插件 + 远程 MCP 服务」，安装前必须先起服务，见下方「0.1.0 的形态变了」。0.7.x 及更早的 `dsh-plugin-plant-omics` 是「插件内置工具」的旧形态，可与新包共存但不可同时启用。
>
> 已验证：源码离线检查、候选包构建与包内内容一致性、六源最小 HTTP MCP 回放、服务层安全反例。**未验证**：真实宿主装载新包、动态刷新、公网部署；npm 尚未发布。源等级与实测以[源登记表](docs/源登记表.md)为准。

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
| `wheatomics_cross_species_homologs` | 按基因 ID 查小麦/水稻/拟南芥同源基因；**不区分直系与旁系**（上游无该字段），`max_targets` 是**每物种**上限 |
| `wheatomics_variant_datasets` | 列出变异数据集及 `genome_concordant` 标志；该标志未知时显示"未知"，不替上游推断 |
| `wheatomics_variant_query` | 按区间查变异（`chrom` + 起止）；**`total=0` 不代表该区间没有变异**，正文会提示先确认数据集 `genome_concordant`；上游未给 `total` 时按结构漂移报错、不当作 0 条；返回的 `dataset` 与请求不符会拒绝展示；正文摘要分三段——**上游 total / 上游返回 N 条 / 正文展示 N 条**，其中"正文展示"与表格行数、尾行"另有 N 条"同源计算，三者必须一致；不支持按变异 ID 查 |
| `strawberry_catalog` | 目录发现：模块、装配和限流；`module`仅本地过滤，不代表已支持所有目录模块 |
| `strawberry_gene_lookup` | `geneId`精确查询；可选`species`/`version`消歧；`includeSequence=true`仅显示最多120 aa的**非完整蛋白前缀**，不能用于完整序列分析 |
| `strawberry_expression` | 草莓组织表达：`geneId`、可选`dataset`/`top`；保留响应原单位batch-corrected TPM，不跨数据集比较 |
| `strawberry_synteny` | `geneId`、`sourceAssembly`、`targetAssembly`查询共线块；`maxBlocks`控制展示，不将共线解释为功能等价 |
| `strawberry_tf_members` | 至少给`family`/`species`/`assembly`/`type`一个筛选；`page`/`pageSize`分页，分别报告total/返回数/展示数；release未声明则未知 |
| `gwh_assembly_lookup` | `entity=genome/assembly` + 精确 `id`，取基因组或GWH组装；下载路径不代表已验证可下载 |
| `gwh_project_sample_lookup` | `entity=project/sample` + PRJCA/SAMC；项目与样本为平行入口，不提供关联样本列表 |
| `icg_lookup` | 显式 `entity=species/project/gene/publication` + `id`；逐层取研究、完整引物或题录，预算不足整块省略 |
| `icg_species_list` | `offset`/`limit` 分页浏览目录，不能按名称搜索；本次返回条数不等于全库总数 |
| `ic4r_gene` | `locus` 精确查粳稻基因（同义词、MSU/RAP-DB accession、位置）；`locus` 是基因 ID 空间，与 circRNA/lncRNA 不通用；只有 locus 不确定时，先用 `ic4r_gene_list` 按染色体浏览取 ID |
| `ic4r_annotation` | `locus` 取功能注释，按类别分组；`[]` 只表示本次未返回注释，不是“该基因没有注释” |
| `ic4r_circrna` | `accession`（`…Circ…`）取 circRNA；序列默认整条展示，超 4 KB 预算整条省略 |
| `ic4r_lncrna` | `accession`（`…Lnc…`，可带 `.1` 后缀）取 lncRNA；唯一实测 1,639 bp 序列默认不展示，是预算结果，不是上游没有序列 |
| `ic4r_id_convert` | IC4R `locus` → MSU / RAP-DB 映射；只承诺已测方向，反向未测 |
| `gramene_search` | 自由文本 `q` 全文检索，返回上游 `numFound` 与本次返回条数；只能全文检索，不能按字段过滤 |
| `gramene_gene` | `ids` 精确文档 ID 取基因（名称/描述/类型/物种/位置）；原始 8.5 KB 含 xrefs，工具只给裁剪字段 |
| `gramene_expression` | `ids` 取差异表达：每实验 p_value/l2fc，最多 3 实验×2 比较；不做显著性判定 |
| `gramene_taxonomy` | 数字 taxid 取分类单元；前导零按数值归一；单值也按数组语义重复发送（规避上游 400） |
| `scod_genome_list` | 列出甘蔗基因组目录（14 个材料）；裸数组响应，与基因接口的信封不同 |
| `scod_gene_region` | 按 `genome_id`+`chrom`+`pos_start`+`pos_end` 查基因；**返回完全落在区间内的基因**（跨界的不会返回），服务端分页且**本地限制 `length ≤ 50`**；0 条不等于该位置没有基因 |
| `ic4r_gene_list` | `chromosome`（仅页面给出的 1–12/`Sy`/`Un`，本仓白名单）+ `start`/`length`（本仓上限 50，上游上限未测）分页列 locus；报 `recordsTotal` 与本次返回条数 |

分类分三轴：物种覆盖、数据类型、查询意图；官方MCP/公开API是接入方式，本仓工具是封装层，不重复计源。Strawberry首版仅GET，不包含批量序列、导出、单细胞、表观或GWAS实际查询。HTML404仅说明未获业务响应，不能断定基因不存在。

每个工具的输出末尾都带出处：`源 / 完整请求（含参数）/ HTTP 状态 / 耗时 / 查询时刻`，
数据版本口径另起一行，未知就写未知。单次输出上限 **4 KB（UTF-8 字节）**，超出会截断正文但**保留完整出处**。

### 0.4.0迁移：长请求先拒绝，不省略出处

完整实际URL（含编码后的所有参数）及本地呈现选项合计超过1536 UTF-8字节时，工具在联网前明确拒绝；尾注预留2560B，正文最多1408B。已发布WheatOmics参数名、类型、名义ID数量上限不改，但达到数量上限并不保证能满足字节预算。

例如一次200个长转录本ID的换算可能不再接受：请按原顺序拆成更小批次（如先试10个），若仍超预算继续减小；中文筛选按URL编码后字节计算。不要通过删掉species/version等消歧参数绕过预算。新错误属于兼容性收紧，不能把它当上游无记录。返回完整请求的错误已分别验证MCP文本和DSH工具错误（离线装配，不等同宿主会话）。

---

## 安装

### 从 npm 安装（最快）

```bash
npm install plantomics-hub
```

装完后有两个入口：

```bash
npx plantomics-hub-mcp     # 启动 MCP 服务（Streamable HTTP，默认 127.0.0.1:8787）
npx plant-omics-mcp        # 启动 stdio 版 MCP（给 Claude Code / Codex 等直接接）
```

只想临时跑一次、不装到项目里：

```bash
npx -p plantomics-hub plantomics-hub-mcp
```

> 本包同时是 DSH 插件。DSH 桌面端请按下一节装 tgz（插件管理器只接受压缩包或路径，不接受包名），并**先起服务**。

### 0.1.0 的形态变了：先起服务，再装薄插件

0.1.0（`plantomics-hub`）不再是「插件内置工具」的形态：

```
DSH ──(薄插件：只有面板 + 一条 MCP 客户端配置)──► 我们的 MCP 服务（Streamable HTTP）──► 各数据库
```

两条硬要求，装之前必须先满足：

1. **服务必须先起来**，否则插件能装上、但一个工具都不会出现（`failOnStartupError: true` 会让它明确报错，而不是静默）。默认地址 `http://127.0.0.1:8787/mcp`。
2. **工具名带命名空间前缀**：模型看到的是 `mcp__plantomics-hub__wheatomics_search_known_genes` 这样的名字，不再是裸名。旧的 0.7.x 及更早版本包（`dsh-plugin-plant-omics`）**可以共存但不能与新包同时启用**，否则两套工具会重复出现。

起服务：

```bash
# 默认 127.0.0.1:8787，不鉴权（仅回环）
npm run serve

# 换个端口
PLANTOMICS_HUB_PORT=0 npm run serve        # 0 = 让系统分配

# 对外提供服务（必须带 token，否则启动即失败）
PLANTOMICS_HUB_HOST=0.0.0.0 \
PLANTOMICS_HUB_TOKEN='至少16字符的随机串' \
npm run serve
```

服务启动后会打印监听地址、源/工具数与工具名预算；预算不达标（源 >20、工具 >40、工具名超长）时**拒绝启动**，不会带病接客。

**一键启动（不用每次敲命令）**

```powershell
powershell -ExecutionPolicy Bypass -File "<包目录>\scripts\start-service.ps1"
```

脚本先检查已安装的服务入口是否存在、端口是否被占用，再用人话说明怎么处理，而不是甩一段 Node 堆栈。 **仅 Windows**（PowerShell 脚本）；macOS/Linux 直接用上面 `npx plantomics-hub-mcp` 那两条命令。端口冲突时加 `-Port 8788`，但**换了端口要同步插件里的 `PLANTOMICS_HUB_URL`**，否则宿主连不上。

**开机自启**：把上面那条命令做成快捷方式放进 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`，目标写 `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<脚本完整路径>"`。

**健康检查**：`GET /healthz` 返回 `{"status":"ok","version":"…","sources":6,"tools":25}`，**不需要 token、不校验 Host**（托管平台探针从内部地址打过来），也不泄露工具清单。

**服务没起来时会看到什么**：宿主日志是 MCP 连接失败（连不上 8787），会话里**一个 `mcp__plantomics-hub__*` 工具都没有**；patch 里设了 `failOnStartupError: true`，这条会被判为激活失败，而不是"静默装上没反应"。先确认服务窗口还在、`/healthz` 返回 200，再重启 DSH。

装插件：

- 从 `npm pack` 得到 `plantomics-hub-0.1.0.tgz`，在 DSH 侧边栏「插件」页添加该 tgz 的绝对路径。
- 服务地址不是默认值时，先设环境变量再启动 DSH：`PLANTOMICS_HUB_URL=http://127.0.0.1:8787/mcp`、`PLANTOMICS_HUB_TOKEN=<token>`（token 以 `Bearer` 形式随请求头发送）。

**反代部署注意**：服务默认只接受回环 Host。放到 nginx 等反向代理之后，Host 会变成代理域名，必须显式放行，否则 403：

```bash
PLANTOMICS_HUB_ALLOWED_HOSTS=hub.example.org \
PLANTOMICS_HUB_HOST=0.0.0.0 \
PLANTOMICS_HUB_TOKEN=<至少16字符> \
npm run serve
```

只写主机名，不带协议与路径；未配置时默认只允许回环，不会因为部署成代理就自动放开。

### 前置环境与获取源码

- Git、Node.js **≥20**、npm；本次验证环境为Windows、Node **24.14.0**、npm **11.9.0**，未实测其他系统/版本组合。环境代理支持另见下方代理说明。
- MCP客户端需支持本地stdio进程；**不需要DSH**。DSH桌面插件契约按44.7.0核对，宿主升级兼容性须另验。
- 安装依赖需要访问npm registry；实际查询需要访问各数据库。没有API key要求，但不保证各地区网络均可达。

```bash
git clone https://github.com/maorong-rong/plant-omics.git
cd plant-omics
npm ci
npm run check
```

`check`包含构建及全离线测试；数据库可达性另运行 `npm run probe`。确认 `node -p "require('./package.json').version"` 为预期版本，并保存 `git rev-parse HEAD`；main会继续变化，复现时使用自己已验证的提交，不假定存在版本tag。

### 1. 按用途选择

- **只用MCP（stdio）**：完成上述构建后按第2节配置stdio，无需安装DSH或tgz。_stdio 出口仍是旧形态（插件内置工具），与 0.1.0 的薄插件/服务形态并存。_
- **DSH桌面用户**：按上面「0.1.0 的形态变了」先起服务，再从插件页安装 `plantomics-hub` 的 tgz；第3节是 0.7.x 及更早版本的旧装法，**不要用于 0.1.0**。

源码构建产物仅位于本地，不会自动更新已经安装的插件。验证范围详见[安装验证说明](docs/安装验证.md)。

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

### 3. 作为 DSH 插件（**仅适用于 0.7.x 及更早的旧形态**）

> ⚠️ 0.1.0（`plantomics-hub`）**不要按本节安装**：新包是薄插件，工具由远程 MCP 服务提供，安装前必须先起服务，步骤见上方「0.1.0 的形态变了」。本节保留给仍在使用 `dsh-plugin-plant-omics` 旧包的人。

没有现成tgz时，在已完成构建的源码目录生成自己的包，并放到长期保留的目录（不要留在系统临时目录）：

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\plugin-archives" | Out-Null
npm pack --pack-destination "$env:USERPROFILE\.dsh\plugin-archives"
Get-FileHash -Algorithm SHA256 "$env:USERPROFILE\.dsh\plugin-archives\<包名>-<版本>.tgz"
```

```bash
# macOS/Linux：命令写法供参考；本轮未实测这两个系统
mkdir -p "$HOME/.dsh/plugin-archives"
npm pack --pack-destination "$HOME/.dsh/plugin-archives"
```

文件名取实际package版本；本地构建的哈希不保证与维护者候选包相同。收到别人提供的tgz时先核对对方公布的完整SHA256；仅计算本地哈希不构成来源认证。无源码用户可直接把可信tgz放入长期目录，在插件页粘贴其绝对路径，不必运行下面的可选辅助脚本。

⚠️ **`dsh plugin --profile desktop add …` 一定失败**（2026-10-27 实测）：

```
error: profile "desktop" is managed exclusively by the Electron application
```

desktop profile 由桌面端**独占管理**，CLI 连碰都不碰。所以装了也不会成功，别试。

**可选辅助脚本**（源码用户；需要系统 `tar` 命令与已初始化的DSH profile；不是全自动安装）：

```powershell
# 用仓库当前版本号，从 plugin-archives 里找包
npm run install:dsh

# 指定某个 tgz（例如别人给的候选包）
npm run install:dsh -- "C:\path\to\<包名>-<版本>.tgz"

# 只验包与环境，不做任何改动
npm run install:dsh -- --dry-run
```

脚本会逐项拦住「装了但没反应」的成因：包名不是 `plantomics-hub`、
`main` 不是 `./dist/dsh/index.js`、`cordis.patch.yml` 的 `name` 与包名不一致
（**这条 dsh 不报错、只是静默跳过**，是本插件最容易踩的坑）、必需文件缺失、tgz 解不开。
通过后它把包复制进 `~/.dsh/plugin-archives/` 并校验哈希，最后打印可粘贴的路径。

> **它不能替你点「添加插件」**——那一步在桌面端进程里，没有 CLI 入口。
> 脚本也不会去改 profile 的 `package.json` 或直接跑 pnpm：那是绕过桌面端管理，出问题难查。
>
> 为什么必须归档：profile 的 `package.json` 记的是**绝对路径**。直接把 `%TEMP%` 里的包路径黏进去，
> 系统清理临时目录后，下次 install 会解析失败。`plugin-archives/` 才是稳的落点。

**然后手动点这三步：**

1. DSH 侧边栏 → **插件** → 右上 **添加插件** → 粘贴脚本给你的完整路径：

   ```
   C:\Users\<你>\.dsh\plugin-archives\<包名>-<版本>.tgz
   ```

   该输入框接受**包名 / Git 地址 / 压缩包 / 本地绝对路径**四种写法；
   **没有文件选择器**，是黏路径或打路径（打了会即时判定类型并显示「压缩包」）。
2. 装完它出现在 **已安装插件** 列表；页面提示重启就重启 DSH（托盘退出再打开）。
   ⚠️ 只关窗口不算重启——版本号会变，但内存里跑的还是旧代码。
3. **新开一个会话**再验证工具——已开着的会话不会因为装插件而重排工具清单。

装好后侧边栏底部会多一个 **组学** 入口（收起到窄轨时只显示徽标），点开是面板：

| 面板里有什么 | 口径 |
|---|---|
| 源、等级、物种、覆盖盲区、版本口径 | 来自各源 `manifest`，构建时生成 |
| 工具名、何时使用、必填参数 | 来自注册表，与模型实际看到的一致 |
| MCP 配置片段 | 一份定义两个出口，复制即用（替换 `<安装目录>`） |

⚠️ **面板是构建期静态快照，不是运行状态。**（其中的源码时间取自 git 提交或 `SOURCE_DATE_EPOCH`，不是墙钟构建时刻） 顶部固定写「静态快照 · 源码 <提交> · 源码时间 … · 包版本 … · 不表示上游当前可用」；
上游是否活着只由 `npm run probe` 回答。面板也不会反映运行时的 `sources` 子集配置（改配置后仍显示全量清单）。

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

## 升级、验证与回滚

升级前保留旧tgz、旧源码提交及客户端配置。DSH使用插件管理页升级，按提示重启并新开会话；模型应能调用 `gwh_assembly_lookup`（entity=assembly，id=GWHAAAA00000000）或 `icg_lookup`（entity=species，id=ICG00115），并保留查询出处。另问一个未覆盖问题，确认不会用错误物种的数据凑答案。静态面板可见不等于查询成功。

MCP更新源码后重新 `npm ci && npm run check`，重启客户端的MCP进程；若调用失败，区分参数错误、上游故障与本地启动路径。先检查命令中的Node及入口**绝对路径**，Windows JSON路径须用正斜杠或双反斜杠；`mcpServers`示例是通用格式，具体客户端的配置文件位置/键名以其官方文档为准。

回滚DSH：通过同一插件管理页重新选择保留的旧tgz，按宿主提示操作、重启并新开会话；若管理器不接受降版，先停用插件，按该宿主官方卸载/重装流程处理，不手改profile依赖或删除数据。回滚MCP：在单独目录checkout已验证旧提交，`npm ci && npm run check`，把客户端命令指回旧目录并重启。没有保留旧包/旧提交时不要承诺可一键恢复。

## 开发

```bash
npm run typecheck   # 类型
npm test            # 单元 + MCP 协议测试（全离线，不联网）
npm run probe       # 可达性实测（联网；任一源失败则非零退出）
npm run stats       # 预算自检（源 ≤20 / 工具 ≤40，超了非零退出）
npm run doctor      # 装机快照自检（已装插件 vs 仓库构建，有实质漂移则非零退出）
npm run install:dsh # 一键安装：验包 + 归档 + 预检（最后一步仍需在插件页点）
npm run check       # typecheck + test + build + stats，提交前最低门槛
```

`npm run build` 除了 `tsc`，还会跑 `scripts/build-client.mjs` 产出 **客户端半边** `dist/client/panel.js`：
它把包名（= 客户端模块 id）与构建期工具清单注入 `src/client/bundle.js`，并在构建期断言
「id 与包名一致、`exports["./client"]` 与 `dsh.client.platform` 已声明、产物语法正确」——
这三件错了在浏览器里的表现都是「装了但没入口」，很难查。清单与注册表漂移由 `test/client.test.ts` 兜住。

**`npm test` 里不许出现真实网络请求。** 上游是否活着由 `probe` 单独回答——两者的红必须能一眼分开。

### `npm run doctor`：为什么需要它

DSH 装插件是 **tgz 解包后的物理拷贝**，不是软链。所以同一份代码同时存在两处：

| 你看到的 | 实际跑的是 |
|---|---|
| 会话里调工具 | 已装快照（`~/.dsh/profiles/<profile>/node_modules/…`） |
| `npm test` / `npm run probe` | 仓库 `dist/` |

两者一分叉，最危险的动作就是「改完代码 → 用工具调用验证 → 以为验过了」，而实际验的是旧拷贝
（§五：静默失效比报错危险）。`doctor` 把这个隐式风险变成随时可查的事实：

```bash
npm run build && npm run doctor     # 实质漂移 → 退出码 1
npm run doctor -- --allow-drift     # 明知未重装，只看报告 → 退出码 0
npm run doctor -- --json            # 机器可读
```

判定口径（2026-10-28 首次实跑后定）：

- **`.js` 先剥注释再比哈希**。只改注释或注释里的引用文字不算漂移——否则每次整理注释都亮红灯，红灯一多就会被 `--skip`。
- 只在一侧存在的文件、`.js` 实质内容不同 → 算漂移，退出码 1。
- **刻意不进 `npm run check`**：开发期未重装是常态，把常态做成红灯等于逼人跳过检查。

> **为什么不用软链省掉这一步？** desktop profile 由 pnpm 托管（`package.json` 里记 `file:…tgz`、
> lockfile 记 integrity），手工把 `node_modules/dsh-plugin-plant-omics` 换成软链有两个后果：
> ① 等于热更新，与本项目「攒一批再装」的做法相反；② pnpm 下次 install 按 lockfile 对账，
> 软链会被静默还原成拷贝。所以选择「不改变安装方式，但让差异可见」。

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

## raw 与隐私边界

`ToolResult.raw` 不进入 MCP/DSH 模型上下文。WheatOmics/Strawberry 保留上游结构；GWH/ICG 的 raw 是源级白名单投影，不是原始响应，也不承诺完整字段或条目。两源对已识别联系人键及邮箱模式做删除/省略，邮箱字符串在投影中置 null；无标签电话、微信及自由文本人名不在自动检查范围，不能视为全面脱敏保证。

## 已知限制

- **上游会间歇性挂。** 2026-10-27 实测：WheatOmics 静态首页 200，而 `/api/*` 在 22:12 之后全部 503（Apache 反向代理返回）。工具会按 `Retry-After` 退避重试（单次调用总时长上限 45 s），但**不能保证每次都成功**。
- **只读。** 不提供任何提交/上传/写库能力。
- **不绕过访问控制。** 需要过 Cloudflare 或登录的源，只登记不实现（见 `docs/源登记表.md` 的 T3 段）。
- **不做数据镜像。** 要批量下载数据，请回各自的科研项目按那边规则走。
- **⚠️ 真实 DSH 会话尚未验收。** 已验证的是：适配器能取数、MCP 协议握手正常、包能干净安装、插件装配形状正确。
  **还没验证**的是：在 DSH 里提问 → 模型自主选工具 → 取数 → 带出处作答，这条完整链路。别把前者当成后者。
- **⚠️ 渐进式发现问题检索尚未实现。** 当前源码候选34个工具全量暴露（规则允许到40个）；已安装快照可能仍是更早版本的 6/11/15 个。「按问题先找源、再找工具」仍属未实现项。
- **侧边栏面板是静态清单。** 只显示构建时的源/工具/盲区，不显示探活或调用统计，也不反映运行时的 `sources` 子集配置；它不能用来判断上游是否可用。
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

侧边栏入口同理：它依赖宿主的 `sidebar.footer.action` 槽位与 `react` / `react-dom` 平台模块表
（按本机已装 `@deepseek-ai/dsh-client-ui-sidebar` 的实际声明核对，2026-10-28）。宿主升级若改了槽位名，
表现是**入口静默消失而工具还在**——先看 `dist/client/panel.js` 是否仍随包安装，再查槽位声明。

---

## 加一个源

照 [`docs/新增一个源.md`](docs/新增一个源.md) 的清单做。核心是三步：**实测定级 → 按实际能力写 manifest 与意图级工具（数量规则见新增源指引） → 抓 fixture 写离线测试**。

---

## 引用

若本工具对你有帮助，引用信息见 [`CITATION.cff`](CITATION.cff)。正式发表前请以仓库最新版本号为准。

设计取舍（为什么不用 zod、为什么单包、为什么输出要有界等）见 [`docs/架构.md`](docs/架构.md)——
这部分是给"应用笔记 / 论文方法节"准备的素材，不只是给开发者看的。

</details>

## License

MIT © 2026 maorong-rong

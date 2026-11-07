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
| **小麦多组学平台（WheatOmics）**（山东农业大学） | T1 | 本仓已封装：小麦族基因、表达、文献、注释ID换算、跨物种同源（wheat/rice/arabidopsis，不区分直系旁系）、变异数据集目录与区间查变异（不含按变异 ID 查）、按基因取序列（本地分块）、按 Pfam 编号查注释；不代表网站全部模块已接入 | 11 | 无 |
| **草莓及相关病原数据平台（Strawberry）**（海南大学） | T1 | 草莓及相关病原：目录和精确基因注释；表达仅已证实草莓数据集、TF仅Fragaria、共线仅已证实装配 | 5 | 无 |
| **基因组仓库（GWH）**（NGDC） | T1 | 精确基因组/组装、项目/样本元数据；物种示例非穷尽，不提供物种搜索 | 2 | 无 |
| **内参基因数据库（ICG）**（NGDC） | T1 | 物种目录及研究验证的内参基因/引物；不提供名称搜索，不作通用推荐 | 2 | 无 |
| **水稻信息平台（IC4R）**（NGDC） | T1 | 仅粳稻（japonica）单物种：基因、功能注释、circRNA、lncRNA、ID 映射，并按染色体分页列 locus；文档为 2018 版，不能按基因名/性状/区间检索 | 6 | 无 |
| **禾本科比较基因组（Gramene）** | T1 | 全文检索、基因、差异表达、分类单元；实测物种只有 Oryza sativa / Indica Group，不声称覆盖禾本科；按 ID 或全文查，不按名称精确匹配 | 4 | 无 |
| **甘蔗多组学数据库（SCOD）**（NGDC） | T2 | 甘蔗（Saccharum spontaneum）及相关材料：基因组目录、按区间查基因（服务端分页）；区间需**包住整条基因**才返回，0 条不代表该位置没有基因；不是主粮 | 2 | 无 |
| **植物基因组数据库（Ensembl Plants）**（EMBL-EBI） | T1 | 共享 REST：**只开拟南芥、水稻、小麦、玉米四个物种**（响应侧再核 `species`，同 host 也服务脊椎动物）；按符号/ID 查基因、取序列（本批仅 `genomic`）、外部 ID 映射；**查无是 HTTP 400 而非 404**，批量 `POST /lookup/id` 本批未接 | 3 | 无 |
| **蛋白互作数据库（STRING）**（EMBL） | T1 | 实测拟南芥（3702）与水稻（39947 / 4530）：标识符解析成 STRING ID、按 ID 取互作伙伴（含 score）；**不传 species 时上游会跨物种乱解析，本仓强制必填**；未接 `/api/json/interactions`（只处理单标识符单物种） | 2 | 无 |
| **蛋白知识库（UniProt）** | T1 | 蛋白条目：按 ``organism_id``（只开 3702 拟南芥 / 4565 小麦 / 39947 水稻 / 4577 玉米四个已实测物种）+ ``gene``/``accession`` 检索，或按精确 accession 取单条；**不返回序列本体、不做比对、不接 POST 的 ``idmapping``、不分页**；同基因常多条 reviewed/unreviewed，不替用户挑一条；上游 404 = 没有此条目，不是源坏了 | 2 | 无 |

<!-- counts:begin -->
> **当前源码口径：10 源、41 工具（含 2 个元工具）。** 本块由 `npm run counts -- --write` 从 `dist/` 实测生成，勿手改；已发布包能装到什么另见 `npm run counts -- --published`（两者可以不同，发布滞后不是索引写错）。
<!-- counts:end -->

> 对外只提供两种接入方式（远端入口 / 本地 stdio），见下方「接入」。0.7.x 及更早的 `dsh-plugin-plant-omics` 是旧形态，与本包不可同时启用。
>
> 已验证：源码离线检查、候选包构建与包内内容一致性、六源最小 HTTP MCP 回放（回放覆盖 6 个源，不等于全部源都有回放）、服务层安全反例。**未验证**：真实宿主装载新包、动态刷新、公网链路的端到端呼叫。npm 上已发布的版本以 `npm view plantomics-hub dist-tags.latest` 现查（本行不写死）；**包内实际数量以 `npm run counts -- --published` 现查，本行不写死**。源等级与实测以[源登记表](docs/源登记表.md)为准。

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
| `wheatomics_sequence` | 按基因 ID 取基因或蛋白序列的**一个本地分块**；不接区间、不覆盖全植物；同 ID 完全相同的 FASTA 去重、不同记录报错不拼接；`offset` 是去重后单条序列的**本地 1 起位置，不是基因组坐标**；只有已验证的 by-gene JSON 404 才判"本次未找到" |
| `wheatomics_gene_annotation` | 按 **Pfam 结构域编号**（如 `PF00319`）查注释，只查默认注释表；不是按基因 ID 查详情，不覆盖区间注释或全植物；**坐标单位是 Mb**；本地裁剪并报总数与展示数，不是上游分页 |
| `wheatomics_cross_species_homologs` | 按基因 ID 查小麦/水稻/拟南芥同源基因；**不区分直系与旁系**（上游无该字段），`max_targets` 是**每物种**上限 |
| `wheatomics_variant_datasets` | 列出变异数据集及 `genome_concordant` 标志；该标志未知时显示"未知"，不替上游推断 |
| `wheatomics_variant_query` | 按区间查变异：`dataset` + `region`（**单个字符串** `chrom:start-end`，闭区间两端都含）；**`total=0` 不代表该区间没有变异**，正文会提示先确认数据集 `genome_concordant`；上游未给 `total` 时按结构漂移报错、不当作 0 条；返回的 `dataset` 与请求不符会拒绝展示；**计数分三层 + 两个缺口**：`命中 M 条；本次取回 R 条；正文展示 N 条`，缺口一「另有 X 条（本页内）未展示」（可减小 `limit` 或缩小区间，恒等式 `展示 + 本页未展示 = 本次取回`）、缺口二「另有 Y 条未取回」（`limit` 未到 100 时可调大，否则只能缩小区间，恒等式 `本次取回 + 未取回 = 命中`）；**两个缺口不许合并成一句「另有 N 条」**；正文展示数必须等于表格实际行数；`limit` 入参**保持 1–100 不变**（上游默认 200、上限 5000），体积由**输出侧** 1208 B 字节闸保证；**本仓不暴露 offset**（上游支持分页）、**也不按变异 ID 查**（上游全表扫描约 19 s，归因本仓不是上游缺陷） |
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
| `ensemblplants_lookup_gene` | 按 `species`（白名单四物种）+ `symbol` 或 `id` 定位单个基因，给 `id`/`assembly_name`/`description`/位置等；**上游用 HTTP 400 表达"未找到"**，本仓按端点+请求身份+完整原体三重锚定才判未找到，未知形态一律报错、不归空；玉米旧编号（`Zm00001d…`，B73 v4）在本源查不到，正文会带当前组装名 NAM-5.0 |
| `ensemblplants_sequence` | 按 `species`+`id` 取序列（`type` 本批**只开 `genomic`**；`cdna`/`cds`/`protein` 与多序列结构未实测，故未开放）；给出实际序列或明示截断与完整长度；物种逐条核验，任一条不符整次拒答 |
| `ensemblplants_xrefs` | 按 `species`+`id`（或 `symbol`）取外部 ID 映射；数组本身可能不含物种字段，故同一请求内先 `lookup` 核验物种与 ID 一致性；空数组只表示本次未返回映射，不代表该基因没有对应记录 |
| `string_resolve_ids` | 把基因名/标识符解析成 STRING ID（**必须给 `species`**：不传时上游会跨物种乱解析，实测 `FT` 会落到小鼠）；返回 `stringId`、taxon 与首选名 |
| `string_interaction_partners` | 按已解析的 STRING ID 取互作伙伴与 `score`；`score` 缺失显示「未提供」，不倒成 0；记录必须回显并绑定请求的 ID，不符整次拒答 |
| `uniprot_search_proteins` | 按 `organism_id`（3702 拟南芥 / 4565 小麦 / 39947 水稻 / 4577 玉米，只开这四个已实测物种）+ `gene` 或 `accession` 检索蛋白条目：accession、基因名、蛋白名、氨基酸长度、`entryType` 已审/未审；**同一基因常多条，不替用户挑一条**；不返回序列本体、不做比对、不接 POST 的 `idmapping`、不分页 |
| `uniprot_get_entry` | 按精确 accession（6–10 位）取单条：条目类型、蛋白名、基因名、氨基酸长度、物种、关键词、是否有序列；不返回序列本体；**上游 404 表示没有此条目，不是源坏了** |

分类分三轴：物种覆盖、数据类型、查询意图；官方MCP/公开API是接入方式，本仓工具是封装层，不重复计源。Strawberry首版仅GET，不包含批量序列、导出、单细胞、表观或GWAS实际查询。HTML404仅说明未获业务响应，不能断定基因不存在。

每个工具的输出末尾都带出处：`源 / 完整请求（含参数）/ HTTP 状态 / 耗时 / 查询时刻`，
数据版本口径另起一行，未知就写未知。单次输出上限 **4 KB（UTF-8 字节）**，超出会截断正文但**保留完整出处**。

### 0.4.0迁移：长请求先拒绝，不省略出处

完整实际URL（含编码后的所有参数）及本地呈现选项合计超过1536 UTF-8字节时，工具在联网前明确拒绝；尾注预留2560B，正文最多1408B。已发布WheatOmics参数名、类型、名义ID数量上限不改，但达到数量上限并不保证能满足字节预算。

例如一次200个长转录本ID的换算可能不再接受：请按原顺序拆成更小批次（如先试10个），若仍超预算继续减小；中文筛选按URL编码后字节计算。不要通过删掉species/version等消歧参数绕过预算。新错误属于兼容性收紧，不能把它当上游无记录。返回完整请求的错误已分别验证MCP文本和DSH工具错误（离线装配，不等同宿主会话）。

---

## 接入（两种方式，二选一）

> 对外只提供这两种接入方式。本项目自己托管的那份实例属于内部实现，不是用户选项。
> 两种方式的工具名都带命名空间前缀（如 `mcp__plantomics-hub__wheatomics_search_known_genes`），输出末尾带出处尾注。

### 方式一 · 零安装：连远端入口（推荐）

**入口** `https://datamcp.moilab.net/mcp`（Streamable HTTP），请求头带 `Authorization: Bearer <token>`。
**token 向维护者申请**（当前没有自助发放渠道）；没带或不对会得到 `401 {"error":"unauthorized"}`。
`GET /healthz` 免鉴权，返回 `{"status":"ok","version":"…","sources":10,"tools":41,"metaTools":2}`，可用来确认入口在线。

**Claude Code**

```bash
claude mcp add --transport http plantomics-hub https://datamcp.moilab.net/mcp --header "Authorization: Bearer <token>"
```

**Codex**（`~/.codex/config.toml`）

```toml
[mcp_servers.plantomics-hub]
url = "https://datamcp.moilab.net/mcp"
bearer_token_env_var = "PLANTOMICS_HUB_TOKEN"
```

token 放环境变量 `PLANTOMICS_HUB_TOKEN`，不写进配置文件；Codex 会自己加 `Authorization: Bearer …`。

**DSH**：在宿主的 MCP 配置里加一条**远端入口**（不是装插件）——transport 选 `streamable-http`，地址同上，加请求头 `Authorization: Bearer <token>`。

**401 与 403 不是一回事**：401 = token 没带或不对；403 = 请求来源未被放行（`Origin` 不在白名单），用户侧遇到时先确认用的是 `https` 入口、请求头拼写完整。

### 方式二 · 本地 stdio：数据不出本机

进程起在你自己的机器上，工具清单就是当前包那一版；适合不想让查询经过公网的人。

```bash
npx -p plantomics-hub@latest plant-omics-mcp
```

**Claude Code**

```bash
claude mcp add plant-omics -- npx -p plantomics-hub@latest plant-omics-mcp
```

**通用 JSON**（Codex / Reasonix / 其它客户端）

```json
{
  "mcpServers": {
    "plant-omics": {
      "command": "npx",
      "args": ["-p", "plantomics-hub@latest", "plant-omics-mcp"]
    }
  }
}
```

> 版本号要写**已发布版本**：先跑 `npm view plantomics-hub dist-tags.latest` 现查，而源码 `package.json` 可能已经更新；用未发布版本号会直接装不上。

### 两种方式都支持：按请求只装你要的源

用请求头 `x-plantomics-sources`，值是逗号/分号/空白分隔的源 id。不带该头的请求行为与全集一致。

```bash
# 这条请求只看得到 icg 与 scod 的工具（外加 hub_* 元工具）
curl -s -X POST https://datamcp.moilab.net/mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <token>' \
  -H 'x-plantomics-sources: icg,scod' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

（方式二没有 HTTP 层，不涉及这个请求头；它按包内注册表全量提供工具。）

约定三条：

| 情况 | 行为 |
|---|---|
| 不带该头 / 头为空 | 与端点注册表一致（默认全集，行为不变） |
| 头里有**注册表没有**的 id | `400 invalid source subset`，`detail` 点名拼错的 id 并列出已登记源；**不许静默返回零工具** |
| 头里有**有但未启用**的 id | `400`，说明当前启用了哪些（服务端环境变量是上限，请求头只能选、不能扩张） |

**两条必须知道的性质**：

1. **这是上下文预算手段，不是权限隔离。** 无状态服务每条请求各自判断：同一客户端下一条请求不带这个头，
   照样拿到全集的全部工具。别把它当成"用户访问不到别的源"——要控访问权得另做鉴权设计。
2. **`initialize` 的 `instructions` 随子集变化，这是有意的。** 其中写明本次启用的源数与工具数，
   并提示"本请求只启用了部分源"。客户端若缓存握手结果，注意它只对那次请求成立。

**`/healthz` 始终报端点全集**，不受该头影响；工具清单以客户端实际收到的 `tools/list` 为准。

### 前置环境

- **方式一**：不需要装 Node，也不需要 DSH；客户端需支持 Streamable HTTP。
- **方式二**：Node.js ≥ 20；客户端需能起本地 stdio 进程。
- 方式一需能访问 `https://datamcp.moilab.net`；方式二需能直连各数据库。
- 没有 API key 要求，但不保证各地区网络均可达。

## 升级与验证

- **方式一**：没有安装物，无所谓升级；能力以入口当时返回的 `/healthz` 与工具清单为准。
- **方式二**：换版本号即升级（`npx -p plantomics-hub@<version> plant-omics-mcp`）；回滚就是把命令改回旧版本，旧版本是否仍在 npm 上以 registry 为准。
- **验证一次真实调用**：让模型调 `gwh_assembly_lookup`（`entity=assembly`、`id=GWHAAAA00000000`）或 `icg_lookup`（`entity=species`、`id=ICG00115`），确认结果里带出处尾注；再问一个未被覆盖的问题，确认它如实说没有覆盖，而不是拿别的物种数据凑答案。
- 改完配置要重启客户端的 MCP 进程（方式二）或重新加载配置（方式一）；已开着的会话不会自动换工具清单。

## 开发

```bash
npm run typecheck   # 类型
npm test            # 单元 + MCP 协议测试（全离线，不联网）
npm run probe       # 可达性实测（联网；任一源失败则非零退出）
npm run stats       # 预算自检（全库只报数；订阅集 > 80 才非零退出）
npm run counts      # 数量事实（源/工具/逐源/构建信息；--json 出机器产物）
npm run doctor      # 装机快照自检（已装插件 vs 仓库构建，有实质漂移则非零退出）
npm run check       # typecheck + test + build + check:counts + check:site + check:wording + stats + check:contracts，提交前最低门槛
npm run check:wording # web/ 措辞闸（离线）：把 token 生命周期写成确定清除就非零退出
npm run check:market # 市场双闸（联网）：数量闸 + 措辞闸，任一道红都指出该改哪边
```

**数量与市场两道闸的分工**（都靠机器核，不靠人记得改）：

| 命令 | 联网 | 锁什么 | 什么时候跑 |
|---|---|---|---|
| `npm run check:counts` | 否 | README 标记块、逐源表格、`/healthz` 示例、**默认加载清单（源 id 与工具数，与 `DEFAULT_SET_SOURCES` 逐项对齐）**、三处预算常量 vs 本地 `dist` | 每次 `npm run check`（已内置） |
| `npm run check:contracts` | 否 | 默认集三处读数必须相等：`/catalog.budget.defaultSetTools` = `hub_status` 正文 = `tools/list` 条数；起临时回环服务走运行时接口，不读源码常量 | 每次 `npm run check`（已内置） |
| `npm run check:wording` | 否 | `web/` 里会误导安全判断的措辞：把「关闭标签页」写成确定清除即失败；README 与输入框提示必须同时有「通常会清除 + 恢复会话可能保留 + 点按钮」 | 每次 `npm run check`（已内置） |
| `npm run counts:published` | 是 | 市场描述的数量短语 vs **npm 上最新 tarball 的真实数量**（重下载、核 sha512） | 发布前后单独跑 |
| `npm run check:market` | 是 | 单一入口，两道都跑：**数字闸**（描述数量短语 vs npm 最新 tarball，含 sha512）＋**措辞闸**（`market/scripts/check-index.mjs`：文案逐字等于 `copy.json`、官方校验器、版本、图标）。任一道红都分别点名并给方向 | 发布前、改市场描述后；**刻意不进 `npm run check`** |

为什么市场要两道而不是一道：`counts:published` 只比数量短语，句中其他措辞不在它的判定范围（把「薄插件」改成「插件」它照样绿）；措辞由 `check-index.mjs` 与 `copy.json` 逐字比对来锁。**两道同绿才算市场描述被锁住**，命名单一入口就是为了不再靠人记两条命令。离线 `check` 里不放联网闸，否则没网就等于红灯。

`check:wording` 拦的不是文风，是**会误导安全判断的断言**：读者会按「关闭标签页即清除」判断风险，所以它必须在提交门槛上，而不是靠谁记得手动跑。这个闸第一次运行就拦下了作者自己文档里引用旧措辞的段落——能拦住作者，才说明它在工作。

`npm run build` 除了 `tsc`，还会跑 `scripts/build-client.mjs` 产出 **客户端半边** `dist/client/panel.js`：
它把包名（= 客户端模块 id）与构建期工具清单注入 `src/client/bundle.js`，并在构建期断言
「id 与包名一致、`exports["./client"]` 与 `dsh.client.platform` 已声明、产物语法正确」——
这三件错了在浏览器里的表现都是「装了但没入口」，很难查。清单与注册表漂移由 `test/client.test.ts` 兜住。

**`npm test` 里不许出现真实网络请求。** 上游是否活着由 `probe` 单独回答——两者的红必须能一眼分开。

### `npm run doctor`：为什么需要它

DSH 装插件是**插件包解包后的物理拷贝**，不是软链。所以同一份代码同时存在两处：

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

> **为什么不用软链省掉这一步？** desktop profile 由 pnpm 托管（`package.json` 里记本地包路径、
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

两种接入方式各有一个口子，按需选用：

- **远端入口（方式一）**：请求头 `x-plantomics-sources: wheatomics,gwh`，见上方「按请求只装你要的源」。
  只影响这一次请求的上下文预算，不是权限隔离。
- **本地 stdio（方式二）**：环境变量 `PLANTOMICS_SOURCES`。

```bash
PLANTOMICS_SOURCES=wheatomics npx -p plantomics-hub@latest plant-omics-mcp
```

⚠️ 写错源 id 会**直接报错并列出可用源**，不会静默变成「零工具」。这个取舍是刻意的：
「装上了但什么都没出现」是最难查的失效。

---

## raw 与隐私边界

`ToolResult.raw` 不进入 MCP/DSH 模型上下文。WheatOmics/Strawberry 保留上游结构；GWH/ICG 的 raw 是源级白名单投影，不是原始响应，也不承诺完整字段或条目。两源对已识别联系人键及邮箱模式做删除/省略，邮箱字符串在投影中置 null；无标签电话、微信及自由文本人名不在自动检查范围，不能视为全面脱敏保证。

## 已知限制

- **上游会间歇性挂。** 2026-10-27 实测：WheatOmics 静态首页 200，而 `/api/*` 在 22:12 之后全部 503（上游网关返回）。工具会按 `Retry-After` 退避重试（单次调用总时长上限 45 s），但**不能保证每次都成功**。
- **只读。** 不提供任何提交/上传/写库能力。
- **不绕过访问控制。** 需要过 Cloudflare 或登录的源，只登记不实现（见 `docs/源登记表.md` 的 T3 段）。
- **不做数据镜像。** 要批量下载数据，请回各自的科研项目按那边规则走。
- **⚠️ 真实 DSH 会话尚未验收。** 已验证的是：适配器能取数、MCP 协议握手正常、包能干净安装、插件装配形状正确。
  **还没验证**的是：在 DSH 里提问 → 模型自主选工具 → 取数 → 带出处作答，这条完整链路。别把前者当成后者。
- **⚠️ 检索层是发现入口，不是按需展开。** `hub_find_sources` / `hub_status` 按「物种覆盖 ∧ 意图能力」给候选源与工具名，未命中时如实说没有覆盖；默认加载清单 10 个源、41 个工具（wheatomics、gramene、ensemblplants、ic4r、strawberry、gwh、icg、scod、string、uniprot）；清单外的源用 `x-plantomics-sources` 或 `PLANTOMICS_SOURCES` 自取（订阅集上限 80 个），「只把命中工具装进会话」的按需展开尚未实现。已发布包的工具更少，实际数量以 `npm run counts -- --published` 现查。
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

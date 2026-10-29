# CHANGELOG

格式照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号用语义化版本。
**破坏性变更（工具改名、必填参数变化）必须在本文件显式标 ⚠️**。

## [plantomics-hub 0.1.0] — 首发候选（未发布；与旧包 dsh-plugin-plant-omics 0.1.0 不是同一条版本线）

### 形态变更（破坏性）

- 包名 `dsh-plugin-plant-omics` → **`plantomics-hub`**；插件改为**薄壳**，自身不注册任何工具。
- 工具改由**远程 MCP 服务**（Streamable HTTP）提供，模型看到的名字带命名空间：`mcp__plantomics-hub__<tool>`。
- 新增服务入口：`npm run serve` / `npx plantomics-hub-mcp`；`/healthz` 提供免鉴权健康检查。
- 服务端版本独立于包版本，形如 `0.1.0+svc.N.g<sha>`；工具集或源集变化时 `svc.N` 递增。

### 新增工具（6 源 28 工具）

- WheatOmics 新增三项：`wheatomics_cross_species_homologs`（跨物种同源，不区分直系/旁系）、`wheatomics_variant_datasets`、`wheatomics_variant_query`（按区间查，`total=0` 不等于该区间无变异）。

### 证据等级

- 上述三工具的 5 个 fixture 为**结构回放件（`simulated: true`）**，上游采集期整体 503；能证明解析自洽，**不能证明上游契约已被真实快照钉住**，恢复后须替换。

## [0.7.0] — 源码集成候选（未构建/打包/发布）

### 新增

- 接入 **Gramene v69**（T1，https://data.gramene.org/v69）：4 个意图工具——`gramene_search`（自由文本 `q`）、`gramene_gene`、`gramene_expression`、`gramene_taxonomy`。默认源码注册表为 **6 源 25 工具**。
- 入口区分：`/search` 收 `q`；其余三个只收 `idList`，描述写明"按 ID、不按名称"。把 `q` 传给非 search 端点只会得到空数组。
- **`idList` 按数组语义发送**：上游对数值型单值（`idList=4530`）返回 400（Expected type array but found type integer），本仓对单值也重复发送一次，并按 `_id` 去重；输出中注明这是规避写法，不隐藏在实现里。
- **身份对账**：gene/expression/taxonomy 会比对"请求 ID 集合"与"返回 `_id` 集合"——返回集合外的 `_id` 直接抛"身份不符"，不把无关记录当结果；请求了未返回的 ID 逐个列在正文与 `raw.missingIds`。
- **`/search` 的 `text/plain`**：该端点 content-type 是 text/plain 而正文是 JSON；本仓按正文解析，不按 content-type 分流，正文非 JSON 时按结构漂移失败。
- 查无语义：Gramene 是 **HTTP 200 + 空数组**（`/search` 为 `numFound=0`），报"本次返回 0 条"；`numFound>0` 且 `start` 越过末页时单独报"已越过末页"，不混为无匹配。
- 裁剪：单基因原始 8.5 KB（含 `xrefs`）只输出关键字段；表达每实验最多 3 个、每实验 2 个比较；`facet_counts` 不读、`ancestors` 只给长度。正文预算仍 1280 B，出处由公共层尾注完整给出。

### 说明

- 覆盖只写实测物种：`Oryza sativa`（taxid 4530）与 `Oryza sativa Indica Group`（39946001），**不声称覆盖禾本科**。
- `taxonomy` 只接受数字 taxid，前导零按数值归一（`04530` 与 `4530` 视为同一 taxid）。
- 数据版本只能写 v69（Swagger basePath）；与 Ensembl 版本的对应关系未核验。
- 版本同步为 0.7.0（`package.json`、lock 根条目、`SERVER_INFO.version`）。**仅到适配器、fixture、离线测试与注册集成，尚未构建、打包、真实探活或宿主验收。**

## [0.6.0] — 源码集成候选（未构建/打包/发布）

### 新增

- 接入 **IC4R**（NGDC 水稻信息共享平台，T1）：6 个意图工具——`ic4r_gene`、`ic4r_annotation`、`ic4r_circrna`、`ic4r_lncrna`、`ic4r_id_convert`，以及按染色体分页发现 locus 的 `ic4r_gene_list`。默认源码注册表变为 **5 源 21 工具**。
- 参数按 ID 空间拆分：gene/annotation/idConversion 用 `locus`；circRNA/lncRNA 用各自 `accession`（`…Circ…`/`…Lnc…`），描述中写明不是同一 ID 空间。
- 查无语义：上游查无是 **HTTP 200 + 0 字节正文**（annotation 为 `[]`）。0 字节报“无法确认是否存在”，`[]` 只表示本次未返回注释，均不判“记录不存在”；`bodyKind` 缺失时报“响应类型未知”而不猜测。
- 预算：正文预算 1280 B（1408−128）。circRNA 实测 182 bp 完整展示；lncRNA 实测 1,639 bp 因预算整条省略并说明“不是上游没有序列，也未截断”；annotation 按类别整块放入，放不下整组省略并报“另有 N 个功能类别未展示”。
- 新增 `ic4r_gene_list`：`chromosome` 仅接受页面下拉给出的 1–12/`Sy`/`Un`（**本仓白名单，不是上游限制**；上游对枚举外取值返回 200 + 零记录），`start` ≥0，`length` 本仓上限 50（上游上限未测），`draw` 固定。区分“记录数为 0”“start 越过末页”“0 字节正文”三种空。

### 说明

- 仅覆盖粳稻（japonica）单物种；接口文档为 2018 版，引用时写“IC4R 2.0（文档声明，2018-05）”，不当作数据版本。
- ID 映射只承诺已测方向（IC4R `locus` → MSU/RAP-DB），反向未测。
- 工具 `name`/`parameters` 为新增，不改既有工具契约；不涉及依赖变更。
- 版本同步为 0.6.0（`package.json`、lock 根条目、`SERVER_INFO.version`）。**本候选仅到适配器、fixture、离线测试与注册集成，尚未构建、打包、真实探活或宿主验收。**

## [0.5.0] — GitHub源码交付候选（未发布Release/npm）

- 新增 GWH 两工具与 ICG 两工具，并注册源级 probe 断言；默认源码注册表为4源15工具，保留按源启用。
- 新增四工具各实体的 MCP/DSH 离线回放、查无与模拟结构漂移验证。两源 raw 使用隐私白名单投影，不是上游原体；隐私检查不覆盖无标签电话/微信/人名。
- HTTP 新增可选 bodyKind：零长度为 empty，合法 JSON 为 json，缺字段未知；旧 data 行为不变。
- 版本及 lock 根版本同步为0.5.0，不重解依赖；旧工具 name/parameters 不变。已完成候选包隔离安装、四源probe及MCP调用验证；本机用户报告已安装，真实DSH问答验收仍未完成。
- 补充源码安装、DSH本地tgz安装、前置环境及回滚说明；辅助安装脚本不替代桌面插件管理器。源码推送不代表已有公开tgz下载入口。

## [0.4.0] — 源码候选（未打包/发布）

### 新增

- Strawberry Data Hub五个GET工具：catalog、gene_lookup、expression、synteny、tf_members；源覆盖描述为草莓及相关病原，按模块限定。批量序列和POST暂缓。
- 真实裁剪fixture及五工具双出口离线回放。TF成员响应未给release时标未知，不能借目录版本；表达和共线HTML404不当生物学不存在。
- 源级probe验证器：genes/status须满足enabled/available为true和示例字段结构；模拟禁用、不可用、漂移、429及CLI非零退出测试。probe仅证明所列端点。

### ⚠️ 兼容性收紧

- 公共出处不再300字符省略。Strawberry及WheatOmics均在联网前检查完整编码URL及呈现选项：超过1536 UTF-8字节明确拒绝，请缩小批次。工具名/参数类型/required不改，但旧版能发出的长ID批次可能不再接受；迁移见README。
- 尾注预留2560B、正文最多1408B，整个工具文本仍不超过4096B；异常上游版本元数据超预算明确失败，不静默切断版本或关键请求。

版本字面量候选同步为0.4.0；未修改MCP/DSH调用协议或依赖，未修改侧边栏实现。离线检查、真实probe、实际包及宿主验收分别报告，不以本条目宣称发布。

## [0.3.0] — 2026-10-28

新增 DSH 的**浏览器半边**：侧边栏「组学」入口 + 一个独立面板。工具契约（`name` / `parameters`）未变，
MCP 出口未变，因此**无破坏性变更**；已装的 0.2.0 可以照常升级。

### 新增

- **侧边栏入口与面板**（`src/client/bundle.js`，手写 lazy-CJS bundle）：注册在 `sidebar.footer.action`，
  点开显示源、工具、覆盖盲区与 MCP 配置说明。不抢占 `sidebar.settings`（single slot，属于设置外壳）。
- **构建期静态清单**（`src/client/catalog.ts`）：从 `ToolRegistry` 生成，构建时注入 bundle。
  面板顶部固定声明「静态快照 · 构建于 … · 不表示上游当前可用」；`lastProbe` **刻意不进清单**，
  不把构建期快照显示成运行状态。
- **`scripts/build-client.mjs`**：构建期断言「模块 id == 包名」「`exports["./client"]` 与
  `dsh.client.platform = "web"` 已声明」「产物语法正确」。这三条错了在浏览器里的表现都是
  「装了但没入口」，所以放在构建期而不是文档里。
- **清单与注册表一致性测试**（`test/client.test.ts`，10 例）：源/工具/必填参数逐项对齐；
  预算常量与 `scripts/stats.mjs` 对齐（漂移即红）；bundle 注册契约、卸载清理、静态文案。

### 变更

- 版本 `0.2.0` → `0.3.0`；`SERVER_INFO.version` 同步（`test/core.test.ts` 的单一来源断言盯着）。
- `npm run build` 在 `tsc` 之后追加客户端构建；产物 `dist/client/panel.js` 随包分发（`files` 已含 `dist`）。
- README 补侧边栏入口说明与「静态快照」口径；`docs/架构.md` §9 记四个决定及其代价。

### 未验证

- **真实 DSH 里入口可见、页面可打开**：待装 0.3.0 后由人确认。离线测试只证明形状与文案，
  不构成宿主层验收（§十一「完成声明与证据层级一致」）。

## [0.2.0] — 2026-10-28

本版本修复输出完整性、结构校验、错误处理与双出口一致性问题。

### ⚠️ 破坏性变更

- **`wheatomics_search_papers` 的参数 `since_days` 改名为 `sinceDays`**（与其余参数统一驼峰）。
  旧名不再被静默忽略：`invokeTool` 现在会校验 `additionalProperties`，传旧名会得到
  「未知参数：since_days」的明确报错。上游查询串仍是 `since_days`，改的只是对外参数名。

### 修复

- **表达查询会把籽粒条件裁掉且不显示标准差**（R02）：条件 ≤20 个时全部展示；输出 `均值±标准差`；
  新增 `condition`（按条件名过滤）与 `top`（超量时取前 N，按表达量降序）两个参数。
- **上游改字段被当成「查无结果」**（R03）：新增 `src/core/shape.ts`；关键容器缺失/类型错抛
  `UpstreamShapeError`，只有真的 `[]` 才算 0 条。
- **DSH 出口把配置错误降成可选日志**（R04）：`apply()` 同步阶段抛配置错误；工具注册「部分失败告警、
  全部失败抛」；拿不到 `tools` 服务时优先用 logger，无 logger 才抛。
- **输出预算不是字节口径**（R05）：`result()` 统一按 UTF-8 字节截断，先扣出处预算；出处尾注永不被截断。
- **缺值被渲染成 0**（P1）：新增 `toNum()`，`null`/`undefined`/`''` 一律渲染为 `-`，不再编造 `0 ± 0`。
- **45 s 总时长上限没生效**：每次请求的超时按剩余预算取 `min(timeout, remaining)`。
- **退避档位错位**：`BACKOFF_MS` 改为 `[400, 1200]` 并按"第几次重试"索引；429/503 优先服从 `Retry-After`（上限 10 s）。
- **MCP 出口丢弃取消信号**（R08）：两出口统一走 `src/core/invoke.ts`，传 `extra.signal` / `exec.signal`。
- **两出口错误说法不一**：DSH 侧也走 `describeError`。
- 注册表**非原子**：先全量校验再落库，抛错后不留半个注册表。
- 出处尾注只有 pathname（R06）：改为 `完整请求（含参数）/ 时间 / 版本口径`；超长查询串截到 300 字符并标注总长。
- `Math.min(...arr)` 在大数组上可能 RangeError：改 `reduce`。

### 新增

- `src/core/shape.ts`（入参 + 上游结构校验）、`src/core/invoke.ts`（两出口共用调用入口）
- `npm run stats` 预算自检，打印**紧约束是源还是工具**；已并入 `npm run check`
- `scripts/probe.mjs` 增加**业务信封判定**（`success:false` / `code≠200` 也算失败）与 `expect:'json'|'any'`（为 T2 预留）
- 测试 34 → **70 例**：新增 `test/http.test.ts`（重试/超时/取消/Retry-After/总预算）、`test/core.test.ts`（字节截断/结构校验/入参校验/注册表原子性/版本一致性）
- MCP 工具声明 `annotations.readOnlyHint: true`

### 变更

- 工程约束：输出预算改字节口径；出处要求含完整请求与时刻；`check` 纳入 build+stats；
  §10.2 重写（**20 个源 ≠ 120 个常驻工具**）+ 检索层三条验收标准；删除规则里的现状段。
- `README`：安装自查删掉不可执行的 `--dump-config` 一项；补「未验收宿主闭环 / 渐进式发现未实现 / 上游限流 / 输出按数据处理」四条限制。
- `docs/源登记表.md`：版本口径改为「只转述上游、不判定」，并更正此前 IWGSC v1.1 / v2.1 的转述不一致。
- `docs/新增一个源.md`：明确**信封按源各自处理**，不许照抄 WheatOmics 的解包器；补 `stats` 验收步骤。

## [Unreleased]

### 隐私与公开发布

- 排除内部记录、工作区规划、本机配置与临时产物；以 GitHub 用户名署名。
- 修正公开文档中指向内部材料的引用，补充可折叠的使用说明。

### 新增

- **`npm run stats` 预算自检**：打印源数 / 工具数 / 剩余额度，源 > 20 或工具 > 40 时非零退出
- **按源启用子集**（对应「各团队独立入口、边做边积累」）：
  `createRegistry({ enabled })`、环境变量 `PLANTOMICS_SOURCES`、dsh 插件配置 `sources`。
  传未知 id 直接抛错并列出可用源——不让它静默变成「零工具」。
- `CITATION.cff` 可引用元数据
- README 新增「只启用部分源」「兼容性」「引用」三节

### 变更

- 工程预算明确为最多 20 个**库**；
  工具总数 > 40 时**必须先实现检索层**，否则不许继续加源

### 文档

- README 的 DSH 安装段重写：先完全退出 DSH → `npm pack` 到 `plugin-archives/` →
  **必须被选进 `dsh.profile.bundles` 才会加载**（原先没写，是个会卡半天的坑）
- 源登记表补充 Strawberry Data Hub 的 Data API 核查信息。

## [0.1.0] — 2026-10-27

### 新增

- 地基：`src/core`（契约 / HTTP / 注册表硬校验 / 输出排版）
- 两个出口：stdio MCP server（低层 `Server`，纯 JSON Schema）与 DSH 原生插件
- 样板源 **WheatOmics**（T1，山东农大）6 个工具：
  - `wheatomics_search_known_genes`
  - `wheatomics_gene_detail`
  - `wheatomics_expression_projects`
  - `wheatomics_expression_query`
  - `wheatomics_search_papers`
  - `wheatomics_convert_gene_ids`
- 可达性实测脚本 `scripts/probe.mjs`（任一源失败即非零退出）
- 离线测试 26 例（单元 18 + DSH 装配 5 + MCP 协议握手 3）

### 说明

- 首批只接一个源，目的是先证明"骨架 + 真实接口"能端到端跑通；加源照 `docs/新增一个源.md`。
- 2026-10-27 当天上游 `/api/*` 出现过 503（反代层返回），非本仓问题，详见 `docs/源登记表.md` §四。

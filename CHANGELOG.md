# CHANGELOG

格式照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号用语义化版本。
**破坏性变更（工具改名、必填参数变化）必须在本文件显式标 ⚠️**。

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

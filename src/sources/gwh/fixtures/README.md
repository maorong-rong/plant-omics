# GWH fixtures（真实裁剪快照 + 标注模拟）

采集：2026-10-28（UTC 时刻见各文件 `capture.at`；本机 Windows 直连，未开代理）；`curl.exe` 顺序单发，间隔约 350 ms，未鉴权、未重试、未并发。
API base：`https://ngdc.cncb.ac.cn/gwh/api/public`；官方文档 `https://ngdc.cncb.ac.cn/gwh/api_documents`。

所有 JSON 用 `{capture, payload}` 包装：`capture` 记完整 URL、UTC 时刻、HTTP 状态、content-type、原始字节数与裁剪说明；适配器回放的是 `payload`。`capture.simulated: true` 的文件是**人为注入的模拟反例**，不是上游真实响应。

| 文件 | 请求 | 观测与裁剪 |
|---|---|---|
| [genome.json](genome.json) | `GET /genome/1` | 200 / 422 B；无裁剪。`id` 与 `taxId` 在上游都是**字符串**（`"1"`、`"333970"`），适配器按 `String()` 对账 |
| [genome-missing.json](genome-missing.json) | `GET /genome/999999999` | 200 / 364 B；`id`/`organism`/`taxId`/代表组装全 `null`，`otherAssembliesCount` 仍是字符串 `"0"`。**查无判据只用 `id`+`organism`**，不绑定 `otherAssembliesCount` |
| [assembly.json](assembly.json) | `GET /assembly/GWHAAAA00000000` | 200 / 1,803 B；**删除 `contacts`（姓名+邮箱）与 `submitterOrganization`**（后者可能是个人名），其余字段原样。`publication` 实测是**含作者姓名的题录字符串**，未列入白名单，工具不输出它，只给 `publicationLink`（DOI） |
| [assembly-missing.json](assembly-missing.json) | `GET /assembly/GWHZZZ00000000` | 200 / 588 B；GWH 形态但不存在，全部字段 `null`，**无 `message` 键** |
| [assembly-not-an-accession.json](assembly-not-an-accession.json) | `GET /assembly/NOT_AN_ACCESSION` | 200 / 588 B；非 GWH 形态，上游**同样回全 `null`**，与查无不可区分。这就是适配器在**本地拒绝非 GWH 形态**的证据（不是凭空猜测的语法限制） |
| [assembly-with-contact.json](assembly-with-contact.json) | 同上（**模拟**） | 在真实结构上注入虚构 `contacts`/`submitterOrganization`（`@example.org`），用于断言输出、`raw`、错误文本都不含联系方式 |
| [bioproject.json](bioproject.json) | `GET /bioProject/PRJCA000437` | 200 / 20,905 B；**删除 `submitter`**（email/phone/firstName/lastName 等）；`listPublication` 13 → 前 2 条并删除每条的 `project` 嵌套对象；`taxons` 1 条。**测试不得把 2 当上游总数**，工具只报"本次返回 N 条" |
| [bioproject-missing.json](bioproject-missing.json) | `GET /bioProject/PRJCA999999999` | 200 / 440 B；`message:"Nonentity"`、`prjAccession` 回显输入、`title:null`。`submitter` 为 `null`，保留以断言 `null` 提交者不被展示 |
| [biosample.json](biosample.json) | `GET /bioSample/SAMC012932` | 200 / 5,488 B；**删除 `submitter`**（姓名/邮箱/电话）与 `taxon.ancestors`（23 层）；`sampleAttribute` 只保留白名单 7 键，删除其 `sample` 嵌套对象；保留 `sampleId`/`userId` 以断言不输出。`sampletype` 实测是**对象**，工具取 `sampleTypeName` |
| [biosample-missing.json](biosample-missing.json) | `GET /bioSample/SAMC999999999` | 200 / 211 B；`message:"Nonentity"`、`accession:null`、`sampleId:0`、`userId:0` |

## 这些 fixture 不能证明什么

- 不代表四类端点长期可用；只证明 2026-10-28 这一天这些请求的响应形状。
- `Notentity`/全 `null` 只能证明"这次请求没拿到记录"，不能证明该 ID 从未存在。
- 文件下载路径只证明字段存在，没有下载、没有校验可下载性（基因组包实测 389,670,521 B）。
- 模拟反例只用于隐私断言，不能当上游结构证据。

## 隐私

真实响应里确实带个人联系方式（`contacts`、`submitter`、文献条目里的嵌套 `project.submitter`），已在 fixture 中删除；保留的模拟反例使用 `@example.org` 虚构地址。适配器的 `ToolResult.raw` 是白名单投影，不是上游原体。

**复查（2026-10-28）**：对本目录全部真实 fixture 递归扫描邮箱模式 → **0 命中**；`assembly-with-contact.json` 是标注 `simulated` 的反例，命中属预期。这只覆盖"邮箱模式"这一项检查，不等于隐私全面保证（无标签电话、微信号、自由文本人名不在检查范围）。

# Strawberry GET fixtures（真实裁剪快照）

采集日期：2026-10-28，UTC 07:35:56–07:36:14（北京时间15:35–15:36）。本机 Windows，Node.js 内置 fetch，顺序低频 GET，每次完成后间隔约1秒；无鉴权、无POST、无批量、无导出，未触发429。先读[官方OpenAPI](https://sci.hainanu.edu.cn/strawberry/api/v1/openapi.json)参数再请求。本轮完整请求与采集信息均记录在下表及各文件capture中，不依赖仓外或未公开的过程记录；旧记录不作为本轮新实测。

所有JSON文件使用 `{capture,payload}` 包装。`capture`包含完整实际URL、UTC时刻、HTTP状态、content-type、原始字节数和裁剪说明；适配器回放的是`payload`，而非包装对象。原始大响应不落地、不放模型上下文；实际数字不因裁剪重写。没有裁剪标记的payload为完整小响应。

API base：`https://sci.hainanu.edu.cn/strawberry/api/v1`。完整绝对请求见各capture.url。

| 文件 | GET路径和参数 | 观测与裁剪 |
|---|---|---|
| [catalog.json](catalog.json) | `/catalog` | 200 JSON，98703 B；保留全部15模块、limits、目录时间；assemblies.items只保留前3项（原60），删studyResources及genomeDownloads。测试不得把3当真实上游总量。 |
| [genes-status.json](genes-status.json) | `/genes/status` | 200 JSON，12374 B；enabled/available均布尔true，examples数组60项，每项species/version/geneId；保留完整正常小响应供probe回归。examples不是穷尽覆盖。 |
| [gene-lookup.json](gene-lookup.json) | `/genes/search?geneId=BCIN_01g00010` | 200 JSON，1837 B；Botrytis cinerea，响应版本原字符串，蛋白310 aa，无裁剪；CDS/蛋白不会默认进入工具文本。 |
| [gene-lookup-404.json](gene-lookup-404.json)、[HTML摘录](gene-lookup-404.html) | `/genes/search?geneId=NOT_A_REAL_GENE_999` | 404 text/html，4689 B；保留前600字符，不转成成功JSON或生物学不存在。JSON为采集包装，其payload是HTML字符串。 |
| [expression.json](expression.json) | `/transcriptome/search?geneId=FvesChr1G00279070.1` | 200 JSON，31260 B；保留全部9个组织聚合，samples仅前2项（原233）；detectedSamples=233不是自行推定的总样本数。单位原文batch-corrected TPM。 |
| [expression-empty.json](expression-empty.json)、[HTML摘录](expression-empty.html) | `/transcriptome/search?geneId=NOT_A_REAL_GENE_999` | 404 text/html，4689 B；不是成功的空组织/零表达，保留HTML前600字符。 |
| [synteny.json](synteny.json) | `/synteny/search?sourceAssembly=fxa_benihoppe&geneId=Fxa1Ag00001&targetAssembly=fxa_camarosa` | 200 JSON，7561 B；保留全部3块及总数、truncated=false、两个装配和analysisId；各context仅前1项。 |
| [synteny-empty.json](synteny-empty.json)、[HTML摘录](synteny-empty.html) | `/synteny/search?sourceAssembly=fxa_benihoppe&geneId=NOT_A_REAL_GENE_999&targetAssembly=fxa_camarosa` | 404 text/html，4689 B；不是成功的空共线块，保留HTML前600字符。 |
| [tf-summary.json](tf-summary.json) | `/tf/search` | 200 JSON，22576 B；mode=summary，total=166947，matches=[]，pageSize=0；保留release，各summary集合仅前2项；本工具禁止无筛选请求及意外summary。 |
| [tf-matches.json](tf-matches.json) | `/tf/search?family=ERF&page=1&pageSize=2` | 200 JSON，1007 B，total=10677、返回2条。summary=null，因此这次release未知，不能拿另次summary请求的release冒充。 |
| [tf-empty.json](tf-empty.json) | `/tf/search?family=NOT_A_FAMILY&page=1&pageSize=20` | 200 JSON，94 B；mode=matches、total=0、matches=[]，已验证合法空结果。 |

参数核查：本轮先取`/openapi.json`（200 JSON），只打印GET参数摘要，不持久保存229 KB文档。geneId/species/version、dataset、sourceAssembly/targetAssembly名称与证据一致；TF family/species/assembly在OpenAPI为可重复form数组，本工具只传单值；type为字符串；page/pageSize为整数。仅family+page+pageSize组合实际请求过，其他组合有文档声明但不冒称已实测。本地module/top/maxBlocks/includeSequence不发往上游，进入完整出处呈现参数；maxShown=20亦记录。

测试内对正常payload的删字段、错类型、超长metadata、伪summary、空数组、超范围/多字节输入及429等均为**模拟反例**，不伪装为真实fixture。表达/共线尚未确认成功空数组业务形态，遇见空数组报结构语义不明，不能默认为零表达/无共线。404只能证明请求未获业务JSON，不能证明基因生物学不存在。

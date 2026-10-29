# fixtures 说明

这些 JSON 是**真实响应的裁剪版**，不是编的，也不是全量。

| 文件 | 真实请求 | 抓取日期 | 裁掉了什么 |
|---|---|---|---|
| `known-search.json` | `GET /genes/known/search?searchid=VRN1` | 2026-10-27 | `records` 只留前 3 条（原始 16 条） |
| `gene-detail.json` | `GET /genes/detail/TraesCS5A02G391700` | 2026-10-27 | 未裁剪 |
| `expression-projects.json` | `GET /expression/projects` | 2026-10-27 | `projects` 从数百条裁到 5 条（每个 group 留一条）；原始响应约 600 KB |
| `expression-query.json` | `GET /expression/query?gene_ids=TraesCS5A02G391700&project=PRJEB5314_paired_tbl` | 2026-10-27 | 未裁剪 |
| `papers.json` | `GET /papers?q=vernalization` | 2026-10-27 | `papers` 只留前 3 条（原始 20 条 / total 256） |
| `id-conversion.json` | `GET /id-conversion?ID=TraesCS6B01G342500.1&gene_version=IWGSCv1_result` | 2026-10-27 | 未裁剪 |

## ✅ 2026-10-29 已换成真实抓取（合成件已全部淘汰）

上游恢复后重新采集，5 个文件**全部为真实响应**，`capture.simulated = false`，原始字节数与故障前一致：

| 文件 | 请求 | 字节 | 形态 |
|---|---|---|---|
| `homologs.json` | `GET /homologs/wheat-rice-arabidopsis?gene_id=TraesCS5A02G391700&max_targets=3` | 1,777 | 200，`count=6`，Rice 3 + Arabidopsis 3 |
| `homologs-empty.json` | 同上，`gene_id=TraesCS9Z99G999999` | 141 | 200，`count=0`、`hits=[]` |
| `variant-datasets.json` | `GET /VariantHub/datasets` | 6,675 | 200，3 参考基因组 / 29 数据集 |
| `variant-query.json` | `GET /VariantHub/query?dataset=whealbi_minocc10&region=chr1A:1-200000&limit=2` | 9,398 | 200，1 条记录；`samples` 487、`genotypes` 487 原样保留 |
| `variant-query-empty.json` | 同上，`region=chr1A:1-100` | 4,697 | 200，`total=0`、`records=[]` |

**真实数据纠正了我此前三处合成假设（都写在测试里了）**：

1. **`genome_concordant` 比例反了**：真实是 **27 个 true、2 个 false**（`WEC_filtered_SNPs`、`WEC_filtered_INDELs`），我合成时几乎全留空。
2. **`references[].name` 才是参考基因组字段**，不是 `reference`。我原来优先读 `reference`、回退 `display`，导致拿不到稳定标识——已修。
3. **`qual` 是点号** `"."`（不是数值），`filter` 是 `"PASS"`，与实测一致。

**`info.ANN` 的真实字段序**（这条修正过一个真 bug）：`Allele|Consequence|IMPACT|SYMBOL|Gene|...`，索引 0 是等位基因。原来取 `parts[0..2]` 会把基因 ID 整列错位。

## 坐标基数：仍不能声称"上游是 1-based"

边界实验（2026-10-29，上游恢复后）结果：

| region | 结果 |
|---|---|
| `chr1A:168831-168831` | **400** `Region length must be > 0 and <= 5000000 bp`（长度按 `end − start` 算） |
| `chr1A:168831-168832` | 200，命中 pos=168831 |
| `chr1A:168832-168833` | 200，0 条 |
| `chr1A:168830-168831` | 200，命中 pos=168831 |

②③ 看似半开区间，但 ④ 的 `end=168831` 若排他就不会命中，**四次不足以定死端点语义**。能确定的只有 **`start === end` 非法**（上游按 `end − start` 校验长度）。因此：

- 本地增加 `start < end` 校验，单位点查询在本地就拒绝并提示用 `pos-1-pos+1`；
- 正文与描述**不写"上游是 1-based"**，只写"按 1-based 处理，上游基数未证实"。

## 四类结果必须分开（不许混淆）

| 结果 | 形态 | 本仓行为 |
|---|---|---|
| 区间非法（`start == end` 等） | **400** + `Region length must be > 0` | 本地先拒，零请求；若上游返回 400 → `UpstreamError`，**不当查无** |
| 服务不可用 | **503** + Apache HTML | `UpstreamError`，明确"上游不可用" |
| 查无 | 200 + `total=0` + `records:[]` | 成功文本 + "0 条不等于该区间没有变异" |
| 正常 | 200 + records 非空 | 表格 + 出处 |


## 为什么裁剪

1. **PR diff 可读**：全量 fixture 会让每次改动变成几千行噪音，review 时没人看。
2. **断言只关心结构**：测试要证明的是"我们能正确解析和排版"，不是"上游有 256 篇文献"。
3. **仓库体积**：600 KB 的单个 fixture 进 git 就没法回头了（真实大响应应裁剪后入库）。

## Pfam 注释回放（2026-10-29）

- `pfam-pos.json`：`GET https://wheatomics.sdau.edu.cn/api/genes/functions/pfam?ID=PF00319`，原始响应111440 B，HTTP 200；保留全部358条记录及原始count，仅裁字段为gene_primary、chromosome、start_mb、end_mb、domain，未伪造分页。
- `pfam-neg.json`：同端点`ID=PF999999`，原始响应167 B，HTTP 200，原始count=0、records=[]。
- 请求日期和原始字节数在capture中；完整原响应时间戳保留。采集由调研者完成，本次只做离线裁剪与回放，不冒充新probe。正文与raw不透传描述或任意额外字段。

## 基因序列回放（2026-10-29）

- `sequence-pos.json`：`GET https://wheatomics.sdau.edu.cn/api/sequence/by-gene?gene_id=TraesCS5A02G391700`，原体2380 B、HTTP 200 JSON。只保留gene_id、gene_sequence、protein_sequence；FASTA正文未改，保留上游重复记录用于验证去重。gene两条同名同内容、各735碱基；protein两条同名同内容、各244残基。1611/617是含头行和换行的字段字符数，不是生物序列长度。
- `sequence-neg.json`：同端点`gene_id=TraesCS9Z99G999999`，原体104 B、HTTP 404 JSON，保留detail用于验证精确查无结构。其他404不自动判查无。
- 本次只用调研者交接的保存响应离线裁剪；没有新probe，也不接区间分支。工具输出不透传FASTA自由头、附加序列或未选类型的序列。

## 维护约定

- **上游改字段时**：重新抓一份、按同样规则裁剪、覆盖；**不要手改**导致 fixture 与真实响应不一致。
- **fixture 里不许有** token / cookie / 个人信息。
- fixture 与 `test/` 里的断言是配套的：改 fixture 必须看测试是否还需要改。

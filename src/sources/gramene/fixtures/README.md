# Gramene fixtures（真实快照 + 400 错误证据）

采集：2026-10-28（UTC 时刻见各文件 `capture.at`；本机 Windows 直连，未开代理），`curl.exe` 串行、间隔约 400 ms，未鉴权、未重试。
API base：`https://data.gramene.org/v69`；文档 `https://data.gramene.org/v69/swagger`（Swagger 2.0，basePath `/v69`）。

只有 `genes.json` 做了裁剪，其余正例与负例都是原样保存。

| 文件 | 请求 | 观测 |
|---|---|---|
| [genes.json](genes.json) | `GET /genes?idList=BGIOSGA001967` | 200 / 8,520 B；**数组**，单条基因文档。裁剪：删除 `xrefs`（外部交叉引用，占响应主体）与 `gene_idx`；`_id/name/description/biotype/taxon_id/system_name/db_type/location` 原样保留 |
| [genes-empty.json](genes-empty.json) | `GET /genes?idList=NOT_A_REAL_ID` | 200 / 5 B；正文 `[\n\n]`，**空数组**就是查无形态，不是 404 |
| [expression.json](expression.json) | `GET /expression?idList=BGIOSGA001967` | 200 / 1,405 B；数组，单条记录按 `E-*` 实验给出 `[{group,p_value,l2fc}]`。原样保留 |
| [expression-empty.json](expression-empty.json) | `GET /expression?idList=NOT_A_REAL_ID` | 200 / 5 B；空数组 |
| [taxonomy.json](taxonomy.json) | `GET /taxonomy?idList=39946001&idList=4530` | 200 / 790 B；两条分类单元文档（`_id`、`name`、`rank`、`num_genes`、`ancestors` 为 taxid 链） |
| [taxonomy-dup-single.json](taxonomy-dup-single.json) | `GET /taxonomy?idList=4530&idList=4530` | 200 / 375 B；**只有 1 条文档**。这说明"数值型单 ID 重复一次发送"的规避写法输出正确，不是伪造数据 |
| [taxonomy-single-numeric-error.json](taxonomy-single-numeric-error.json) | `GET /taxonomy?idList=4530` | **400** / 420 B；`Expected type array but found type integer`。这是上游校验器行为，本仓据此对单值数字重复一次发送 |
| [search.json](search.json) | `GET /search?q=Oryza&rows=2` | 200 / 1,759 B；**content-type 是 `text/plain`，正文才是 JSON**。Solr 风格 `responseHeader/response{numFound:87462,docs[]}` |
| [search-empty.json](search-empty.json) | `GET /search?q=NOT_A_REAL_THING_XYZ&rows=2` | 200 / 432 B；`numFound:0`、`docs:[]`，仍是 text/plain |

## 这些 fixture 不能证明什么

- **覆盖**：只实测 `Oryza sativa`（taxid 4530）与 `Oryza sativa Indica Group`（39946001），**未逐物种采样**，不能推广成“覆盖禾本科”。
- `numFound=87462` 是那一次 `q=Oryza` 的上游命中数，不是工具展示数。
- `expression` 的 `p_value`/`l2fc` 是上游原值；fixture 不含实验条件名称与样本量，工具也不做显著性判定。
- `taxonomy` 的 `ancestors` 只是 taxid 链，没有名称。
- 400 那条只证明“数值型单值会被拒绝”，不证明其他错误形态。

## 隐私

Gramene 响应未见个人字段（基因描述里可能出现数据库 accession，不是联系方式）。工具仍统一做“整行邮箱扫描 + raw 投影扫描”。

**复查（2026-10-28）**：对本目录全部非 `simulated` 真实件递归扫描邮箱模式 → **0 命中**；测试内有自动断言。

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

## 为什么裁剪

1. **PR diff 可读**：全量 fixture 会让每次改动变成几千行噪音，review 时没人看。
2. **断言只关心结构**：测试要证明的是"我们能正确解析和排版"，不是"上游有 256 篇文献"。
3. **仓库体积**：600 KB 的单个 fixture 进 git 就没法回头了（真实大响应应裁剪后入库）。

## 维护约定

- **上游改字段时**：重新抓一份、按同样规则裁剪、覆盖；**不要手改**导致 fixture 与真实响应不一致。
- **fixture 里不许有** token / cookie / 个人信息。
- fixture 与 `test/` 里的断言是配套的：改 fixture 必须看测试是否还需要改。

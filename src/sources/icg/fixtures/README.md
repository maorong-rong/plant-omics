# ICG fixtures（真实裁剪快照 + 标注模拟）

采集：2026-10-28（UTC 时刻见各文件 `capture.at`；本机 Windows 直连，未开代理）；`curl.exe` 顺序单发，间隔约 350 ms，未鉴权、未重试、未并发。
API base：`https://ngdc.cncb.ac.cn/icg`；官方文档 `https://ngdc.cncb.ac.cn/icg/api`。

所有 JSON 用 `{capture, payload}` 包装；`capture.simulated: true` 的是**人为注入的模拟反例**。

| 文件 | 请求 | 观测与裁剪 |
|---|---|---|
| [species.json](species.json) | `GET /api/json/species/ICG00115` | 200 / 2,757 B；`Zea mays`、`category=Plants`、`studyNumber=3`、`projectList` 3 条。裁剪：`projectList` 保留前 2 条并删除每条的 `contactName/contactEmail/hostInstitution`；删除 `result.image` |
| [project.json](project.json) | `GET /api/json/project/ICG00115-1` | 200 / 4,238 B；`geneList` 2 条全保留（含完整引物）。裁剪：删除 `contactName/contactEmail/hostInstitution`；删除 `publication.abst`（摘要，约 2.8 KB） |
| [project-with-contact.json](project-with-contact.json) | 同上（**模拟**） | 注入虚构 `contactName/contactEmail`（`@example.org`）与 `publication.abst`，用于断言输出、`raw`、错误文本都不含联系方式 |
| [gene.json](gene.json) | `GET /api/json/gene/ICG00115-1-EF1a` | 200 / 1,414 B；**响应确实含嵌套 `result.project` 对象**（不是"无 project"），已删除该对象里的 `contactName/contactEmail/hostInstitution`，其余字段保留。**工具选择平铺的 `projectAccession`，不读取嵌套 project**；`primersForward/Reverse` 是完整短序列 |
| [publication.json](publication.json) | `GET /api/json/publication/24810581` | 200 / 2,828 B；裁剪：删除 `result.abst`；`projectList` 1 条并删除其联系人与冗余字段 |
| [not-found.json](not-found.json) | `GET /api/json/project/ICG00115-Pro-1` | 200 / **55 B**；`payload` 逐字节原样：`{"code":"300","message":"No valid data!","result":null}`，末字节 `}`，**无尾随 LF**。另有独立观测记录为 55 B 且**含**行尾 LF（`7D 0A`）——两次响应不合并成一个结论，判据只看解析后的 `code==="300" && result===null`，不按字节比对。本仓未保存"带 LF"那一份字节，不冒充 |
| [species-list.json](species-list.json) | `GET /rest/species/category/?draw=1&start=0&length=3` | 200 / 4,515 B；DataTables 信封 `{draw,recordsTotal=540,recordsFiltered,data[],error}`。裁剪：`data` 3 行，每行删除 `description/projectList/image/isFeatured/createDate/lastModified`。**`length=3` 是请求参数，`recordsTotal=540` 才是上游总数字段** |

## 这些 fixture 不能证明什么

- 四类端点负例"同构"仍是调研记录的二手结论；本仓一手字节证据只有 `/project/ICG00115-Pro-1` 这一条。
- `species-list` 只能证明分页浏览；`search` 参数不可用（实测 `search[value]` 500、`search.value` 静默返回 0），所以工具不提供搜索。
- `geneList` 的条数是该研究的返回条数，不等于该研究的内参基因总数。
- 引物只证明"这两条记录里长这样"，不是通用推荐；`applicationScope` 是该研究的验证范围。

## 隐私

真实响应带 `contactName/contactEmail/hostInstitution`（species/project/publication/gene 的嵌套 project 都有），已在 fixture 删除；模拟反例使用 `@example.org` 虚构地址。`publication.abst` 不落 fixture、也不进输出。

**复查（2026-10-28）**：对本目录全部真实 fixture 递归扫描邮箱模式 → **0 命中**；`project-with-contact.json` 是标注 `simulated` 的反例，命中属预期。这只覆盖"邮箱模式"这一项检查，不等于隐私全面保证（无标签电话、微信号、自由文本人名不在检查范围）。

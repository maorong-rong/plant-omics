# IC4R fixtures（真实快照，含"空体只记元数据"的特例）

采集：2026-10-28（UTC 时刻见各文件 `capture.at`；本机 Windows 直连，未开代理），`curl.exe` 串行、间隔约 350 ms，未鉴权、未重试、未并发。
API base：`https://ngdc.cncb.ac.cn/ic4r/api/json`；官方文档 `https://ngdc.cncb.ac.cn/ic4r/api`（Version 2.0 / May 2018）。

所有 JSON 用 `{capture, payload}` 包装；**唯一例外是 `gene-empty.json`：真实响应为 0 字节，按审查要求不写 `payload`，只用 `capture.bodyBytes: 0` 与 `bodyKind: "empty"` 元数据表达**，避免让人误以为上游回了合法 JSON `{}`。`capture.simulated: true` 的是人为构造的反例。

| 文件 | 请求 | 观测 |
|---|---|---|
| [gene.json](gene.json) | `GET /gene/IC4R-OSJ01G000600` | 200 / 384 B；单对象，字段 `locus/synonym/description/source/rapdbAccession/msuAccession/type/strand/chromosome/symbol/geneLength/location/lastModified`。`lastModified` 是 **epoch 毫秒数字**，`geneLength` 是数字，`chromosome` 是字符串 `"1"` |
| [annotation.json](annotation.json) | `GET /annotation/IC4R-OSJ01G000600` | 200 / 2,565 B；**数组** 8 条、5 个类别（SUPPERFAMILY / Gene3D / InterPro×4 / Pfam / CDD）。原样保留，未裁剪；CDD 那条描述很长，工具侧按 120 字截断并标注 |
| [circrna.json](circrna.json) | `GET /circRNA/IC4R-OSJ01Circ057100` | 200 / 490 B；`length=182`、`sequence` 182 bp，原样保留——工具应**完整展示**这条序列（预算够） |
| [lncrna.json](lncrna.json) | `GET /lncRNA/IC4R-OSJ01Lnc000600.1` | 200 / 1,891 B；`length="1639"`（**字符串**）、`sequence` 1,639 bp。原样保留作结构证据；工具因 4 KB 预算**默认整条省略该序列**，这是预算结果，不是上游没有序列 |
| [id-conversion.json](id-conversion.json) | `GET /idConversion/IC4R-OSJ01G000600` | 200 / 99 B；`ic4r/msu/rapDb/symbol`。只证明 IC4R → MSU / RAP-DB 方向 |
| [gene-empty.json](gene-empty.json) | `GET /gene/IC4R-OSJ01G999999` | 200 / **0 B**，**无 content-type**。只记元数据，无 `payload` |
| [annotation-empty.json](annotation-empty.json) | `GET /annotation/IC4R-OSJ01G999999` | 200 / 2 B，正文 `[]`。合法空数组：**本次未返回注释**，不是"该基因没有注释" |
| [gene-list.json](gene-list.json) | `GET /genes/view?chromosome=1&draw=1&start=0&length=2` | 200 / 847 B；**裸对象信封** `{draw,recordsTotal=6534,recordsFiltered,data[],error}`；`data` 每项字段与 `/gene/{locus}` 相同。注意此端点在 `/ic4r/genes/view`，**不在 `apiBase` 下** |
| [gene-list-empty.json](gene-list-empty.json) | `GET /genes/view?chromosome=99&draw=3&start=0&length=2` | 200 / 70 B；**仍是裸对象** `{draw:3,recordsTotal:0,recordsFiltered:0,data:[],error:null}`。（此前一次转述误称"单元素数组包裹"，是我显示时自己加了方括号，已更正。实现对该形态做**防御性兼容**：仅解包单元素数组并记录 `raw.envelopeForm`；**多元素数组、`null`、元素非对象仍按结构漂移**。该形态非本仓实测，见下一行） |
| [gene-list-sy.json](gene-list-sy.json) | `GET /genes/view?chromosome=Sy&draw=4&start=0&length=2` | 200 / 819 B；`recordsTotal=140`，`data[0].locus=IC4R-OSJSyG000100`。证明染色体不止 1–12 |
| [gene-list-array-wrap.json](gene-list-array-wrap.json) | **模拟**（非真实响应） | 把裸对象包进单元素数组，用于验证"若出现该形态，工具显式解包并在 `raw.envelopeForm` 记录"。**本仓未实测到该形态**：chr99 的真实响应是 70 字节裸对象（首字节 `0x7B`）。这是按负责人要求做的防御性兼容，不是上游已观测行为 |

## 模拟反例（`simulated: true`，不是上游真实响应）

| 文件 | 构造 | 用途 |
|---|---|---|
| [gene-empty-object.json](gene-empty-object.json) | 在 gene 结构上把 `payload` 换成 `{}`，`bodyKind: "json"` | 断言"**合法 JSON 空对象** ≠ 查无"，必须抛结构漂移 |
| [annotation-object.json](annotation-object.json) | annotation 返回对象而非数组 | 断言 annotation 的非数组响应是结构漂移 |

## 这些 fixture 不能证明什么

- **空响应 ≠ 记录不存在**：0 字节样本只有一次；契约把空响应报成"无法确认是否存在"，不判记录不存在。
- `[]` 只表示本次没有返回注释条目，不是生物学结论。
- 文档是 2018 版，端点在线不代表数据同步；版本口径固定写"IC4R 2.0（文档声明，2018-05）"。
- 序列长度分布只采到一个 1,639 bp 样例；长序列省略规则另有 5,000 bp 构造用例兜底（测试内构造，不冒充真实数据）。

## 隐私

五个端点实测响应**未见个人字段**（gene / annotation / circRNA / lncRNA / idConversion）；工具仍按统一出口做"键名 + 邮箱"两道扫描，`raw` 是白名单投影。

**复查（2026-10-28）**：对本目录全部非 `simulated` 真实件递归扫描邮箱模式 → **0 命中**；测试里有对应自动断言。该检查只覆盖邮箱模式，不等于隐私全面保证。

# Ensembl Plants fixtures：真实抓取与裁剪

全部为 **2026-10-30 真实 HTTP 响应**（`simulated:false`），未编造、未改字段值。每份文件自带 `capture` 元数据。

## 包装结构（**文件字节数 ≠ 原体字节数**）

每份 JSON 是**包装格式**，不是原体本身：

```json
{
  "capture": { ...抓取元数据... },
  "payload":  ...上游原体（未改任何字段值）...
}
```

因此：

- **文件大小** = 原体 + `capture` 元数据 + 缩进换行，**必然大于原体**。例如 `sequence-genomic-pos.json` 文件 3,573 B，而**原体是 2,755 B**。
- **判断"是否真实"看 `payload`，不看文件大小**：把 `payload` 紧凑序列化（`JSON.stringify`，无缩进）后，其**字节数与 SHA256 必须等于 `capture.sourceBytes` / `capture.sourceSha256`**。
- 这条已写成自动断言（专测「包装校验」），7 份逐一比对，不符即红。

实测对照：

| 文件 | 文件字节（含包装） | **payload 原体字节** | payload SHA256（=原体） |
|---|---:|---:|---|
| `sequence-genomic-pos.json` | 3,573 | **2,755** | `3703CA59…` |
| `sequence-protein-multi-pos.json` | 1,509 | **591** | `629BD2CD…` |
| `xrefs-id-pos.json` | 3,505 | **2,030** | `DBFA1BAF…` |

## 抓取元数据（硬性条款）

`capture` 含：**完整请求 URL（含全部参数）/ HTTP 状态 / 内容类型 / 原体字节数 / 原体 SHA256 / 抓取客户端**。

### 抓取时刻：**未知**（mtime 另列为文件写入时间）

按负责人三档口径（确证 / 近似 / 未知），本批落**未知**档：

- **无可回溯的采集日志**：4 个抓取目录逐个查过，只有 `.json` 抓取件，没有任何 `.log` / `.txt` / curl 输出；
- 原记录只有本地时间且未记时区，`12:31Z` 里的 `Z`（UTC）与其后"本机"**互斥**，按 `Z` 解释还晚于实际 UTC，物理上不成立，**已全部删除**。

**因此 `captureTimeStatus = "未知"`，不填任何抓取时刻值**（`capturedAt` / `captureTimeRange` / `captureTimeBasis` 均不存在）。

**mtime 单独列，不混入抓取时刻**：

| 字段 | 含义 |
|---|---|
| `fileWriteTimeMtime` | 文件**写入磁盘**的时间（如 `2026-10-30T12:35:03+08:00`） |
| `fileWriteTimeNote` | 明写"**不代表抓取上游响应的时刻**；拷贝/检出/同步都会改写它" |

**为什么不能拿 mtime 填抓取时刻**：mtime 记的是"文件何时落盘"，不是"何时拿到响应"。拷贝、检出、同步都会改它——**换了环境这个值就变，但结论不该跟着变**，所以它不能当抓取证据。

**可核替代边界**：`firstCommittedAt`（`git log --diff-filter=A` 实测首次入库时间），仅作**入库留痕**，`firstCommittedNote` 明写"不替代抓取时刻"。

**影响边界**：不影响 payload 字节/结构/字段与解析回归（见下「包装校验」）；但**不足以证明"对应某一次具体上游请求"**。

以后新抓 fixture 的规矩：**时刻一律 ISO 8601 带偏移，由脚本自动写入，不手填。**

## 客户端与捕获方式

- **客户端**：`curl 8.x (schannel)`，经 PowerShell 调用 `curl.exe --connect-timeout 40`。
- **⚠️ 撤回“双客户端逐字节同值”**：经真字节比对，`sequence` 两次抓取**长度相同（2,755 B）但内容不同**（`seq` 完全不同，SHA256 `3703CA59…` vs `6CDAEBD6…`）。此前只凭字节数得出的“同值”结论**不成立**，详见[更正记录](../../../../记录/20261030-更正-Ensembl序列两次抓取内容不一致.md)。
  - 因此 `sequence-genomic-pos.json` 只代表**某一次抓取的真实响应**，**不代表该端点的稳定返回值**；不得写成"响应已互证"。
  - `xrefs` 两次抓取字节不同（键序不同）、**规范化后语义等值**，可以说"内容一致（键序不同）"，不能说"逐字节相同"。
- **为什么用 curl**：本机 Node `fetch`（undici）默认 connect 超时约 10 s，该站点常在此阶段超时；curl 连接超时更长。**这是本机链路特性，不是上游拒绝**，不得据此判定源不可用。

## 文件清单

| 文件 | 完整请求 | 状态 | 原体字节 | 用途 |
|---|---|---:|---:|---|
| `lookup-symbol-pos.json` | `GET /lookup/symbol/arabidopsis_thaliana/FT?content-type=application/json` | 200 | 441 | 符号正例；响应含 `species` |
| `lookup-id-pos.json` | `GET /lookup/id/AT1G65480?content-type=application/json;species=arabidopsis_thaliana` | 200 | 441 | ID 正例；两步核验的第 1 步 |
| `lookup-symbol-neg.json` | 同上符号端点，`NO_SUCH_GENE_ZZZ` | **400** | 61 | 查无形态（`No valid lookup found for symbol …`） |
| `lookup-id-neg.json` | 同上 ID 端点，`AT9G99999` | **400** | 36 | 查无形态（`ID '…' not found`） |
| `sequence-genomic-pos.json` | `GET /sequence/id/AT1G65480?type=genomic;content-type=application/json` | 200 | 2,755 | **顶层对象**；`seq.length`=2,627 bp |
| `sequence-protein-multi-pos.json` | `GET /sequence/id/AT1G65480?type=protein;multiple_sequences=1;content-type=application/json` | 200 | 591 | **顶层数组 2 条**；219 aa + 175 aa |
| `xrefs-id-pos.json` | `GET /xrefs/id/AT1G65480?content-type=application/json` | 200 | 2,030 | 9 条映射；**无 species、无组装名** |

## 关键结构事实（都写进了专测）

1. **两种顶层形态**：`genomic` 回**对象**，`protein&multiple_sequences=1` 回**数组**。解析必须先 `Array.isArray` 再分支。
2. **响应体字节 ≠ 序列长度**：`sequence-genomic` 是 2,755 B，而 `seq.length` 是 **2,627**。相差的 128 B 是 JSON 结构开销。**禁止拿响应字节当碱基数。**
3. **`species` 只在 lookup 里**：`sequence` 与 `xrefs` 响应**均无 `species` 字段**，`xrefs` 连组装名也没有 → 必须两步核验（先 lookup 核验基因 ID 的物种）。
4. **`desc` 在 protein 层为 `null`**，`version` 也可为 `null`；解析不许假设非空。想从 `desc` 推组装名，到转录本层就断了。
5. **一个基因回多条转录本**（`.2` 219 aa、`.1` 175 aa），逐条列出、**禁止拼接**。
6. **查无是 HTTP 400**，不是 404；且参数错也是 400，必须靠端点 + 请求身份 + 完整原体分流。

## 未入库的响应（明确排除）

- **503 的 HTML 已单独立件**：`fixtures/errors/http-503-service-unavailable.html`（107 B，`text/html`）。它**原名 `ens-sequence.json`**——文件名像 JSON 实为 HTML，正是"按扩展名判断类型"的坑。现已改扩展名、移入独立目录，**不按 JSON 解析，也不与有效响应混放**。详见该目录的 README。
- `cdna`（2,020 B）响应未入库：本批不开放 `cdna`/`cds`（超 1408 B 正文上限、转录本层 `desc=null`、无明确需求）。

## 维护约定

- 上游改字段时**重新抓取并覆盖**，不改手写值；`capture.sourceBytes` 与 `sourceSha256` 必须同步更新。
- fixture 不得含 token / cookie / 个人信息；本目录响应为公共基因注释，无个人数据。
- **不得只依赖 `%TEMP%`**：临时目录曾丢过证据，入库副本才是唯一可追溯来源。

# 错误页 fixture（非 JSON，禁止按 JSON 解析）

本目录只放**上游错误页原体**，专供 ENSP-04 错误路径测试。**不得与 `fixtures/*.json` 的有效响应混放**，也**不得按 JSON 解析**。

## http-503-service-unavailable.html

| 项 | 值 |
|---|---|
| 原体字节 | **107 B** |
| SHA256 | `839488EBC08446A096A893996ED23EAC321AC166724CD8C5D9092057834D2D79` |
| 内容类型 | `text/html`（**不是 JSON**） |
| HTTP 状态 | **503** |
| 抓取日期 | 2026-10-30 |
| 抓取客户端 | `curl 8.x (schannel)`，经 PowerShell `curl.exe --connect-timeout 40` |
| 完整请求 | `GET https://rest.ensembl.org/sequence/id/AT1G65480?type=genomic;content-type=application/json` |

原体全文：

```html
<html><body><h1>503 Service Unavailable</h1>
No server is available to handle this request.
</body></html>
```

## 用途与约束

1. **专供 ENSP-04**：证明"偶发 5xx 返回 HTML 错误页"这一真实形态，且**同一请求重试即 200**。
2. **不按 JSON 解析**：文件名带 `.html`，扩展名即类型声明；任何按 `.json` 加载的测试都不得引用它。
3. **不与有效响应混放**：它不在 `fixtures/*.json` 名单内，专测里对 `.json` 文件有一条断言，确保 `503 Service Unavailable` 不会出现在任何有效 fixture 中。
4. **单次 5xx 不判源不可用**：这条只是"本次请求失败"，重试后即恢复；不得据此把源标成故障。

## 为什么之前差点出错

这份文件先前被保存为 `ens-sequence.json`——**文件名像 JSON、实际是 HTML**。那正是"按扩展名判断类型"的坑：会让解析器把 HTML 当 JSON 喂进去。改名并移入本目录后，类型由扩展名与目录共同声明。

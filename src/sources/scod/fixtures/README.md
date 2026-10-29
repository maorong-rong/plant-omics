# SCOD：四份真实响应裁剪快照

2026-10-29，调研者交接此前保存的原响应；本轮未联网。先核对完整原体SHA256与交接一致，再按白名单裁剪。capture记录原请求、HTTP状态、日期、原体字节及SHA256；原体未提供精确抓取时刻，不拿文件mtime冒充查询时刻。目录/正例耗时260/610ms来自调研记录；空例/分页耗时未提供，明确为null，不编造。

| 文件 | 完整原始请求（GET） | 原体字节 | 保留 |
|---|---|---:|---|
| [genome-list.json](genome-list.json) | https://ngdc.cncb.ac.cn/scod/api/genome/list?term= | 13222 | 裸数组全部14条，genomeId/name/species |
| [gene-region-pos.json](gene-region-pos.json) | https://ngdc.cncb.ac.cn/scod/api/gene/gene_list?genomeId=1&chrom=Chr1A&posStart=100000&posEnd=200000 | 8176 | 全部4条本页及原始计数 |
| [gene-region-empty.json](gene-region-empty.json) | https://ngdc.cncb.ac.cn/scod/api/gene/gene_list?genomeId=1&chrom=Chr1A&posStart=1&posEnd=100 | 89 | 0计数和空数组 |
| [gene-region-page-length2.json](gene-region-page-length2.json) | https://ngdc.cncb.ac.cn/scod/api/gene/gene_list?genomeId=1&chrom=Chr1A&posStart=100000&posEnd=300000&start=0&length=2&draw=1 | 4053 | 原始总数11、本页2条 |

均为HTTP200、application/json（调研者交接）。目录只保留genomeId/name/species；基因只保留genomeId/geneId/chrom/posStart/posEnd，信封保留draw/recordsTotal/recordsFiltered/error/data。全部排除submitter/publication/rawLink/基因描述、注释、联系人和嵌套genome。坐标保留原始数字字符串，未改为数值；解析工具运行时再转换。没有改变本页数量或原始计数。

本批两个意图：基因组目录、按区间整体包含筛选。仅两个而非凑4–8个的原因：其他筛选、下载、表达、变异、基因查找端点尚未逐项实测；较窄范围仍须独立审查。

## 边界与限制

- 正例的4条基因均满足posStart≥100000且posEnd≤200000；调研者群消息里一处“posEnd≤100000”是笔误，不作为断言。
- 完全包含的决定性反例130574–133000→0只有调研记录，未交接独立原体。本目录不冒充存在第五份真实抓取。不得把另一URL的空结果改元数据后称该反例真实fixture。范围跨界等防御性校验用明确标记的simulated反例测。
- 目录/正例原捕获没有显式分页参数；离线工具调用额外带默认start/length/draw，测试仅证明既有payload解析与请求构造，不冒充该完整URL已新probe。只有分页原请求显式验证start=0、length=2、draw=1。
- 2MB大页与超大区间响应不入库；本地上限50由调研记录支撑，合成越界参数断言只证明本地拒绝，不伪造大响应。
- fixture回放的耗时与查询时刻由离线HTTP桩产生，不冒充原采集时刻；真实probe、实际包、MCP与DSH仍另验。

## 证据指针

- [T2定级](../../../../记录/20261029-调研-SCOD甘蔗源T2定级证据.md)
- [分页上限](../../../../记录/20261029-调研-SCOD区间上限与匹配规则实测.md)
- [区间语义终局](../../../../记录/20261029-调研-SCOD区间语义终局-完全包含.md)
- [原始响应交接](../../../../记录/20261029-调研-SCOD原始响应交接清单.md)

import type { SourceManifest } from '../../core/types.js';

/** T1 evidence: official docs page /ic4r/api (lists 5 GET endpoints) + five endpoints observed 2026-10-28 (200 / JSON). */
export const manifest: SourceManifest = {
  id: 'ic4r',
  displayName: 'IC4R 水稻信息共享平台（NGDC）',
  homepage: 'https://ngdc.cncb.ac.cn/ic4r/',
  apiBase: 'https://ngdc.cncb.ac.cn/ic4r/api/json',
  tier: 'T1',
  docs: 'https://ngdc.cncb.ac.cn/ic4r/api',
  auth: 'none',
  species: ['Oryza sativa'],
  network: 'direct',
  probe: { path: '/gene/IC4R-OSJ01G000600', expectStatus: 200, expect: 'json' },
  lastProbe: {
    date: '2026-10-28',
    ok: true,
    status: 200,
    note: 'gene/IC4R-OSJ01G000600 实测 384 B；五类端点本次采集均 200 JSON；仅证明所选探活端点',
  },
  versionNote:
    '接口与数据版本只能写“IC4R 2.0（文档声明，2018-05）”；lastModified 是 epoch 毫秒，按 UTC 转 ISO 并标注，不把接口版本当数据版本',
  caveats: [
    '仅覆盖水稻单一物种（响应 source=Oryza sativa Japonica Group）；不声明其他物种',
    'ID 获取：可按染色体分页列基因 locus（ic4r_gene_list，chromosome 取页面给出的 1–12 / Sy / Un，DataTables start/length）；不能按基因名、性状或基因组区间检索；length 的上游上限未测（本仓自限 50）；上游对枚举外的染色体取值（如 99）实测返回 HTTP 200 + recordsTotal=0，本地拒绝属于产品层白名单约束，不是上游限制',
    '按 ID 查询需要精确 locus/accession；circRNA/lncRNA 的列表端点未验证，不提供',
    '上游查无时返回 HTTP 200 + 0 字节正文，annotation 返回 []；本仓把空响应报成“无法确认是否存在”，不判记录不存在',
    'circRNA 与 lncRNA 是各自的 ID 空间（…Circ…／…Lnc…），与基因 locus 不通用；序列默认整条展示、超 4 KB 预算整条省略',
    'ID 映射只承诺已测方向：IC4R locus → MSU / RAP-DB；反向未测，不承诺',
  ],
};

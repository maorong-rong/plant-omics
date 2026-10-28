import type { SourceManifest } from '../../core/types.js';

/** T1 evidence: official docs page /icg/api + four `/icg/api/json/*` endpoints observed 2026-10-28 (200 / JSON). */
export const manifest: SourceManifest = {
  id: 'icg',
  displayName: 'ICG 内参基因数据库（NGDC）',
  homepage: 'https://ngdc.cncb.ac.cn/icg/',
  apiBase: 'https://ngdc.cncb.ac.cn/icg',
  tier: 'T1',
  docs: 'https://ngdc.cncb.ac.cn/icg/api',
  auth: 'none',
  species: ['Zea mays'],
  network: 'direct',
  probe: { path: '/api/json/species/ICG00115', expectStatus: 200, expect: 'json' },
  lastProbe: {
    date: '2026-10-28',
    ok: true,
    status: 200,
    note: 'species/ICG00115 实测 2,757 B（Zea mays）；四层端点本次采集均 200 JSON；仅证明所选探活端点',
  },
  versionNote: '版本只按响应字段（lastModified 等）透出；未声明即未知，不按 accession 外观推断',
  caveats: [
    '本仓未声明覆盖范围：species 只是已验证示例（物种 ICG00115 = Zea mays），不是覆盖承诺；物种目录有 540 条（上游 recordsTotal），示例非穷尽，不保证任意物种有记录',
    '四层 ID 必须显式选择：物种 ICG00001、研究 ICG00001-1、基因 ICG00001-1-EF1a、文献用 PubMed ID；层级由 entity 决定，不按横杠数量推断，也不自动换 entity 重试',
    '物种列表只能分页浏览，不能按名称搜索（search 参数实测不可用）',
    '引物是该研究验证过的组合，不是通用推荐；applicationScope 是该研究的验证范围',
    '联系方式字段（contactName/contactEmail/hostInstitution）不进输出、raw 与错误文本',
  ],
};

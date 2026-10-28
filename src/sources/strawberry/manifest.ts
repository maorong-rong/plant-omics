import type { SourceManifest } from '../../core/types.js';

/** T1 evidence: portal Data API + OpenAPI 3.1.1; low-frequency GET capture 2026-10-28. */
export const manifest: SourceManifest = {
  id: 'strawberry',
  displayName: 'Strawberry Data Hub 草莓及相关病原',
  homepage: 'https://bioinformatics.hainanu.edu.cn/strawberry/',
  apiBase: 'https://sci.hainanu.edu.cn/strawberry/api/v1',
  tier: 'T1',
  docs: 'https://sci.hainanu.edu.cn/strawberry/api/v1/openapi.json',
  auth: 'none',
  species: ['Fragaria vesca', 'Fragaria × ananassa', 'Botrytis cinerea'],
  network: 'direct',
  probe: { path: '/genes/status', expectStatus: 200, expect: 'json' },
  lastProbe: {
    date: '2026-10-28', ok: true, status: 200,
    note: 'genes/status JSON: enabled=true, available=true, examples为60项数组；仅证明基因状态端点，不代表全部模块',
  },
  versionNote: '版本只转述本次响应的assembly/version、dataset或release；缺失标未知，不按ID推断。目录generatedAt不是数据版本',
  caveats: [
    '源级覆盖草莓及相关病原（包括真菌、卵菌、细菌）；examples不是穷尽支持清单，各工具覆盖不同',
    '首版仅五个GET查询；目录登记不代表本仓已支持对应模块，无批量、POST或下载',
    'TF仅声明已证实的Fragaria模块；表达仅声明已证实的草莓数据集；共线不等于一对一正交或功能等价',
    'HTML 404是站点兜底，不能据此判断基因是否存在；429未通过打满配额实测',
  ],
};

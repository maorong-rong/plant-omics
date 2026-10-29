import type { SourceManifest } from '../../core/types.js';

/** T1 evidence: Swagger 2.0 at /v69/swagger (basePath /v69) + four endpoints observed 2026-10-28 (200). */
export const manifest: SourceManifest = {
  id: 'gramene',
  displayName: 'Gramene v69（禾本科比较基因组）',
  homepage: 'https://data.gramene.org/v69/',
  apiBase: 'https://data.gramene.org/v69',
  tier: 'T1',
  docs: 'https://data.gramene.org/v69/swagger',
  auth: 'none',
  species: ['Oryza sativa', 'Oryza sativa Indica Group'],
  network: 'direct',
  probe: { path: '/genes?idList=BGIOSGA001967', expectStatus: 200, expect: 'json' },
  lastProbe: {
    date: '2026-10-28',
    ok: true,
    status: 200,
    note: 'genes?idList=BGIOSGA001967 实测 8,520 B；search/genes/expression/taxonomy 四条路径本次采集均 200；仅证明所选探活端点',
  },
  versionNote: '数据版本只能写 v69（Swagger 的 basePath）；与 Ensembl 版本的对应关系未核验，不推断',
  caveats: [
    '本仓未声明覆盖范围：实测物种只有 Oryza sativa（taxid 4530）与 Oryza sativa Indica Group（39946001），未逐物种采样，不把覆盖范围外推到整个禾本科',
    '入口不同：/search 用自由文本 q；genes/expression/taxonomy 只接受 idList，把 q 传给它们只会得到空数组',
    'idList 是数组参数：数值型单值（如 idList=4530）会被上游校验器拒绝（400 Expected type array but found type integer）；本仓对单值数字重复一次发送，并在输出里注明这是规避写法',
    '查无是 HTTP 200 + 空数组（search 为 numFound=0），不是 404，也不能据此断言 ID 不存在',
    '/search 的 content-type 是 text/plain 而正文是 JSON，本仓按正文解析，不按 content-type 判断',
    '单条基因响应 8.5 KB（含 xrefs）；工具只输出裁剪后的关键字段，不返回 xrefs',
  ],
};

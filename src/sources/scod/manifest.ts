import type { SourceManifest } from '../../core/types.js';

export const manifest: SourceManifest = {
  id: 'scod',
  displayName: 'SCOD 甘蔗多组学数据库',
  homepage: 'https://ngdc.cncb.ac.cn/scod/',
  apiBase: 'https://ngdc.cncb.ac.cn/scod/api',
  tier: 'T2',
  docs: 'https://ngdc.cncb.ac.cn/scod/help',
  auth: 'none',
  species: ['Saccharum spontaneum'],
  network: 'direct',
  probe: { path: '/genome/list?term=', expectStatus: 200, expect: 'json' },
  lastProbe: { date: '2026-10-29', ok: true, status: 200, ms: 260,
    note: '调研者已保存的目录实测；本轮适配未重新联网。help为使用说明，不是API文档，故T2。' },
  versionNote: '组装与注释版本未知；genome_id为上游目录键，不推断为版本号；坐标基数命名未核验',
  caveats: [
    '仅适配甘蔗基因组目录与区间筛选，不承诺所有植物或全部14材料的每项查询均已实测；区间正例仅genomeId=1、Chr1A',
    '返回整条基因完全落在所给区间内的记录；跨边界基因不返回，不是任意重叠查询；不支持用单个位点查覆盖该点的基因',
    '分页length由本地严格限为1–50；50是产品安全上限，不是上游硬限制',
    '不接表达、变异、功能筛选、基因名搜索、序列下载；无API文档，裸数组与DataTables信封分别解析',
  ],
};

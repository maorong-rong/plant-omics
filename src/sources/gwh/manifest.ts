import type { SourceManifest } from '../../core/types.js';

/** T1 evidence: official docs page /gwh/api_documents + four endpoints observed 2026-10-28 (200 / JSON). */
export const manifest: SourceManifest = {
  id: 'gwh',
  displayName: 'GWH 基因组仓库（NGDC）',
  homepage: 'https://ngdc.cncb.ac.cn/gwh/',
  apiBase: 'https://ngdc.cncb.ac.cn/gwh/api/public',
  tier: 'T1',
  docs: 'https://ngdc.cncb.ac.cn/gwh/api_documents',
  auth: 'none',
  species: ['Taraxacum kok-saghyz'],
  network: 'direct',
  probe: { path: '/genome/1', expectStatus: 200, expect: 'json' },
  lastProbe: {
    date: '2026-10-28',
    ok: true,
    status: 200,
    note: 'genome/1 实测 422 B；genome/assembly/bioProject/bioSample 四类端点本次采集均 200 JSON；仅证明所选探活端点，不代表四类全部可用',
  },
  versionNote: '版本只按响应字段（releaseTime 等）透出；未声明即未知，不按 accession 外观推断',
  caveats: [
    '本仓未声明覆盖范围：species 只是已验证示例（genome/1 的 organism），不是覆盖承诺；browse/assembly 的 group 字段实测含 Animals/Plants/Fungi/Bacteria/Archaea/Viruses/Metagenomes/Protists，recordsTotal=3,471,431，示例非穷尽，不保证任意物种有记录',
    '只接受精确 ID：纯数字 genome_id、GWH 组装号、PRJCA 项目、SAMC 样本；GCA_/GCF_ 与 SAMN/SAMEA 不在范围（实测上游对它们只回全 null 或 Nonentity，无法与查无区分）',
    '按物种或关键词检索上游不可用（DataTables 的 search 参数实测不生效），本仓不提供搜索工具',
    '项目与样本是两条平行入口：上游不返回“项目下的样本列表”，也不返回“样本所属项目”',
    '查无是 HTTP 200 + 特定空结构，不是 404；文件下载只给路径，不承诺可下载（实测基因组包 389,670,521 B）',
  ],
};

/**
 * `/catalog` 的「研究服务」词表——**只有一份**（契约 v1.2 §三.1 规则 1）。
 *
 * 为什么必须有字典：同一个能力若各源自写标签，就会出现「基因查询 / 基因信息 / 基因注释」
 * 三种说法，用户以为是不一样的东西。字典在 `/catalog` 顶层下发一次，源只引用 key。
 *
 * 放 `src/core/` 是为了让 `SourceManifest` 能用它做类型约束而**不反向依赖 service 层**。
 */

/** 服务 key 的封闭词表。加 key 必须同时改契约 §三.1 与这里（测试会核对两侧一致）。 */
export const CATALOG_SERVICE_KEYS = [
  'gene',
  'expression',
  'variant',
  'interaction',
  'homology',
  'id-convert',
  'sequence',
  'taxonomy',
  'genome',
  'sample-meta',
] as const;

export type CatalogServiceKey = (typeof CATALOG_SERVICE_KEYS)[number];

export interface CatalogServiceEntry {
  readonly key: CatalogServiceKey;
  readonly label: string;
  readonly hint: string;
}

/** 字典正文：key → 给人看的标签与一句话说明。数组顺序即页面展示顺序。 */
export const SERVICES_CATALOG: readonly CatalogServiceEntry[] = [
  { key: 'gene', label: '基因查询', hint: '按基因 ID 或名称取注释' },
  { key: 'expression', label: '表达谱', hint: '组织或处理下的表达量' },
  { key: 'variant', label: '变异查询', hint: '区间内的变异位点' },
  { key: 'interaction', label: '互作网络', hint: '蛋白或基因之间的互作伙伴' },
  { key: 'homology', label: '同源与共线', hint: '跨物种同源基因或共线区块' },
  { key: 'id-convert', label: '编号换算', hint: '同一对象在不同数据库里的 ID 对照' },
  { key: 'sequence', label: '序列', hint: '按 ID 取核酸或蛋白序列' },
  { key: 'taxonomy', label: '物种分类', hint: '物种分类单元与谱系' },
  { key: 'genome', label: '基因组与装配', hint: '基因组、组装版本与下载入口' },
  { key: 'sample-meta', label: '项目与样本', hint: '项目（PRJCA）与样本（SAMC）元数据' },
];

export function isCatalogServiceKey(value: string): value is CatalogServiceKey {
  return (CATALOG_SERVICE_KEYS as readonly string[]).includes(value);
}

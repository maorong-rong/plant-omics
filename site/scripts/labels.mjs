/**
 * 落地页的**人写**文案：每个源的英文名与一句「能查什么」。
 *
 * 为什么单独放一个文件：源清单、工具数、盲区都必须来自注册表（机器真相），
 * 但 manifest 里的 displayName 是中文、没有英文名，也没有一句给普通人看的概括。
 * 这部分是写作，不能从代码生成，所以单独维护；`build-data.mjs` 会**双向对账**：
 * 注册表里多一个源、这里少一条，脚本直接失败——防止新增源之后页面上静默缺一块。
 *
 * 盲区（limits）不在这里翻译：那部分在页面上原样引用 manifest.caveats，
 * 保证「页面说的盲区」与「工具真的会说的事」是同一句话。
 */

/** @type {Record<string, {zh: {name: string, blurb: string}, en: {name: string, blurb: string}}>} */
export const SOURCE_LABELS = {
  wheatomics: {
    zh: {
      name: 'WheatOmics 小麦多组学平台',
      blurb: '小麦族的基因、表达谱、文献、注释 ID 换算、跨物种同源、变异目录与区间查询、基因/蛋白序列。',
    },
    en: {
      name: 'WheatOmics',
      blurb:
        'Genes, expression, papers, annotation-ID conversion, cross-species homologs, variant catalogues and region queries, and sequences for wheat and its relatives.',
    },
  },
  strawberry: {
    zh: {
      name: 'Strawberry Data Hub 草莓及相关病原',
      blurb: '草莓（含真菌、卵菌、细菌病原）的目录、精确基因注释、组织表达、共线块与转录因子成员。',
    },
    en: {
      name: 'Strawberry Data Hub',
      blurb:
        'Catalogue, exact gene annotation, tissue expression, synteny blocks and TF members for Fragaria and its pathogens.',
    },
  },
  gwh: {
    zh: {
      name: 'GWH 基因组仓库（NGDC）',
      blurb: '按精确 ID 取基因组 / 组装记录，以及项目与样本元数据；不提供按物种或关键词搜索。',
    },
    en: {
      name: 'GWH — Genome Warehouse (NGDC)',
      blurb: 'Genome and assembly records plus project and sample metadata, by exact ID only.',
    },
  },
  icg: {
    zh: {
      name: 'ICG 内参基因数据库（NGDC）',
      blurb: '物种目录，以及每项研究自己验证过的内参基因与引物组合（不是通用推荐）。',
    },
    en: {
      name: 'ICG — Internal Control Genes (NGDC)',
      blurb: 'Species catalogue plus the reference genes and primer pairs each study itself validated.',
    },
  },
  ic4r: {
    zh: {
      name: 'IC4R 水稻信息共享平台（NGDC）',
      blurb: '仅粳稻：基因、功能注释、circRNA、lncRNA 与 ID 映射，可按染色体分页浏览 locus。',
    },
    en: {
      name: 'IC4R — Rice Information Resource (NGDC)',
      blurb:
        'Japonica rice only: genes, functional annotation, circRNA, lncRNA, ID mapping, and locus browsing by chromosome.',
    },
  },
  gramene: {
    zh: {
      name: 'Gramene v69 禾本科比较基因组',
      blurb: '全文检索、基因、差异表达与分类单元查询；实测物种是水稻的两个分类单元。',
    },
    en: {
      name: 'Gramene v69',
      blurb: 'Full-text search, genes, differential expression and taxonomy; species verified so far are two rice taxa.',
    },
  },
  scod: {
    zh: {
      name: 'SCOD 甘蔗多组学数据库（NGDC）',
      blurb: '仅甘蔗：基因组目录，以及按区间查基因——整条基因完全落在区间内才返回。',
    },
    en: {
      name: 'SCOD — Sugarcane Multi-Omics (NGDC)',
      blurb: 'Sugarcane only: genome catalogue and region gene queries, returning only genes fully inside the region.',
    },
  },
  ensemblplants: {
    zh: {
      name: 'Ensembl Plants（EMBL-EBI）',
      blurb: '拟南芥、水稻、小麦、玉米四个物种：按符号或 ID 查基因、取基因组序列、查外部 ID 映射。',
    },
    en: {
      name: 'Ensembl Plants (EMBL-EBI)',
      blurb:
        'Gene lookup by symbol or ID, genomic sequence and external cross-references for four species: Arabidopsis, rice, wheat, maize.',
    },
  },
};

/**
 * 元工具的英文一句话。中文仍取注册表原文（机器真相），这里只补英文。
 */
export const META_LABELS = {
  hub_find_sources: {
    en: 'Ask which source can answer a plain-language question; returns candidate sources, callable tool names and blind spots. It says "not covered" instead of inventing an answer.',
  },
  hub_status: {
    en: 'Health sheet: current sources, each source’s scope, tool counts, budget headroom and known gaps. Local catalogue facts only — it does not promise any upstream is reachable now.',
  },
};

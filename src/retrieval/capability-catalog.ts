/**
 * 检索层能力目录（`hub_find_sources` 的唯一数据源）。
 *
 * 设计要点（见 `记录/20261029-hub_find_sources实现契约.md`）：
 *   - **语义放源级**（`SOURCE_SEMANTICS`），范围放工具级——防止逐工具乱标语义；
 *   - 意图用**封闭词表**，加意图必须同时改这里与契约记录；
 *   - 目录与注册表必须双向一致，由 `test/catalog-consistency.test.ts` 盯住。
 *
 * 这里只描述"哪个工具能干什么、覆盖什么"，**不描述上游是否可用**。
 */

/** 意图封闭词表。加一项 = 改这里 + 改契约记录 + 补双一致测试。 */
export type IntentId =
  | 'gene-search' | 'gene-detail' | 'expression' | 'variant' | 'homolog'
  | 'sequence' | 'annotation' | 'tf' | 'synteny' | 'literature'
  | 'taxonomy' | 'assembly' | 'sample' | 'id-convert' | 'reference-gene'
  | 'catalog' | 'circrna' | 'lncrna';

export interface IntentSpec {
  readonly id: IntentId;
  /** 中文标签，直接进输出 */
  readonly label: string;
  /** 归一化后的子串匹配词（中英都收） */
  readonly keywords: readonly string[];
}

export const INTENTS: readonly IntentSpec[] = [
  { id: 'gene-search', label: '基因搜索', keywords: ['基因搜索', '搜基因', '查找基因', '已知基因', '已克隆', '克隆基因', '基因列表', 'known gene', 'search gene', 'gene list'] },
  { id: 'gene-detail', label: '基因详情', keywords: ['基因详情', '基因记录', '基因信息', '这个基因', 'gene detail', 'gene info'] },
  { id: 'expression', label: '表达', keywords: ['表达', '表达量', '表达谱', 'fpkm', 'tpm', '组织表达', 'expression'] },
  { id: 'variant', label: '变异', keywords: ['变异', '变异位点', 'snp', '多态', '突变', 'variant', 'variation'] },
  { id: 'homolog', label: '同源', keywords: ['同源', '直系同源', '旁系同源', '对应基因', '跨物种', 'homolog', 'ortholog', 'paralog'] },
  { id: 'sequence', label: '序列', keywords: ['序列', '核酸', '蛋白序列', 'cds', '氨基酸', 'sequence', 'fasta'] },
  { id: 'annotation', label: '注释/结构域', keywords: ['注释', '结构域', '功能注释', 'pfam', 'domain', 'annotation'] },
  { id: 'tf', label: '转录因子', keywords: ['转录因子', '家族', '转录调控', 'transcription factor'] },
  { id: 'synteny', label: '共线', keywords: ['共线', '共线性', 'synteny', 'collinearity'] },
  { id: 'literature', label: '文献', keywords: ['文献', '论文', 'paper', 'publication', 'pubmed', 'doi'] },
  { id: 'taxonomy', label: '分类', keywords: ['分类', '分类单元', 'taxid', 'taxonomy'] },
  { id: 'assembly', label: '组装', keywords: ['组装', '基因组', 'contig', 'scaffold', 'assembly', 'genome'] },
  { id: 'sample', label: '样本/项目', keywords: ['样本', '项目', 'biosample', 'bioproject', 'sample', 'project'] },
  { id: 'id-convert', label: 'ID 转换', keywords: ['id转换', '转换id', '映射', '同义id', 'convert', 'id convert'] },
  { id: 'reference-gene', label: '内参基因', keywords: ['内参', '管家基因', '引物', 'primer', 'reference gene'] },
  { id: 'catalog', label: '目录/发现', keywords: ['目录', '有哪些', '数据集', '概览', '列表', 'browse', 'catalog', 'dataset'] },
  { id: 'circrna', label: 'circRNA', keywords: ['circrna', '环状rna'] },
  { id: 'lncrna', label: 'lncRNA', keywords: ['lncrna', '长链非编码'] },
];

export const INTENT_BY_ID = new Map(INTENTS.map((intent) => [intent.id, intent]));

/** 物种门策略：决定 `speciesScope.query` 怎么和问题里的物种比对 */
export type SpeciesPolicy = 'coverage' | 'example-only' | 'any-by-id';
/** 语义等级，用于排序（数字越小越优先） */
export type Semantics = '承诺' | '实测' | '示例非承诺';

export interface SourceSemantics {
  readonly semantics: Semantics;
  readonly policy: SpeciesPolicy;
  /** policy=example-only 时必填：已实测的物种 */
  readonly example?: readonly string[];
}

/**
 * 源级语义（单一真相）。
 * `semantics` 描述该源目录的**承诺强度**，不是"上游此刻可用"。
 */
export const SOURCE_SEMANTICS: Readonly<Record<string, SourceSemantics>> = {
  wheatomics: { semantics: '承诺', policy: 'coverage' },
  ic4r: { semantics: '承诺', policy: 'coverage' },
  strawberry: { semantics: '承诺', policy: 'coverage' },
  gramene: { semantics: '实测', policy: 'coverage' },
  icg: { semantics: '示例非承诺', policy: 'example-only', example: ['玉米'] },
  gwh: { semantics: '示例非承诺', policy: 'any-by-id', example: ['蒲公英'] },
  scod: { semantics: '实测', policy: 'coverage' },
  // 实测口径：四物种（拟南芥 TAIR10 / 水稻 IRGSP-1.0 / 小麦 IWGSC / 玉米 NAM-5.0）的
  // lookup/id 均 200（release 116）。只承诺这四物种，不按"267 物种目录"声称覆盖。
  ensemblplants: { semantics: '实测', policy: 'coverage' },
};

/**
 * 物种别名：规范名 → 归一化后的匹配词。
 *
 * 分两类，**判据不同，别混**：
 *   - 本服务**覆盖**的物种：见 `SPECIES_SATISFIES`，它们的 scope 会真的放行候选；
 *   - 已知但**不覆盖**的物种（`SPECIES_WITHOUT_COVERAGE`）：进这张表的唯一目的是
 *     **能识别、从而能精确拒答**（"大豆不在本服务目录"），而不是回落成全库候选。
 *     识别不出来时宁可说"未识别出物种"，也不许拿不相干的源凑数。
 *
 * 粳稻与籼稻各自成项，**都不并进「水稻」**：IC4R 只收粳稻，gramene 实测的是 Indica。
 * 合并成一个「水稻」的后果不是拒答，而是**看起来合规的错答**——比拒答危险得多。
 */
export const SPECIES_ALIASES: Readonly<Record<string, readonly string[]>> = {
  水稻: ['水稻', 'oryza sativa', 'oryza', 'rice'],
  粳稻: ['粳稻', 'japonica'],
  籼稻: ['籼稻', 'indica'],
  小麦: ['小麦', '普通小麦', 'triticum aestivum', 'triticum', '中国春', 'chinese spring', 'wheat'],
  玉米: ['玉米', '苞米', 'zea mays', 'zea', 'maize', 'corn'],
  拟南芥: ['拟南芥', 'arabidopsis thaliana', 'arabidopsis', 'thale cress'],
  草莓: ['草莓', 'fragaria', 'strawberry'],
  灰霉: ['灰霉', 'botrytis'],
  蒲公英: ['蒲公英', 'taraxacum', '橡胶草', 'kok-saghyz'],
  油菜: ['油菜', 'brassica napus', '甘蓝型油菜', 'rape'],
  甘蔗: ['甘蔗', 'saccharum', 'sugarcane'],
  大豆: ['大豆', '黄豆', 'glycine max', 'soybean', 'soy'],
  番茄: ['番茄', '西红柿', 'solanum lycopersicum', 'tomato'],
  人类: ['人类', '智人', 'homo sapiens', 'human'],
};

/**
 * 已知、但本服务**没有任何源按物种覆盖**的物种。
 *
 * 用途有二：① 拒答时能点名（"不覆盖大豆"），而不是笼统说"未识别"；
 * ② `test/hub-status-catalog.test.ts` 据此豁免"表里有、目录查不到"的一致性断言——
 * 这张表是**唯一真相**，测试不许另写一份名单。
 */
export const SPECIES_WITHOUT_COVERAGE: readonly string[] = ['油菜', '大豆', '番茄', '人类'];

/**
 * 源名别名：归一化后的匹配词 → sourceId。
 *
 * 为什么必须有：`WheatOmics`、`Strawberry` 里含物种别名（wheat / strawberry），
 * 不先把源名从文本里摘掉，`WheatOmics 查玉米的变异位点` 会被识别成"小麦+玉米"，
 * 于是拿小麦的变异工具去答玉米——用错物种作答比答不出来严重得多。
 */
export const SOURCE_NAME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  wheatomics: ['wheatomics', 'wheat omics', '小麦组学'],
  strawberry: ['strawberry', '草莓数据库'],
  gwh: ['gwh'],
  icg: ['icg'],
  ic4r: ['ic4r'],
  gramene: ['gramene'],
  scod: ['scod'],
  ensemblplants: ['ensemblplants', 'ensembl plants'],
};

/**
 * 一个物种能满足哪些 `speciesScope` 写法。
 * 目录里的 scope 是"覆盖口径"，不是物种名，必须显式映射，否则会静默漏召回。
 */
const SPECIES_SATISFIES: Readonly<Record<string, readonly string[]>> = {
  水稻: ['水稻'],
  // 粳稻满足"水稻"（IC4R 就是粳稻单物种、gramene 的 Oryza sativa 也含粳稻），
  // 籼稻**不满足**"水稻"——它是另一个亚种，合并进水稻会产生"看起来合规的错答"。
  粳稻: ['水稻'],
  籼稻: ['籼稻'],
  // 小麦同时承接两种口径：「小麦族」= 小麦族整族（WheatOmics 的覆盖口径），
  // 「小麦」= 仅普通小麦 Triticum aestivum 单物种（Ensembl Plants 实测口径）。
  // 两者不能合并：把单物种源写成"小麦族"是夸大覆盖，把整族源写成"小麦"会漏召回。
  小麦: ['小麦族', '小麦'],
  玉米: ['玉米'],
  拟南芥: ['拟南芥'],
  草莓: ['草莓', '草莓及相关病原', '草莓属（Fragaria）', '草莓属'],
  灰霉: ['草莓及相关病原'],
  蒲公英: ['蒲公英'],
  油菜: ['油菜'],
  甘蔗: ['甘蔗'],
  // 已知但不覆盖：声明为空数组，表示"任何 scope 都不接"。
  // 不能省成 undefined——省了会被读成"没登记"，与"登记为不覆盖"混为一谈。
  大豆: [],
  番茄: [],
  人类: [],
};

export interface ToolCapability {
  readonly tool: string;
  readonly sourceId: string;
  readonly intents: readonly IntentId[];
  readonly speciesScope: {
    readonly query?: readonly string[];
    readonly target?: readonly string[];
  };
  /**
   * 意图级"明确不做"。
   *
   * 必须是**结构化**的：`blocks` 明确列出被挡住的意图，而不是靠规则文本里出现
   * "检索/区间"这类词去猜——猜法会漏（换种说法就失效）也会误伤（无关意图被牵连）。
   *
   * `when` 再限定"只有问题确实在问这种模式时才挡"：否则「按基因 ID 取序列」
   * 会被「按区间取序列」的禁令误杀（审查 RETR-04 反例）。
   */
  readonly hardExcludes?: ReadonlyArray<{
    readonly rule: string;
    readonly blocks: readonly IntentId[];
    readonly when?: RegExp;
  }>;
  readonly blindSpots: readonly string[];
}

const WHEAT_BLIND = ['只覆盖小麦族（Triticum/Aegilops），不代表网站全部模块已接入'];
const GRAMENE_BLIND = ['实测物种只有 Oryza sativa / Indica Group，不声称覆盖禾本科'];
const ENSEMBL_BLIND = [
  '只覆盖已实测四物种（拟南芥/水稻/小麦/玉米）；该 REST 跨分区、也服务非植物对象，按物种白名单与响应侧 species 双重拦截',
  '基因 ID 分代次：玉米 B73 v4 旧编号（Zm00001d…）当前查无，且与"基因不存在"同形',
  '查无是 HTTP 400 而非 404，与参数错误同码；未知形态一律报错，不归空',
];
const IC4R_BLIND = ['仅粳稻单物种；文档为 2018 版；不支持按基因名或区间检索'];
const ICG_BLIND = ['实为物种目录（约 540 物种），仅实测玉米；不提供按名称搜索'];
const GWH_BLIND = ['按精确 ID 查，不提供物种或关键词检索；不保证该 ID 有记录'];
const STRAW_BLIND = ['表达仅已证实的草莓数据集；TF 仅 Fragaria；共线仅已证实装配'];

/** 30 个源工具的能力登记。每个工具至少 1 个意图。 */
export const TOOL_CAPABILITIES: readonly ToolCapability[] = [
  // ---- wheatomics（小麦族）----
  { tool: 'wheatomics_search_known_genes', sourceId: 'wheatomics', intents: ['gene-search'], speciesScope: { query: ['小麦族'] }, blindSpots: WHEAT_BLIND },
  { tool: 'wheatomics_gene_detail', sourceId: 'wheatomics', intents: ['gene-detail'], speciesScope: { query: ['小麦族'] }, blindSpots: WHEAT_BLIND },
  { tool: 'wheatomics_expression_projects', sourceId: 'wheatomics', intents: ['expression', 'catalog'], speciesScope: { query: ['小麦族'] }, blindSpots: WHEAT_BLIND },
  { tool: 'wheatomics_expression_query', sourceId: 'wheatomics', intents: ['expression'], speciesScope: { query: ['小麦族'] }, blindSpots: [...WHEAT_BLIND, '表达值单位随项目而定，跨项目不可直接比大小'] },
  { tool: 'wheatomics_search_papers', sourceId: 'wheatomics', intents: ['literature'], speciesScope: { query: ['小麦族'] }, blindSpots: ['只收小麦族文献，不是 PubMed 全量'] },
  { tool: 'wheatomics_convert_gene_ids', sourceId: 'wheatomics', intents: ['id-convert'], speciesScope: { query: ['小麦族'] }, blindSpots: WHEAT_BLIND },
  {
    tool: 'wheatomics_cross_species_homologs',
    sourceId: 'wheatomics',
    intents: ['homolog'],
    speciesScope: { query: ['小麦族'], target: ['水稻', '拟南芥'] },
    blindSpots: ['目标域只有水稻与拟南芥，不含玉米', '不区分直系/旁系同源（上游无该字段）'],
  },
  { tool: 'wheatomics_variant_datasets', sourceId: 'wheatomics', intents: ['variant', 'catalog'], speciesScope: { query: ['小麦族'] }, blindSpots: ['genome_concordant 未知的数据集，0 条结果不可解读为"无变异"'] },
  {
    tool: 'wheatomics_variant_query',
    sourceId: 'wheatomics',
    intents: ['variant'],
    speciesScope: { query: ['小麦族'] },
    blindSpots: ['total=0 不等于该区间没有变异', '等端点区间（start==end）本地拒绝', '不支持按变异 ID 查'],
  },
  { tool: 'wheatomics_gene_annotation', sourceId: 'wheatomics', intents: ['annotation'], speciesScope: { query: ['小麦族'] }, blindSpots: [...WHEAT_BLIND, '坐标字段是 Mb 浮点，不是 bp'] },
  {
    tool: 'wheatomics_sequence',
    sourceId: 'wheatomics',
    intents: ['sequence'],
    speciesScope: { query: ['小麦族'] },
    hardExcludes: [{ rule: '按基因组区间取序列', blocks: ['sequence'], when: /区间|interval|坐标|chr\w*\s*[:：]\s*\d+\s*[-–~]\s*\d+/i }],
    blindSpots: ['只支持按基因 ID 取序列', '上游可能重复返回同名序列，已去重并注明'],
  },

  // ---- strawberry（草莓及相关病原）----
  { tool: 'strawberry_catalog', sourceId: 'strawberry', intents: ['catalog'], speciesScope: { query: ['草莓及相关病原'] }, blindSpots: STRAW_BLIND },
  { tool: 'strawberry_gene_lookup', sourceId: 'strawberry', intents: ['gene-detail'], speciesScope: { query: ['草莓及相关病原'] }, hardExcludes: [{ rule: '模糊搜索', blocks: ['gene-search', 'catalog'], when: /模糊/ }], blindSpots: ['按精确 geneId 查，不做模糊搜索'] },
  { tool: 'strawberry_expression', sourceId: 'strawberry', intents: ['expression'], speciesScope: { query: ['草莓'] }, blindSpots: STRAW_BLIND },
  { tool: 'strawberry_synteny', sourceId: 'strawberry', intents: ['synteny'], speciesScope: { query: ['草莓'] }, blindSpots: ['共线不等于同源；仅已证实装配'] },
  { tool: 'strawberry_tf_members', sourceId: 'strawberry', intents: ['tf'], speciesScope: { query: ['草莓属（Fragaria）'] }, blindSpots: ['TF 成员仅覆盖 Fragaria'] },

  // ---- gwh（按精确 ID）----
  { tool: 'gwh_assembly_lookup', sourceId: 'gwh', intents: ['assembly'], speciesScope: { query: ['不限物种（按精确 ID）'] }, hardExcludes: [
      { rule: '按物种/关键词检索', blocks: ['gene-search', 'catalog'], when: /按物种|按关键词|关键词|搜索|检索|按名称/ },
      { rule: '按基因区间检索', blocks: ['variant', 'annotation'], when: /区间|interval|坐标|chr\w*\s*[:：]\s*\d+\s*[-–~]\s*\d+/i },
    ], blindSpots: GWH_BLIND },
  { tool: 'gwh_project_sample_lookup', sourceId: 'gwh', intents: ['sample'], speciesScope: { query: ['不限物种（按精确 ID）'] }, hardExcludes: [
      { rule: '按物种/关键词检索', blocks: ['gene-search', 'catalog'], when: /按物种|按关键词|关键词|搜索|检索|按名称/ },
      { rule: '按基因区间检索', blocks: ['variant', 'annotation'], when: /区间|interval|坐标|chr\w*\s*[:：]\s*\d+\s*[-–~]\s*\d+/i },
    ], blindSpots: GWH_BLIND },

  // ---- icg（示例非承诺：仅实测玉米）----
  { tool: 'icg_lookup', sourceId: 'icg', intents: ['reference-gene'], speciesScope: { query: ['玉米'] }, hardExcludes: [{ rule: '按基因名/性状检索', blocks: ['gene-search', 'gene-detail', 'catalog'], when: /按基因名|按基因名称|按名称|按性状|模糊/ }], blindSpots: [...ICG_BLIND, '不作通用推荐'] },
  { tool: 'icg_species_list', sourceId: 'icg', intents: ['catalog'], speciesScope: { query: ['玉米'] }, hardExcludes: [{ rule: '按基因名/性状检索', blocks: ['gene-search', 'gene-detail', 'catalog'], when: /按基因名|按基因名称|按名称|按性状|模糊/ }], blindSpots: ICG_BLIND },

  // ---- ic4r（粳稻）----
  { tool: 'ic4r_gene', sourceId: 'ic4r', intents: ['gene-detail'], speciesScope: { query: ['水稻'] }, hardExcludes: [
      { rule: '按基因名检索', blocks: ['gene-search'], when: /按基因名|按基因名称|按名称|按性状|模糊/ },
      { rule: '按基因组区间检索', blocks: ['variant', 'annotation', 'sequence'], when: /区间|interval|坐标|chr\w*\s*[:：]\s*\d+\s*[-–~]\s*\d+/i },
    ], blindSpots: IC4R_BLIND },
  { tool: 'ic4r_annotation', sourceId: 'ic4r', intents: ['annotation'], speciesScope: { query: ['水稻'] }, hardExcludes: [
      { rule: '按基因名检索', blocks: ['gene-search'], when: /按基因名|按基因名称|按名称|按性状|模糊/ },
      { rule: '按基因组区间检索', blocks: ['variant', 'annotation', 'sequence'], when: /区间|interval|坐标|chr\w*\s*[:：]\s*\d+\s*[-–~]\s*\d+/i },
    ], blindSpots: IC4R_BLIND },
  { tool: 'ic4r_circrna', sourceId: 'ic4r', intents: ['circrna'], speciesScope: { query: ['水稻'] }, hardExcludes: [
      { rule: '按基因名检索', blocks: ['gene-search'], when: /按基因名|按基因名称|按名称|按性状|模糊/ },
      { rule: '按基因组区间检索', blocks: ['variant', 'annotation', 'sequence'], when: /区间|interval|坐标|chr\w*\s*[:：]\s*\d+\s*[-–~]\s*\d+/i },
    ], blindSpots: IC4R_BLIND },
  { tool: 'ic4r_lncrna', sourceId: 'ic4r', intents: ['lncrna'], speciesScope: { query: ['水稻'] }, hardExcludes: [
      { rule: '按基因名检索', blocks: ['gene-search'], when: /按基因名|按基因名称|按名称|按性状|模糊/ },
      { rule: '按基因组区间检索', blocks: ['variant', 'annotation', 'sequence'], when: /区间|interval|坐标|chr\w*\s*[:：]\s*\d+\s*[-–~]\s*\d+/i },
    ], blindSpots: IC4R_BLIND },
  { tool: 'ic4r_id_convert', sourceId: 'ic4r', intents: ['id-convert'], speciesScope: { query: ['水稻'] }, hardExcludes: [
      { rule: '按基因名检索', blocks: ['gene-search'], when: /按基因名|按基因名称|按名称|按性状|模糊/ },
      { rule: '按基因组区间检索', blocks: ['variant', 'annotation', 'sequence'], when: /区间|interval|坐标|chr\w*\s*[:：]\s*\d+\s*[-–~]\s*\d+/i },
    ], blindSpots: [...IC4R_BLIND, 'ID 映射只承诺已测方向（IC4R locus → MSU/RAP-DB）'] },
  { tool: 'ic4r_gene_list', sourceId: 'ic4r', intents: ['gene-search', 'catalog'], speciesScope: { query: ['水稻'] }, hardExcludes: [
      { rule: '按基因名检索', blocks: ['gene-search'], when: /按基因名|按基因名称|按名称|按性状|模糊/ },
      { rule: '按基因组区间检索', blocks: ['variant', 'annotation', 'sequence'], when: /区间|interval|坐标|chr\w*\s*[:：]\s*\d+\s*[-–~]\s*\d+/i },
    ], blindSpots: [...IC4R_BLIND, '按染色体分页列 locus，不是按名称搜索'] },

  // ---- scod（甘蔗，T2 实测两端点）----
  { tool: 'scod_genome_list', sourceId: 'scod', intents: ['catalog'], speciesScope: { query: ['甘蔗'] }, blindSpots: ['只覆盖甘蔗（Saccharum spontaneum）及相关材料，不是主粮'] },
  {
    tool: 'scod_gene_region',
    sourceId: 'scod',
    intents: ['gene-search'],
    speciesScope: { query: ['甘蔗'] },
    blindSpots: ['区间要覆盖整个基因才返回；0 条不等于该位置没有基因', '本地限制 length ≤ 50'],
  },

  // ---- gramene（实测水稻）----
  { tool: 'gramene_search', sourceId: 'gramene', intents: ['gene-search'], speciesScope: { query: ['水稻', '籼稻'] }, hardExcludes: [{ rule: '按字段精确过滤', blocks: ['variant'], when: /按字段|精确过滤|字段过滤/ }], blindSpots: GRAMENE_BLIND },
  { tool: 'gramene_gene', sourceId: 'gramene', intents: ['gene-detail'], speciesScope: { query: ['水稻', '籼稻'] }, hardExcludes: [{ rule: '按字段精确过滤', blocks: ['variant'], when: /按字段|精确过滤|字段过滤/ }], blindSpots: GRAMENE_BLIND },
  { tool: 'gramene_expression', sourceId: 'gramene', intents: ['expression'], speciesScope: { query: ['水稻', '籼稻'] }, hardExcludes: [{ rule: '按字段精确过滤', blocks: ['variant'], when: /按字段|精确过滤|字段过滤/ }], blindSpots: GRAMENE_BLIND },
  { tool: 'gramene_taxonomy', sourceId: 'gramene', intents: ['taxonomy'], speciesScope: { query: ['水稻', '籼稻'] }, hardExcludes: [{ rule: '按字段精确过滤', blocks: ['variant'], when: /按字段|精确过滤|字段过滤/ }], blindSpots: GRAMENE_BLIND },

  // ---- ensemblplants（实测四物种：拟南芥/水稻/小麦/玉米）----
  {
    tool: 'ensemblplants_lookup_gene',
    sourceId: 'ensemblplants',
    intents: ['gene-detail'],
    speciesScope: { query: ['拟南芥', '水稻', '小麦', '玉米'] },
    blindSpots: [...ENSEMBL_BLIND, '按符号或基因 ID 精确查单个基因，不做模糊/批量搜索，也不返回序列或外链 ID'],
  },
  {
    tool: 'ensemblplants_sequence',
    sourceId: 'ensemblplants',
    intents: ['sequence'],
    speciesScope: { query: ['拟南芥', '水稻', '小麦', '玉米'] },
    hardExcludes: [{ rule: '按基因组区间取序列', blocks: ['sequence'], when: /区间|interval|坐标|chr\w*\s*[:：]\s*\d+\s*[-–~]\s*\d+/i }],
    blindSpots: [
      ...ENSEMBL_BLIND,
      '只接 genomic（bp）与 protein（aa）；cdna/cds 未开放，不拼接多条转录本',
      '序列接口无 species 字段，转录本物种靠前置 lookup 核验，属已知残余风险',
    ],
  },
  {
    tool: 'ensemblplants_xrefs',
    sourceId: 'ensemblplants',
    intents: ['id-convert'],
    speciesScope: { query: ['拟南芥', '水稻', '小麦', '玉米'] },
    blindSpots: [...ENSEMBL_BLIND, '映射接口既无物种也无组装字段，靠前置 lookup 核验；不按数据库过滤，不保证某库一定有条目'],
  },
];

/** 该物种能否满足某个 scope 写法（如 小麦 满足 小麦族）。 */
export function speciesSatisfies(species: string, scope: string): boolean {
  if (scope === '不限物种（按精确 ID）') return true;
  return (SPECIES_SATISFIES[species] ?? []).includes(scope);
}

/** 在归一化文本里找出所有物种，按出现位置升序。`end` 用于判断它后面的方向标记。 */
export function detectSpecies(normalized: string): Array<{ species: string; index: number; end: number }> {
  const found: Array<{ species: string; index: number; end: number }> = [];
  for (const [species, aliases] of Object.entries(SPECIES_ALIASES)) {
    let best: { index: number; end: number } | undefined;
    for (const alias of aliases) {
      const at = normalized.indexOf(alias);
      if (at >= 0 && (!best || at < best.index)) best = { index: at, end: at + alias.length };
    }
    if (best) found.push({ species, ...best });
  }
  return found.sort((a, b) => a.index - b.index);
}

/** 在归一化文本里命中哪些意图。 */
export function detectIntents(normalized: string): IntentId[] {
  const hit: IntentId[] = [];
  for (const spec of INTENTS) {
    if (spec.keywords.some((word) => normalized.includes(word))) hit.push(spec.id);
  }
  return hit;
}

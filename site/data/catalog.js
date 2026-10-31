/* 由 site/scripts/build-data.mjs 生成，勿手改。源：dist/ 注册表。 */
window.__PLANTOMICS_CATALOG__ = {
  "schemaVersion": 1,
  "generatedAt": "2026-10-31T08:36:09.434Z",
  "gitCommit": "a7de1ff",
  "package": {
    "name": "plantomics-hub",
    "version": "0.1.0"
  },
  "build": {
    "sourceRev": "f19d4e7-dirty",
    "builtAt": "2026-10-31T16:23:39+08:00",
    "packageVersion": "0.1.0"
  },
  "budget": {
    "sources": 8,
    "maxSources": 20,
    "tools": 37,
    "maxTools": 40
  },
  "tiers": {
    "T1": 7,
    "T2": 1,
    "T3": 0
  },
  "published": {
    "spec": "plantomics-hub@0.1.0",
    "sources": 7,
    "tools": 34,
    "metaTools": 2,
    "sourceIds": [
      "wheatomics",
      "strawberry",
      "gwh",
      "icg",
      "ic4r",
      "gramene",
      "scod"
    ],
    "missingSources": [
      {
        "id": "ensemblplants",
        "name": "Ensembl Plants（EMBL-EBI）",
        "nameEn": "Ensembl Plants (EMBL-EBI)"
      }
    ],
    "snapshotAt": "2026-10-31T02:52:09.482Z"
  },
  "sources": [
    {
      "id": "strawberry",
      "displayName": "Strawberry Data Hub 草莓及相关病原",
      "label": {
        "zh": {
          "name": "Strawberry Data Hub 草莓及相关病原",
          "blurb": "草莓（含真菌、卵菌、细菌病原）的目录、精确基因注释、组织表达、共线块与转录因子成员。"
        },
        "en": {
          "name": "Strawberry Data Hub",
          "blurb": "Catalogue, exact gene annotation, tissue expression, synteny blocks and TF members for Fragaria and its pathogens."
        }
      },
      "tier": "T1",
      "homepage": "https://bioinformatics.hainanu.edu.cn/strawberry/",
      "species": [
        "Fragaria vesca",
        "Fragaria × ananassa",
        "Botrytis cinerea"
      ],
      "caveats": [
        "源级覆盖草莓及相关病原（包括真菌、卵菌、细菌）；examples不是穷尽支持清单，各工具覆盖不同",
        "首版仅五个GET查询；目录登记不代表本仓已支持对应模块，无批量、POST或下载",
        "TF仅声明已证实的Fragaria模块；表达仅声明已证实的草莓数据集；共线不等于一对一正交或功能等价",
        "HTML 404是站点兜底，不能据此判断基因是否存在；429未通过打满配额实测"
      ],
      "versionNote": "版本只转述本次响应的assembly/version、dataset或release；缺失标未知，不按ID推断。目录generatedAt不是数据版本",
      "toolCount": 5,
      "tools": [
        {
          "name": "strawberry_catalog",
          "summary": "发现Strawberry Data Hub草莓及相关病原的模块、装配和限流目录。module仅本地子串过滤（最多128码点）；目录存在不代表本仓已实现对应数据查询，模块物种覆盖不推断；generatedAt是目录生成时间而非数据版本。"
        },
        {
          "name": "strawberry_gene_lookup",
          "summary": "精确查询草莓及相关病原的基因注释、响应自身物种与装配版本及蛋白长度，不做模糊搜索。species/version请用catalog或状态目录的原字符串；ID最多256码点，species/version各512。includeSequence默认false；只展示最多120 aa的非完整蛋白前缀，不能用于完整序列分析或下载。"
        },
        {
          "name": "strawberry_expression",
          "summary": "查询已证实的草莓表达数据集中的单基因组织表达，按上游组织mean降序展示top（1–30，默认8）。geneId/dataset最多256码点。不推广到相关病原；保留响应dataset、profileType和原单位batch-corrected TPM，不跨数据集比较。组织均值为上游字段，不自行重算样本。"
        },
        {
          "name": "strawberry_synteny",
          "summary": "查询已证实草莓装配间的基因共线区块；geneId/sourceAssembly/targetAssembly必填，各最多256码点，装配ID来自状态目录而不是物种名。maxBlocks为本地展示上限1–10默认5。保留分析ID、源/目标装配、总块数和上游截断标记；不宣称病原全覆盖，共线不等于一对一正交或功能等价。"
        },
        {
          "name": "strawberry_tf_members",
          "summary": "查已证实的Fragaria转录因子成员，不推广至相关病原。family/species/assembly/type至少一个非空筛选；单值筛选，family/assembly/type最多256码点，species512。page为1–100000默认1，pageSize为1–100默认20；本地最多20条且按字节再裁行，分别报告上游total/本页返回/实际展示。拒绝summary模式；release仅取本次响应，缺失则未知。"
        }
      ],
      "pinned": true,
      "order": 0
    },
    {
      "id": "wheatomics",
      "displayName": "WheatOmics 小麦多组学平台",
      "label": {
        "zh": {
          "name": "WheatOmics 小麦多组学平台",
          "blurb": "小麦族的基因、表达谱、文献、注释 ID 换算、跨物种同源、变异目录与区间查询、基因/蛋白序列。"
        },
        "en": {
          "name": "WheatOmics",
          "blurb": "Genes, expression, papers, annotation-ID conversion, cross-species homologs, variant catalogues and region queries, and sequences for wheat and its relatives."
        }
      },
      "tier": "T1",
      "homepage": "https://wheatomics.sdau.edu.cn/",
      "species": [
        "Triticum aestivum",
        "Triticum turgidum",
        "Aegilops tauschii"
      ],
      "caveats": [
        "平台自带 MCP server（GET /api/mcp/sse）—— 本插件不是它的替代品，价值在于把小麦和别的国内库并成同一套工具",
        "上游各端点对 01G/02G/03G 的\"v1/v2/v3\"叫法不一致；本仓按前缀识别，不替你判定注释版本",
        "表达值单位随项目而定且上游未逐点标注，跨项目不可直接比较大小",
        "已接入的信封类端点使用 {success, message, timestamp, data}；success=false 时 data 不可用，不外推其他端点",
        "Pfam 注释仅默认 Genefunc_CS_IWGSC03G_table，坐标为 Mb；本地展示裁剪，不提供上游分页或区间注释",
        "序列仅按gene_id查gene/protein，本地对去重后的单条序列分块，不接区间；offset不是基因组坐标，分块会重新请求上游，不是上游分页",
        "基因详情里的 molecular_weight 单位未在文档中标注（245 aa 的蛋白返回 27838.39，量级像 Da）；引用前请回上游确认"
      ],
      "versionNote": "上游 genome 字段返回 Chinese_Spring1.0；02G/01G/03G 前缀映射由上游端点自行解释，本仓未独立核验其对应的组装/注释版本号，引用前请回上游确认",
      "toolCount": 11,
      "tools": [
        {
          "name": "wheatomics_search_known_genes",
          "summary": "在小麦「已克隆功能基因」库里模糊搜索（基因 ID、基因名、性状、物种、DOI 均可命中）。当用户问「小麦里调控某某性状的有哪些已知基因」「TaVRN1 是什么基因」时先调这个；返回的是人工整理过的克隆基因条目，不同于全基因组注释。"
        },
        {
          "name": "wheatomics_gene_detail",
          "summary": "按基因 ID 取小麦基因的标准化详情（描述、染色体位置、蛋白长度、分子量、等电点、功能注释、JBrowse 链接）。接受 01G / 02G / 03G 三种前缀的 ID（上游各端点对这三个版本叫法不完全一致，本工具按前缀识别）。当用户给出一个具体小麦基因 ID 并想知道「它是什么、在哪、蛋白多长」时用这个。"
        },
        {
          "name": "wheatomics_expression_projects",
          "summary": "列出 WheatOmics 已整合的小麦表达谱项目（芯片/RNA-seq，含组织、发育期、胁迫、激素处理等）。当用户想找「有没有干旱胁迫下的表达数据」「有哪些籽粒发育的表达谱」时用；先用它拿到 project 标识，再调 wheatomics_expression_query。结果按 group 汇总，可用 keyword 过滤具体项目。"
        },
        {
          "name": "wheatomics_expression_query",
          "summary": "查一个或多个小麦基因在指定表达谱项目里的表达量：**均值 ± 标准差**，按表达量降序给最高的若干个条件。当用户问「这个基因在哪些组织/处理下高表达」时用。已给出具体条件名（如 grain）时传 condition 只看那类条件；project 不填则用上游默认项目，建议先用 wheatomics_expression_projects 选项目。注意：表达值单位随项目而定，上游未逐点标注，**跨项目不可直接比较大小**。"
        },
        {
          "name": "wheatomics_search_papers",
          "summary": "检索 WheatOmics 收录的小麦族（Triticeae）文献元数据，可按关键词、性状、基因、时间窗过滤。当用户想找「小麦耐旱相关近年文献」或为某个基因找参考文献时用。返回的是该平台的精选文献库，不是 PubMed 全量。"
        },
        {
          "name": "wheatomics_convert_gene_ids",
          "summary": "把小麦基因 ID 在不同注释版本间换算，统一转成上游所称的 02G（IWGSC v1.1）格式。支持 MIPS v2.2、TGACv1、IWGSC v1.0 三种源版本。当用户手里的 ID 是旧版本、要和 02G 数据对齐时用——版本不对齐是小麦数据分析最常见的静默错误源。注意：这只是 ID 表之间的映射，**不等于确认了参考组装版本**。"
        },
        {
          "name": "wheatomics_cross_species_homologs",
          "summary": "把一个小麦基因映射到其他物种的同源基因（BLAST 比对结果，含 identity、覆盖度、E 值、得分），用于跨物种功能推断。当用户问「这个小麦基因在水稻/拟南芥里对应哪个基因」时用。**覆盖范围只有水稻与拟南芥**——实测返回的 species 是 Rice 与 Arabidopsis，不是全部物种，也不代表全部禾本科。注意：上游没有给出直系同源/旁系同源的分类字段，本工具**不区分 ortholog 与 paralog**，只报同源命中；max_targets 是**每个物种**的返回上限，不是总条数。查无返回\"本次返回 0 条\"，不代表该基因不存在。"
        },
        {
          "name": "wheatomics_variant_datasets",
          "summary": "列出 WheatOmics VariantHub 收录的小麦变异数据集（参考基因组 + dataset key），共 29 个数据集、3 个参考基因组。当用户想查某个区间的 SNP/InDel 时，**先用它拿到 dataset key**，再调 wheatomics_variant_query。**注意 genome_concordant 字段**：它标示该数据集的坐标是否与所选参考基因组一致；实测 29 个数据集里 27 个为 true、2 个为 false（`WEC_filtered_SNPs`、`WEC_filtered_INDELs`）。选非一致数据集时，0 条结果不能解读为该区间没有变异——**但\"为什么返回 0\"本仓未查明，不做推断**。优先选 genome_concordant=true 的数据集。"
        },
        {
          "name": "wheatomics_variant_query",
          "summary": "查 WheatOmics VariantHub 里某个数据集、某个染色体区间的变异记录（SNP/InDel），返回位点、ID、ref/alt、质量、过滤标记与 VEP 注释摘要。当用户问「chr1A 上 1–200kb 有哪些变异」「这个区间有没有 SNP」时用。**region 是单个字符串参数**，格式 chrom:start-end（如 chr1A:1-200000），不是三个参数。区间为**闭区间，两端都含**（start 与 end 都包含）——这是**端点包含性的实测结论，不涉及 1-based / 0-based 的命名**。**起点与终点不能相同**：上游会以 400 拒绝这种等端点区间，本仓在本地先拒（不是\"该位点没有变异\"）；查单位点请给 pos-1-pos+1。**0 条不等于该区间没有变异**：数据集与坐标体系可能不匹配，请先用 wheatomics_variant_datasets 确认 genome_concordant=true。**区间参数非法会被上游以 400 拒绝，那不是\"没有变异\"**，本仓在本地先做该校验。**本仓不暴露按变异 ID 查询**：上游该路径是全表扫描（实测约 19 s，超出本仓上游超时预算），能力面差异归本仓、不是上游缺陷；本工具只按区间查。**本仓不提供 offset**：上游支持分页，本仓未暴露分页参数；上游标记\"还有更多\"时请缩小 region 后重查，不要指望翻页。"
        },
        {
          "name": "wheatomics_gene_annotation",
          "summary": "按 Pfam 结构域编号查询 WheatOmics 小麦基因注释（例如 PF00319）。只查默认注释表，不是按基因 ID 查详情，也不覆盖区间注释或全植物。坐标单位为 Mb。本地裁剪并报告总数和展示数，不是上游分页。"
        },
        {
          "name": "wheatomics_sequence",
          "summary": "按小麦基因ID从WheatOmics获取基因或蛋白序列的一个本地分块。不接区间查询、不覆盖全植物；同ID完全相同的FASTA去重，不同记录报错不拼接。offset是所选去重序列的本地1起位置，不是基因组坐标；gene单位碱基、protein单位氨基酸残基。仅已验证的by-gene JSON 404判本次未找到。"
        }
      ],
      "pinned": false,
      "order": 1
    },
    {
      "id": "gwh",
      "displayName": "GWH 基因组仓库（NGDC）",
      "label": {
        "zh": {
          "name": "GWH 基因组仓库（NGDC）",
          "blurb": "按精确 ID 取基因组 / 组装记录，以及项目与样本元数据；不提供按物种或关键词搜索。"
        },
        "en": {
          "name": "GWH — Genome Warehouse (NGDC)",
          "blurb": "Genome and assembly records plus project and sample metadata, by exact ID only."
        }
      },
      "tier": "T1",
      "homepage": "https://ngdc.cncb.ac.cn/gwh/",
      "species": [
        "Taraxacum kok-saghyz"
      ],
      "caveats": [
        "本仓未声明覆盖范围：species 只是已验证示例（genome/1 的 organism），不是覆盖承诺；browse/assembly 的 group 字段实测含 Animals/Plants/Fungi/Bacteria/Archaea/Viruses/Metagenomes/Protists，recordsTotal=3,471,431，示例非穷尽，不保证任意物种有记录",
        "只接受精确 ID：纯数字 genome_id、GWH 组装号、PRJCA 项目、SAMC 样本；GCA_/GCF_ 与 SAMN/SAMEA 不在范围（实测上游对它们只回全 null 或 Nonentity，无法与查无区分）",
        "按物种或关键词检索上游不可用（DataTables 的 search 参数实测不生效），本仓不提供搜索工具",
        "项目与样本是两条平行入口：上游不返回“项目下的样本列表”，也不返回“样本所属项目”",
        "查无是 HTTP 200 + 特定空结构，不是 404；文件下载只给路径，不承诺可下载（实测基因组包 389,670,521 B）"
      ],
      "versionNote": "版本只按响应字段（releaseTime 等）透出；未声明即未知，不按 accession 外观推断",
      "toolCount": 2,
      "tools": [
        {
          "name": "gwh_assembly_lookup",
          "summary": "按精确 ID 查 GWH 的基因组/组装详情：entity=genome 用于纯数字 genome_id（取物种、代表组装及下一步 accession），entity=assembly 用于 GWH 组装号（取组装级别、项目/样本 accession 与六类下载路径）。需要精确 ID，不按物种搜索；只给路径不下载文件；GCA_/GCF_ 不在范围；查无是 HTTP 200 空结构。"
        },
        {
          "name": "gwh_project_sample_lookup",
          "summary": "按精确 ID 查 GWH 的项目或样本元数据：entity=project 用于 PRJCA 项目（标题、描述、分类单元、数据类型、文献条数），entity=sample 用于 SAMC 样本（物种、样本类型、组织等属性）。需要精确 accession；项目与样本是平行入口，上游不返回项目下的样本列表，也不返回样本所属项目；项目/样本只收 PRJCA/SAMC，PRJNA/PRJDB/SAMN/SAMEA 不在范围。"
        }
      ],
      "pinned": false,
      "order": 2
    },
    {
      "id": "icg",
      "displayName": "ICG 内参基因数据库（NGDC）",
      "label": {
        "zh": {
          "name": "ICG 内参基因数据库（NGDC）",
          "blurb": "物种目录，以及每项研究自己验证过的内参基因与引物组合（不是通用推荐）。"
        },
        "en": {
          "name": "ICG — Internal Control Genes (NGDC)",
          "blurb": "Species catalogue plus the reference genes and primer pairs each study itself validated."
        }
      },
      "tier": "T1",
      "homepage": "https://ngdc.cncb.ac.cn/icg/",
      "species": [
        "Zea mays"
      ],
      "caveats": [
        "本仓未声明覆盖范围：species 只是已验证示例（物种 ICG00115 = Zea mays），不是覆盖承诺；物种目录有 540 条（上游 recordsTotal），示例非穷尽，不保证任意物种有记录",
        "四层 ID 必须显式选择：物种 ICG00001、研究 ICG00001-1、基因 ICG00001-1-EF1a、文献用 PubMed ID；层级由 entity 决定，不按横杠数量推断，也不自动换 entity 重试",
        "物种列表只能分页浏览，不能按名称搜索（search 参数实测不可用）",
        "引物是该研究验证过的组合，不是通用推荐；applicationScope 是该研究的验证范围",
        "联系方式字段（contactName/contactEmail/hostInstitution）不进输出、raw 与错误文本"
      ],
      "versionNote": "版本只按响应字段（lastModified 等）透出；未声明即未知，不按 accession 外观推断",
      "toolCount": 2,
      "tools": [
        {
          "name": "icg_lookup",
          "summary": "按精确 ID 查 ICG 内参基因数据库的四层实体：entity=species 取物种及其研究列表，entity=project 取某研究的内参基因、引物与验证范围，entity=gene 取单基因的引物，entity=publication 取文献及其研究列表（id 为 PubMed 数字 ID）。层级必须显式选择，不按横杠数量推断、不自动换 entity。引物是该研究验证过的组合，不是通用推荐；不按基因名或性状检索。"
        },
        {
          "name": "icg_species_list",
          "summary": "分页浏览 ICG 物种目录（上游 recordsTotal=540），用于拿到物种 accession 以继续 project/gene 查询。只能分页浏览，不能按名称搜索（上游 search 参数不可用）；本工具不承诺覆盖范围，返回行数受 limit 与 4 KB 预算限制。"
        }
      ],
      "pinned": false,
      "order": 3
    },
    {
      "id": "ic4r",
      "displayName": "IC4R 水稻信息共享平台（NGDC）",
      "label": {
        "zh": {
          "name": "IC4R 水稻信息共享平台（NGDC）",
          "blurb": "仅粳稻：基因、功能注释、circRNA、lncRNA 与 ID 映射，可按染色体分页浏览 locus。"
        },
        "en": {
          "name": "IC4R — Rice Information Resource (NGDC)",
          "blurb": "Japonica rice only: genes, functional annotation, circRNA, lncRNA, ID mapping, and locus browsing by chromosome."
        }
      },
      "tier": "T1",
      "homepage": "https://ngdc.cncb.ac.cn/ic4r/",
      "species": [
        "Oryza sativa"
      ],
      "caveats": [
        "仅覆盖水稻单一物种（响应 source=Oryza sativa Japonica Group）；不声明其他物种",
        "ID 获取：可按染色体分页列基因 locus（ic4r_gene_list，chromosome 取页面给出的 1–12 / Sy / Un，DataTables start/length）；不能按基因名、性状或基因组区间检索；length 的上游上限未测（本仓自限 50）；上游对枚举外的染色体取值（如 99）实测返回 HTTP 200 + recordsTotal=0，本地拒绝属于产品层白名单约束，不是上游限制",
        "按 ID 查询需要精确 locus/accession；circRNA/lncRNA 的列表端点未验证，不提供",
        "上游查无时返回 HTTP 200 + 0 字节正文，annotation 返回 []；本仓把空响应报成“无法确认是否存在”，不判记录不存在",
        "circRNA 与 lncRNA 是各自的 ID 空间（…Circ…／…Lnc…），与基因 locus 不通用；序列默认整条展示、超 4 KB 预算整条省略",
        "ID 映射只承诺已测方向：IC4R locus → MSU / RAP-DB；反向未测，不承诺"
      ],
      "versionNote": "接口与数据版本只能写“IC4R 2.0（文档声明，2018-05）”；lastModified 是 epoch 毫秒，按 UTC 转 ISO 并标注，不把接口版本当数据版本",
      "toolCount": 6,
      "tools": [
        {
          "name": "ic4r_gene",
          "summary": "按精确 IC4R 基因 locus 取水稻基因记录：同义词、描述、MSU/RAP-DB accession、类型、链、染色体、基因长度、位置；不含序列。只覆盖水稻单一物种；不能按名称检索，按染色体浏览请用 ic4r_gene_list；locus 是基因 ID 空间（…G…），与 circRNA（…Circ…）、lncRNA（…Lnc…）不通用。上游查无时返回 0 字节正文，本工具报“无法确认是否存在”，不判记录不存在。"
        },
        {
          "name": "ic4r_annotation",
          "summary": "按精确 IC4R 基因 locus 取功能注释（SUPPERFAMILY / Gene3D / InterPro / Pfam / CDD 等类别），按类别分组、每组最多展示 2 条并报本次返回条数。只覆盖水稻单物种；annotation 端点查无时返回空数组 []，本工具报“本次未返回注释”，不表示该基因没有注释。"
        },
        {
          "name": "ic4r_circrna",
          "summary": "按精确 circRNA accession 取水稻 circRNA 记录：染色体、别名、长度、类型、亲本基因、起止、链、物种与序列。accession 是 circRNA ID 空间（…Circ…），不是基因 locus；序列默认整条展示，超过 4 KB 预算则整条省略（不截半条）。查无时上游返回 0 字节正文，本工具报“无法确认是否存在”。"
        },
        {
          "name": "ic4r_lncrna",
          "summary": "按精确 lncRNA accession 取水稻 lncRNA 记录：染色体、链、位置、长度与序列。accession 是 lncRNA ID 空间（…Lnc…，可能带 .1 后缀），不是基因 locus；序列默认整条展示，超 4 KB 预算整条省略。注意：唯一实测样例的 1,639 bp 序列默认不展示，这是预算结果，并非上游没有序列。查无时上游返回 0 字节正文，本工具报“无法确认是否存在”。"
        },
        {
          "name": "ic4r_id_convert",
          "summary": "把精确 IC4R 基因 locus 映射到 MSU 与 RAP-DB 数据库的 ID（附 symbol）。只承诺已测方向：IC4R locus → MSU / RAP-DB；反向映射（MSU/RAP-DB → IC4R）未测，本工具不承诺，输入必须是 IC4R locus（…G…）。查无时上游返回 0 字节正文，本工具报“无法确认是否存在”。"
        },
        {
          "name": "ic4r_gene_list",
          "summary": "按染色体分页列出 IC4R 粳稻基因的 locus（ID 发现入口）：chromosome 取页面的 1–12 / Sy / Un，start/length 为 DataTables 分页（length 本仓上限 50）。返回上游 recordsTotal、本次返回条数与每行 locus/描述/类型/位置；拿到 locus 后可用 ic4r_gene 取详情。只能按染色体浏览，不能按基因名、性状或区间检索；本仓不承诺 length 的上游上限（未测）。上游对枚举外的值（如 99）实测返回 HTTP 200 + recordsTotal=0，本地拒绝属于产品层白名单约束，不是上游限制。"
        }
      ],
      "pinned": false,
      "order": 4
    },
    {
      "id": "gramene",
      "displayName": "Gramene v69（禾本科比较基因组）",
      "label": {
        "zh": {
          "name": "Gramene v69 禾本科比较基因组",
          "blurb": "全文检索、基因、差异表达与分类单元查询；实测物种是水稻的两个分类单元。"
        },
        "en": {
          "name": "Gramene v69",
          "blurb": "Full-text search, genes, differential expression and taxonomy; species verified so far are two rice taxa."
        }
      },
      "tier": "T1",
      "homepage": "https://data.gramene.org/v69/",
      "species": [
        "Oryza sativa",
        "Oryza sativa Indica Group"
      ],
      "caveats": [
        "本仓未声明覆盖范围：实测物种只有 Oryza sativa（taxid 4530）与 Oryza sativa Indica Group（39946001），未逐物种采样，不把覆盖范围外推到整个禾本科",
        "入口不同：/search 用自由文本 q；genes/expression/taxonomy 只接受 idList，把 q 传给它们只会得到空数组",
        "idList 是数组参数：数值型单值（如 idList=4530）会被上游校验器拒绝（400 Expected type array but found type integer）；本仓对单值数字重复一次发送，并在输出里注明这是规避写法",
        "查无是 HTTP 200 + 空数组（search 为 numFound=0），不是 404，也不能据此断言 ID 不存在",
        "/search 的 content-type 是 text/plain 而正文是 JSON，本仓按正文解析，不按 content-type 判断",
        "单条基因响应 8.5 KB（含 xrefs）；工具只输出裁剪后的关键字段，不返回 xrefs"
      ],
      "versionNote": "数据版本只能写 v69（Swagger 的 basePath）；与 Ensembl 版本的对应关系未核验，不推断",
      "toolCount": 4,
      "tools": [
        {
          "name": "gramene_search",
          "summary": "在 Gramene v69 用自由文本 q 全文检索（Solr 风格）：返回上游 numFound 与前若干条命中（id/名称/分类单元/类型），并标明“本次返回 N 条”。只覆盖已实测物种（Oryza sativa / Indica Group），不声称覆盖全部禾本科；只能全文检索，不能按字段精确过滤。"
        },
        {
          "name": "gramene_gene",
          "summary": "按精确文档 ID 列表取 Gramene 基因记录（这是 /genes 的 idList 入口，不是按名称检索）：名称、描述、类型、分类单元、物种系统名与位置。单条原始响应约 8.5 KB（含 xrefs），本工具只输出裁剪后的关键字段、不返回 xrefs；查无是 200 + 空数组，不能据此断言 ID 不存在。"
        },
        {
          "name": "gramene_expression",
          "summary": "按精确基因文档 ID 取 Gramene v69 的差异表达记录（/expression 的 idList 入口）：按实验列出 group、p_value、l2fc，最多展示 3 个实验、每实验 2 个比较。数值是上游原值，本工具不做显著性判定、不做跨实验合并；查无是 200 + 空数组。"
        },
        {
          "name": "gramene_taxonomy",
          "summary": "按 NCBI 数字 taxid 取 Gramene v69 的分类单元记录（/taxonomy 的 idList 入口）：名称、rank、基因数、同义名与祖先链长度。只接受数字 taxid（如 4530 / 39946001），前导零按数值归一（04530 与 4530 视为同一 taxid）；实测数值型单值直接传会被上游校验器拒绝，本仓重复一次发送，输出会注明这条规避写法。查无是 200 + 空数组，不能据此断言 taxid 不存在。"
        }
      ],
      "pinned": false,
      "order": 5
    },
    {
      "id": "scod",
      "displayName": "SCOD 甘蔗多组学数据库",
      "label": {
        "zh": {
          "name": "SCOD 甘蔗多组学数据库（NGDC）",
          "blurb": "仅甘蔗：基因组目录，以及按区间查基因——整条基因完全落在区间内才返回。"
        },
        "en": {
          "name": "SCOD — Sugarcane Multi-Omics (NGDC)",
          "blurb": "Sugarcane only: genome catalogue and region gene queries, returning only genes fully inside the region."
        }
      },
      "tier": "T2",
      "homepage": "https://ngdc.cncb.ac.cn/scod/",
      "species": [
        "Saccharum spontaneum"
      ],
      "caveats": [
        "仅适配甘蔗基因组目录与区间筛选，不承诺所有植物或全部14材料的每项查询均已实测；区间正例仅genomeId=1、Chr1A",
        "返回整条基因完全落在所给区间内的记录；跨边界基因不返回，不是任意重叠查询；不支持用单个位点查覆盖该点的基因",
        "分页length由本地严格限为1–50；50是产品安全上限，不是上游硬限制",
        "不接表达、变异、功能筛选、基因名搜索、序列下载；无API文档，裸数组与DataTables信封分别解析"
      ],
      "versionNote": "组装与注释版本未知；genome_id为上游目录键，不推断为版本号；坐标基数命名未核验",
      "toolCount": 2,
      "tools": [
        {
          "name": "scod_genome_list",
          "summary": "列出SCOD甘蔗基因组目录，取得后续区间查询必需的genome_id。不是全植物目录，不开放尚未验证的term搜索；目录存在不等于每个材料的区间查询都已验证。"
        },
        {
          "name": "scod_gene_region",
          "summary": "在SCOD按基因组、染色体与区间筛选甘蔗基因：返回整条基因完全落在pos_start–pos_end内的记录，跨边界基因不返回，不是任意重叠查询。区间要覆盖整个基因；只给一个位点不能查覆盖该点的基因；0条不等于这个位置没有基因。正例仅genome_id=1、Chr1A；不外推其他植物。用start/length服务端分页，本地严格length≤50；坐标基数命名未核验。"
        }
      ],
      "pinned": false,
      "order": 6
    },
    {
      "id": "ensemblplants",
      "displayName": "Ensembl Plants（EMBL-EBI）",
      "label": {
        "zh": {
          "name": "Ensembl Plants（EMBL-EBI）",
          "blurb": "拟南芥、水稻、小麦、玉米四个物种：按符号或 ID 查基因、取基因组序列、查外部 ID 映射。"
        },
        "en": {
          "name": "Ensembl Plants (EMBL-EBI)",
          "blurb": "Gene lookup by symbol or ID, genomic sequence and external cross-references for four species: Arabidopsis, rice, wheat, maize."
        }
      },
      "tier": "T1",
      "homepage": "https://plants.ensembl.org/",
      "species": [
        "Arabidopsis thaliana",
        "Oryza sativa",
        "Triticum aestivum",
        "Zea mays"
      ],
      "caveats": [
        "这是 ensembl.org 的共享 REST，同一 host 也服务脊椎动物（实测 homo_sapiens 的 TP53 返回 200）；本工具按物种白名单与响应侧 species 双重拦截",
        "基因 ID 分代次：玉米当前组装为 NAM-5.0（Zm00001eb…）；已实测旧编号 Zm00001d027624（B73 v4）本次查无，且返回与“基因不存在”相同。本仓不据此判定整类旧编号不可查",
        "已知缺口：批量 POST /lookup/id 本批未接（需公共层支持非 GET），只能逐条查询",
        "查无是 HTTP 400 而非 404，且参数错误同样是 400；本仓按端点+请求身份+完整原体三重锚定分流，未知形态一律报错不归空",
        "区间（overlap/region）与同源（homology）未接：50 kb 变异区间实测 1.9 MB，1 Mb 起 8 MB/27.6 s",
        "本机到该站点链路抖动明显：31 次尝试仅 6 次成功，25 次为连接超时；超时不等于物种或端点不支持"
      ],
      "versionNote": "组装版本取响应 assembly_name（实测：拟南芥 TAIR10、水稻 IRGSP-1.0、小麦 IWGSC、玉米 Zm-B73-REFERENCE-NAM-5.0，release 116）；本仓未核验其与 Ensembl release 号的完整对应关系，不按 ID 外观推断版本",
      "toolCount": 3,
      "tools": [
        {
          "name": "ensemblplants_lookup_gene",
          "summary": "在 Ensembl Plants 按基因符号或基因 ID 定位单个植物基因，返回其 ID、符号、生物类型、组装版本、染色体位置与描述。当用户给出拟南芥/水稻/小麦/玉米的基因名（如 FT、Os01g0100100）或 Ensembl 基因 ID 并想知道“它是什么、在哪”时用它。只支持已实测的四个物种；其他物种与人类等非植物对象会被拒绝。**基因 ID 是分代次的**：已实测旧编号 `Zm00001d027624`（B73 v4）在本源查无，玉米当前组装为 NAM-5.0（`Zm00001eb…`）；旧编号可能因代次差异不可查，但本工具不据此判定整类编号。不支持批量查询（一次一个基因），也不返回序列、外链 ID 或区间内基因。"
        },
        {
          "name": "ensemblplants_sequence",
          "summary": "按 Ensembl 基因 ID 取该基因的基因组序列（genomic，单位 bp）或蛋白序列（protein，单位 aa）。当用户要“这个基因的序列/蛋白序列/翻译产物”时用它。**先查 lookup 核验物种再取序列**，因此每次调用会发两次上游请求，两处出处都会列出。一次可能返回多条第转录本序列（实测一个基因回 2 条），**逐条列出、绝不拼接**，最多展示 3 条。序列超过正文预算时只展示前缀，并会同时给出**完整长度、展示区间、已截断**三项。只支持 genomic 与 protein 两种类型（**cdna/cds 未开放**）；只覆盖已实测四物种；不接区间取序列。"
        },
        {
          "name": "ensemblplants_xrefs",
          "summary": "查一个 Ensembl 植物基因在其它数据库（TAIR、EntrezGene、UniProt、ArrayExpress 等）里的对应记录，用于跨库跳转。当用户问“这个基因在 TAIR/NCBI 里叫什么”时用它。**先查 lookup 核验物种再取映射**（xrefs 接口本身既无物种字段也无组装名），每次调用发两次上游请求，两处出处都会列出。实测一个基因返回 9 条映射、2,030 B 超正文预算，因此只展示前若干条并报总数与省略数，不静默截断。只覆盖已实测四物种；不按数据库过滤；不是序列或区间查询。"
        }
      ],
      "pinned": false,
      "order": 7
    }
  ],
  "metaTools": [
    {
      "name": "hub_find_sources",
      "summary": "不知道哪个数据库能回答时先用它：给一句自然语言问题（可带 species_hint/intent_hint），返回候选源与可直接调用的工具名、命中依据与盲区；没有覆盖会如实说「未覆盖」而不是「数据不存在」。它是本地目录查询，不发任何上游请求，也不代替具体工具作答。",
      "label": {
        "en": "Ask which source can answer a plain-language question; returns candidate sources, callable tool names and blind spots. It says \"not covered\" instead of inventing an answer."
      }
    },
    {
      "name": "hub_status",
      "summary": "体检用：列出本服务当前的源、每个源的语义与物种口径、工具数与意图覆盖、预算余量、已知缺口。当用户问「你能查什么／一共几个库／为什么查不到某个物种／还能加多少」时用它；也可用于排查「是没这个能力」还是「检索没召回」。纯本地目录事实，不访问上游，不承诺任何源此刻可用。",
      "label": {
        "en": "Health sheet: current sources, each source’s scope, tool counts, budget headroom and known gaps. Local catalogue facts only — it does not promise any upstream is reachable now."
      }
    }
  ]
};

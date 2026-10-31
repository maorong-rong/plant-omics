import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { renderFields, renderTable, utf8Bytes } from '../../core/format.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest } from '../../core/request.js';
import {
  objectsOf,
  optionalArrayField,
  optionalIntArg,
  optionalStringArg,
  requireArrayField,
  requireStringArg,
  splitIds,
} from '../../core/shape.js';
import type { HttpResult, ToolContext, ToolDefinition, ToolResult } from '../../core/types.js';
import { manifest } from './manifest.js';
import { geneAnnotation } from './annotation.js';
import { geneSequence } from './sequence.js';

// ── 上游信封（按 2026-10-27 实测写；**只有信封是本人确认过的契约**） ──────────

interface Envelope<T> {
  success?: boolean;
  message?: string;
  timestamp?: string;
  data?: T;
}

/** 单次批量查询的基因数上限。上游没写死，我们自己定，避免拼出超长 URL。 */
const MAX_GENES_PER_QUERY = 50;
/** 基因 ID 换算单次上限（ID 用 CRLF 拼进查询串，太长会被网关拒）。 */
const MAX_IDS_PER_CONVERSION = 200;
/** 表达条件默认展示条数（仅当条件超过全展开阈值时才截断）。 */
const DEFAULT_TOP_CONDITIONS = 8;
/** 条件数不超过这个值就全部展示，不做截断。 */
const MAX_INLINE_CONDITIONS = 20;

// ── 小工具 ────────────────────────────────────────────────────────────────

function endpoint(path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(`${manifest.apiBase}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** 拆掉 `{success,message,data}` 信封；success=false 直接抛，因为此时 data 不可用。 */
function unwrap<T>(payload: unknown, url: string): T {
  const envelope = payload as Envelope<T> | null;
  if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) {
    throw new UpstreamError('上游响应不是约定的 {success,message,data} 信封——契约可能已变', {
      url,
      bodySnippet: envelope ? `keys=${Object.keys(envelope).slice(0, 10).join(',')}` : 'non-object',
    });
  }
  if (envelope.success === false) {
    throw new UpstreamError(`上游 success=false：${envelope.message ?? '未给原因'}`, { url });
  }
  if (envelope.data === undefined || envelope.data === null) {
    throw new UpstreamError('上游 data 为空', { url });
  }
  return envelope.data;
}

/** 预检在网络之前；局部result闭包保证收尾使用同一份完整请求证据。 */
async function query(ctx: ToolContext, url: string, presentation: Record<string, unknown> = {}) {
  const prepared = prepareRequest({ url, sourceName: manifest.displayName, presentation });
  const res = await fetchPrepared(ctx, prepared);
  const result = (body: string, response: HttpResult, raw: unknown, extra?: string): ToolResult =>
    finishResult({ body, res: response, raw, prepared, sourceId: manifest.id,
      extra: [manifest.versionNote, extra].filter(Boolean).join('；') });
  return { res, result };
}

function num(value: unknown, digits = 3): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return Number(n.toFixed(digits)).toString();
}

/**
 * 数值字段的**安全取数**。
 *
 * `Number(null) === 0`、`Number('') === 0`、`Number(undefined) === NaN`——
 * 前两个会把手上的"缺值"渲染成"表达量 0 ± 0"，看起来完全正常，实际是**编造数据**
 * （审查 P1）。所以缺值一律判为 NaN，由 `num()` 渲染成 `-`。
 */
function toNum(value: unknown): number {
  if (value === null || value === undefined || value === '') return Number.NaN;
  if (typeof value === 'object') return Number.NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text.length ? text : undefined;
}

// ── 工具 ──────────────────────────────────────────────────────────────────

const searchKnownGenes: ToolDefinition = {
  name: 'wheatomics_search_known_genes',
  description:
    '在小麦「已克隆功能基因」库里模糊搜索（基因 ID、基因名、性状、物种、DOI 均可命中）。'
    + '当用户问「小麦里调控某某性状的有哪些已知基因」「TaVRN1 是什么基因」时先调这个；'
    + '返回的是人工整理过的克隆基因条目，不同于全基因组注释。',
  parameters: {
    type: 'object',
    properties: {
      searchid: {
        type: 'string',
        description: '搜索关键词，支持部分匹配，例如 VRN1、TaMs5-B、male sterility、vernalization',
      },
      limit: {
        type: 'integer',
        description: '最多返回多少条（1–50，默认 15）',
        default: 15,
        minimum: 1,
        maximum: 50,
      },
    },
    required: ['searchid'],
    additionalProperties: false,
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const searchid = requireStringArg(args, 'searchid', 200);
    const limit = optionalIntArg(args, 'limit', 15, 1, 50);
    const url = endpoint('/genes/known/search', { searchid });
    const { res, result } = await query(ctx, url, { limit });
    const data = unwrap<unknown>(res.data, url);

    // 字段缺失 = 契约变了，不许退化成「没有匹配」
    const records = objectsOf(requireArrayField(data, 'records', url, '已知基因搜索'));
    const total = Number((data as { total?: unknown }).total);

    if (records.length === 0) {
      return result(
        `没有匹配「${searchid}」的已知克隆基因（上游明确返回 0 条，不是解析失败）。`,
        res,
        data,
        `total=0`,
      );
    }

    const rows = records.slice(0, limit).map((r) => [
      r.gene_id,
      r.gene_name,
      r.phenotype,
      r.chrom_pos,
      Array.isArray(r.dois) ? r.dois.slice(0, 2).join('; ') : r.dois,
    ]);
    const body = [
      `关键词「${searchid}」命中 ${Number.isFinite(total) ? total : records.length} 条已知克隆基因。`,
      '',
      // maxRows 必须跟随 limit，否则用户要 50 条、实际只渲染 20 条（审查 R08.4）
      renderTable(['gene_id', 'gene_name', 'phenotype', 'chrom_pos', 'DOI'], rows, {
        maxCell: 45,
        maxRows: limit,
      }),
    ].join('\n');

    return result(body, res, data, `total=${Number.isFinite(total) ? total : records.length}`);
  },
};

const geneDetail: ToolDefinition = {
  name: 'wheatomics_gene_detail',
  description:
    '按基因 ID 取小麦基因的标准化详情（描述、染色体位置、蛋白长度、分子量、等电点、功能注释、JBrowse 链接）。'
    + '接受 01G / 02G / 03G 三种前缀的 ID（上游各端点对这三个版本叫法不完全一致，本工具按前缀识别）。'
    + '当用户给出一个具体小麦基因 ID 并想知道「它是什么、在哪、蛋白多长」时用这个。',
  parameters: {
    type: 'object',
    properties: {
      gene_id: {
        type: 'string',
        description: '小麦基因 ID，例如 TraesCS5A02G391700（02G）、TraesCS5A01G391700（01G）、TraesCS5A03G0935400（03G）',
      },
    },
    required: ['gene_id'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const geneId = requireStringArg(args, 'gene_id', 200);
    const url = endpoint(`/genes/detail/${encodeURIComponent(geneId)}`);
    const { res, result } = await query(ctx, url);
    const data = unwrap<Record<string, unknown>>(res.data, url);

    const start = data.start;
    const end = data.end;
    const span = typeof start === 'number' && typeof end === 'number' ? `${start}–${end}` : undefined;
    const body = renderFields([
      ['查询基因', data.query_gene ?? geneId],
      ['对应 ID（同源版本）', data.gene_ids],
      ['描述', data.description ?? '（上游无人工描述）'],
      ['上游 genome 字段', data.genome],
      ['染色体', data.chromosome],
      ['区间', span],
      ['链方向', data.strand],
      ['蛋白长度（aa）', data.protein_length],
      // 上游 molecular_weight 未标单位：245 aa 的蛋白返回 27838.39，量级像 Da。
      // 不替它猜单位——猜错就是 1000 倍的错误（这条比"看起来完整"重要）。
      ['分子量（上游原值，单位未标注）', data.molecular_weight],
      ['等电点', data.isoelectric_point],
      ['功能注释', data.functions],
    ]);

    return result(
      body || '上游返回了空对象：该 ID 可能不存在，或上游改版后不再返回这些字段。',
      res,
      data,
    );
  },
};

const expressionProjects: ToolDefinition = {
  name: 'wheatomics_expression_projects',
  description:
    '列出 WheatOmics 已整合的小麦表达谱项目（芯片/RNA-seq，含组织、发育期、胁迫、激素处理等）。'
    + '当用户想找「有没有干旱胁迫下的表达数据」「有哪些籽粒发育的表达谱」时用；'
    + '先用它拿到 project 标识，再调 wheatomics_expression_query。'
    + '结果按 group 汇总，可用 keyword 过滤具体项目。',
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '可选，在项目 id / 描述里做不区分大小写的子串过滤，例如 drought、grain、PRJEB5314',
      },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const keyword = optionalStringArg(args, 'keyword', 200);
    const url = endpoint('/expression/projects');
    const { res, result } = await query(ctx, url, { keyword: keyword ?? null });
    const data = unwrap<unknown>(res.data, url);
    const projects = objectsOf(requireArrayField(data, 'projects', url, '表达项目列表'));

    if (projects.length === 0) {
      return result('上游明确返回 0 个表达项目。', res, data, 'projects=0');
    }

    // 上游返回 600 KB 量级，绝不整表输出。默认只给 group 汇总。
    const byGroup = new Map<string, number>();
    for (const project of projects) {
      const group = str(project.group) ?? '(未分组)';
      byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
    }

    const lines = [`共 ${projects.length} 个表达谱项目，按 group 汇总：`, ''];
    lines.push(
      renderTable(
        ['group', '项目数'],
        [...byGroup.entries()].sort((a, b) => b[1] - a[1]).map(([group, count]) => [group, count]),
        { maxCell: 50, maxRows: 30 },
      ),
    );

    if (keyword) {
      const needle = keyword.toLowerCase();
      const hits = projects.filter((project) =>
        [project.id, project.description, project.group, project.subgroup]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle)),
      );
      lines.push('', `按关键词「${keyword}」匹配 ${hits.length} 个：`, '');
      lines.push(
        hits.length
          ? renderTable(
              ['project', 'group', 'description'],
              hits.map((project) => [project.id, project.group, project.description]),
              { maxCell: 70, maxRows: 20 },
            )
          : '（无匹配。可直接不带 keyword 看 group 汇总，或换更宽的关键词）',
      );
    } else {
      lines.push('', '提示：加 keyword 可筛出具体项目 id；拿到 id 后用 wheatomics_expression_query 查表达量。');
    }

    return result(lines.join('\n'), res, { total: projects.length }, `projects=${projects.length}`);
  },
};

const expressionQuery: ToolDefinition = {
  name: 'wheatomics_expression_query',
  description:
    '查一个或多个小麦基因在指定表达谱项目里的表达量：**均值 ± 标准差**，按表达量降序给最高的若干个条件。'
    + '当用户问「这个基因在哪些组织/处理下高表达」时用。'
    + '已给出具体条件名（如 grain）时传 condition 只看那类条件；'
    + 'project 不填则用上游默认项目，建议先用 wheatomics_expression_projects 选项目。'
    + '注意：表达值单位随项目而定，上游未逐点标注，**跨项目不可直接比较大小**。',
  parameters: {
    type: 'object',
    properties: {
      gene_ids: {
        type: 'string',
        description: '一个或多个基因 ID，用逗号分隔（最多 50 个），例如 TraesCS5A02G391700,TraesCS1A02G001000',
      },
      project: {
        type: 'string',
        description: '表达项目标识（来自 wheatomics_expression_projects 的 project 列），例如 PRJEB5314_paired_tbl',
      },
      condition: {
        type: 'string',
        description: '可选，按条件名子串过滤，例如 grain、root、Z85（不区分大小写）。用它可以专门看被默认排序挤掉的条件下',
      },
      top: {
        type: 'integer',
        description: '每个基因最多列多少个条件（按表达量降序，1–30，默认 8）',
        default: 8,
        minimum: 1,
        maximum: 30,
      },
    },
    required: ['gene_ids'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    // 逗号/空白分隔的多基因；上游也支持重复参数，这里统一用逗号串
    const ids = splitIds(requireStringArg(args, 'gene_ids', 2_000), MAX_GENES_PER_QUERY, 'gene_ids');
    const project = optionalStringArg(args, 'project', 200);
    const condition = optionalStringArg(args, 'condition', 100);
    const top = optionalIntArg(args, 'top', DEFAULT_TOP_CONDITIONS, 1, 30);

    const url = endpoint('/expression/query', { gene_ids: ids.join(','), project });
    const { res, result } = await query(ctx, url, { condition: condition ?? null, top });
    const data = unwrap<Record<string, unknown>>(res.data, url);

    const results = objectsOf(requireArrayField(data, 'results', url, '表达查询'));
    const lines: string[] = [
      `项目：${str(data.project) ?? project ?? '(上游默认)'}｜找到基因 ${num(data.genes_found, 0)} 个`,
    ];

    const notFound = data.genes_not_found;
    if (Array.isArray(notFound) && notFound.length > 0) {
      lines.push(`未找到：${notFound.slice(0, 20).join(', ')}${notFound.length > 20 ? ` 等 ${notFound.length} 个` : ''}`);
    }
    const converted = data.genes_converted;
    if (converted && typeof converted === 'object' && !Array.isArray(converted)) {
      const pairs = Object.entries(converted as Record<string, unknown>);
      if (pairs.length > 0) {
        lines.push(`ID 版本已由上游自动转换：${pairs.slice(0, 5).map(([from, to]) => `${from} → ${String(to)}`).join('；')}`);
      }
    }
    lines.push('');

    const needle = condition?.toLowerCase();
    for (const entry of results) {
      const points = (optionalArrayField(entry, 'points', url, '表达查询') ?? []).map((raw) => {
        const p = raw as { label?: unknown; value?: unknown; std?: unknown };
        return { label: str(p.label) ?? '?', value: toNum(p.value), std: toNum(p.std) };
      });

      const kept = needle ? points.filter((p) => p.label.toLowerCase().includes(needle)) : points;

      /**
       * 条件少就**全给**（15 个条件也就 300 字符），条件多才按表达量降序截前 N。
       *
       * 这条是审查 R02 直接逼出来的：原来无脑 `slice(0, 12)`，而 WheatOmics 的点是
       * 按组织/发育期排好序的，籽粒条件排在最后 —— 真实 fixture 里 3 个 grain 条件
       * 全部被裁掉，用户问"籽粒里怎么表达"时工具给不出答案，却也没报错。
       */
      const showAll = kept.length <= MAX_INLINE_CONDITIONS;
      const ordered = showAll
        ? kept
        : [...kept].sort(
            (a, b) => (Number.isFinite(b.value) ? b.value : -Infinity) - (Number.isFinite(a.value) ? a.value : -Infinity),
          );
      const shown = showAll ? ordered : ordered.slice(0, top);

      const rendered = shown
        .map((p) => `${p.label}=${num(p.value)}${Number.isFinite(p.std) ? `±${num(p.std)}` : ''}`)
        .join('；');

      // 用 reduce 而不是 Math.min(...arr)：点数上万时 spread 会 RangeError
      const finiteValues = kept.map((p) => p.value).filter((v) => Number.isFinite(v));
      let range = '';
      if (finiteValues.length > 0) {
        const { min, max } = finiteValues.reduce(
          (acc, v) => ({ min: Math.min(acc.min, v), max: Math.max(acc.max, v) }),
          { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
        );
        range = `，范围 ${num(min)}–${num(max)}`;
      }
      const scope = needle ? `含「${condition}」的 ${kept.length} 个条件` : `共 ${kept.length} 个条件`;
      const omitted = kept.length > shown.length
        ? `，按表达量降序列前 ${shown.length}（其余用 condition / top 继续查看）`
        : '';

      lines.push(`- ${str(entry.gene_id) ?? '?'}：${rendered || '无数据'}（${scope}${omitted}${range}）`);
    }

    if (results.length === 0) lines.push('上游未返回任何表达记录（genes_not_found 里可能已列出原因）。');
    lines.push('', '注：表达值单位随项目而定，上游未逐点标注；跨项目不可直接比较大小；±后为标准差。');

    return result(lines.join('\n'), res, data);
  },
};

const searchPapers: ToolDefinition = {
  name: 'wheatomics_search_papers',
  description:
    '检索 WheatOmics 收录的小麦族（Triticeae）文献元数据，可按关键词、性状、基因、时间窗过滤。'
    + '当用户想找「小麦耐旱相关近年文献」或为某个基因找参考文献时用。'
    + '返回的是该平台的精选文献库，不是 PubMed 全量。',
  parameters: {
    type: 'object',
    properties: {
      q: {
        type: 'string',
        description: '全文关键词（标题/摘要/期刊/作者/AI 标签），例如 vernalization、drought、grain weight',
      },
      limit: {
        type: 'integer',
        description: '返回条数（1–50，默认 10）',
        default: 10,
        minimum: 1,
        maximum: 50,
      },
      sinceDays: {
        type: 'integer',
        description: '只看最近 N 天入库的文献；用于「这周新增了什么」',
        minimum: 1,
      },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const q = optionalStringArg(args, 'q', 200);
    const limit = optionalIntArg(args, 'limit', 10, 1, 50);
    const sinceDays = optionalIntArg(args, 'sinceDays', 0, 0, 3_650) || undefined;
    const url = endpoint('/papers', { q, limit, since_days: sinceDays });
    const { res, result } = await query(ctx, url);
    const data = unwrap<Record<string, unknown>>(res.data, url);
    const papers = objectsOf(requireArrayField(data, 'papers', url, '文献检索'));
    const total = Number(data.total);

    if (papers.length === 0) {
      return result(`没有匹配「${q ?? '(未给关键词)'}」的文献（上游明确返回 0 条）。`, res, data, 'total=0');
    }

    const rows = papers.slice(0, limit).map((paper) => [
      paper.pmid ?? paper.pubmedid,
      paper.pub_date,
      paper.journal,
      paper.paper_title ?? paper.fga_title,
    ]);
    const body = [
      `命中 ${Number.isFinite(total) ? total : papers.length} 条文献（本次显示 ${Math.min(limit, papers.length)} 条）：`,
      '',
      renderTable(['PMID', '日期', '期刊', '标题'], rows, { maxCell: 80, maxRows: limit }),
    ].join('\n');

    return result(body, res, data, `total=${Number.isFinite(total) ? total : papers.length}`);
  },
};

const convertGeneIds: ToolDefinition = {
  name: 'wheatomics_convert_gene_ids',
  description:
    '把小麦基因 ID 在不同注释版本间换算，统一转成上游所称的 02G（IWGSC v1.1）格式。'
    + '支持 MIPS v2.2、TGACv1、IWGSC v1.0 三种源版本。'
    + '当用户手里的 ID 是旧版本、要和 02G 数据对齐时用——版本不对齐是小麦数据分析最常见的静默错误源。'
    + '注意：这只是 ID 表之间的映射，**不等于确认了参考组装版本**。',
  parameters: {
    type: 'object',
    properties: {
      ids: {
        type: 'string',
        description: '一个或多个转录本 ID（须带 .1 后缀，最多 200 个），用逗号或换行分隔，例如 TraesCS6B01G342500.1',
      },
      gene_version: {
        type: 'string',
        description: '源版本对应的表名',
        enum: ['MIPS_result', 'TGACv1_result', 'IWGSCv1_result'],
      },
    },
    required: ['ids', 'gene_version'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const idsRaw = requireStringArg(args, 'ids', 20_000);
    const geneVersion = requireStringArg(args, 'gene_version', 50);
    if (!['MIPS_result', 'TGACv1_result', 'IWGSCv1_result'].includes(geneVersion)) {
      throw new InvalidArgumentError(`gene_version 只能是 MIPS_result / TGACv1_result / IWGSCv1_result，收到 ${geneVersion}`);
    }

    const list = splitIds(idsRaw, MAX_IDS_PER_CONVERSION, 'ids');

    const url = endpoint('/id-conversion', {
      ID: list.join('\r\n'),
      gene_version: geneVersion,
    });
    const { res, result } = await query(ctx, url);
    const data = unwrap<Record<string, unknown>>(res.data, url);
    const mappings = objectsOf(requireArrayField(data, 'mappings', url, 'ID 换算'));

    const lines = [
      `源版本：${str(data.version) ?? geneVersion}｜输入 ${list.length} 个 ID｜映射成功 ${mappings.length} 个`,
    ];
    if (mappings.length) {
      lines.push('');
      lines.push(
        renderTable(
          ['输入 ID', '参考基因（02G）', '关系', '长度'],
          mappings.map((m) => [m.query_gene, m.reference_gene, m.code, m.length]),
          { maxCell: 45, maxRows: Math.min(mappings.length, 40) },
        ),
      );
    }
    const notFound = data.not_found;
    if (Array.isArray(notFound) && notFound.length) {
      lines.push('', `未找到（${notFound.length}）：${notFound.slice(0, 30).join(', ')}${notFound.length > 30 ? ' …' : ''}`);
    }

    return result(lines.join('\n'), res, data);
  },
};

// ── 2026-10-29 新增：跨物种同源 / VariantHub 目录 / VariantHub 区间查询 ──────
//
// 三者的上游证据与契约见 `记录/20261029-WheatOmics三工具契约.md`。
// 两条贯穿始终的纪律：
//   1. **0 条 ≠ 不存在**。WheatOmics 的 VariantHub 里，`genome_concordant=false`
//      的数据集（本批 29 个中 2 个）坐标与参考基因组不一致；查这类数据集时
//      0 条不能解读为"没有变异"。**为什么返回 0，本仓未查明，不做推断**——
//      早先写的"本应有数据却返回 0 条"是基于仿造数据的推断，已撤回。
//      所以空结果只能表述为"该数据集在该区间返回 0 条"，不能断言"没有变异"。
//   2. **端点语义已证实为闭区间，但不写基数命名**。五次边界实验证明
//      `start <= pos <= end`（④⑤ 两次证伪半开解释）；`start==end` 被上游 400 拒绝，
//      是上游对该形态的校验行为，本仓在**本地拒绝**并提示改用区间查询。从 `pos=168831` 反推 1-based/0-based
//      没有依据，因此描述里两者都不写。

/** 正文预算：与 Gramene 一致的留白策略，给尾部计数行留位置。 */
const HOMOLOG_BODY_BUDGET = MAX_BODY_BYTES - 160;
/**
 * **变异数据集目录**的正文预算：`MAX_BODY_BYTES - 200`。
 *
 * 这 200 B 保护的是**表格后另拼的省略句**（"表中仅列 N 个，共 M 个；用 keyword 缩小范围"）——
 * 目录工具是"先排表、后拼 tail"的形态，不留位就会在正文顶满时被裁。
 * 不是给出处尾注（尾注由 `core/request.ts` 按整包 4096 B 另留，不与 1408 相减）。
 * 凡"后拼省略句"的调用点都必须留位；曾误把这个常量放大到 1408，见 `9f488c4`。
 */
const VARIANT_CATALOG_BODY_BUDGET = MAX_BODY_BYTES - 200;

/** 仅 `variant_query` 使用：缺口句已进 `fitTable` 试排，正文可用满 1408 B（表格让位）。 */
const VARIANT_QUERY_BODY_BUDGET = MAX_BODY_BYTES;

/** 同源结果的物种展示顺序：实测返回 Rice + Arabidopsis，其余物种原样追加。 */
const SPECIES_ORDER = ['Rice', 'Arabidopsis'];

function optNumber(data: Record<string, unknown>, key: string, url: string, what: string): number | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UpstreamShapeError(`${what} 的 ${key} 不是有限数字（实际 ${typeof value}）——上游契约可能已变`, { url });
  }
  return value;
}

/**
 * **必须有**的非负整数计数（审查 WHT3-01）。
 *
 * 教训：原来用 `optNumber` 读 `count` / `total` / `total_shown`，缺字段时得到 `undefined`，
 * 而空数组分支又会打印「上游明确 count=0」——**这个 0 是我们自己编的，不是上游给的**。
 * 上游删掉计数字段、数组里塞了 `null`，都会被静默报成"合法查无"。
 *
 * 现在：计数字段缺失或不是非负整数 → 结构漂移。想报"0 条"，必须真的读到 `0`。
 */
function requireCount(data: Record<string, unknown>, key: string, url: string, what: string): number {
  const value = data[key];
  if (value === undefined) {
    throw new UpstreamShapeError(
      `${what} 响应里没有 \`${key}\` 字段——无法确认本次是否真的返回 0 条；这不等于"没有结果"`,
      { url, bodySnippet: `keys=${Object.keys(data).slice(0, 12).join(',')}` },
    );
  }
  if (value === null) {
    throw new UpstreamShapeError(`${what} 的 \`${key}\` 是 null——无法确认返回条数，不当成 0`, { url });
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new UpstreamShapeError(`${what} 的 \`${key}\` 不是非负整数（实际 ${String(value)}）——上游契约可能已变`, { url });
  }
  return value;
}

/**
 * 严格取对象数组（审查 WHT3-01）。
 *
 * 不能用公共 `objectsOf()`：它会把 `null` 之类的元素**静默过滤掉**，
 * 于是 `records=[null]` 会被当成空数组，进而被报成"本次 0 条"。
 * 元素不是对象就是结构漂移，必须抛。
 */
function strictObjects(rows: unknown[], url: string, what: string): Array<Record<string, unknown>> {
  return rows.map((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new UpstreamShapeError(
        `${what} 第 ${index + 1} 个元素不是对象（实际 ${row === null ? 'null' : Array.isArray(row) ? '数组' : typeof row}）`
        + '——上游契约可能已变；不能把它当成"没有结果"',
        { url },
      );
    }
    return row as Record<string, unknown>;
  });
}

/**
 * 逐行试排，只统计**真正进了正文**的行数。
 *
 * 这是 Gramene 那轮 `shown=-1` 的教训：整表放不进正文时不能把"未展示"算成负一行，
 * 尾部"另有 N 条"必须是 `rows.length - shown`。
 *
 * 审查 WHT3-04 追加：头部必须由 `shown` **算出来**，不能在试排前就先写死"展示 N 条"。
 * 所以 `headLines` 收的是函数而不是字符串——否则首行说 20 条、表格 8 行、尾行又说 8 条。
 */
function fitTable(
  headLines: (shown: number) => string[],
  columns: string[],
  rows: unknown[][],
  url: string,
  budget: number,
  maxCell: number,
): { body: string; shown: number } {
  const emptyHead = headLines(0).join('\n');
  if (utf8Bytes(emptyHead) > budget) {
    throw new UpstreamShapeError('摘要头部已超出正文预算，无法在不失真的前提下展示', { url });
  }
  let best = { body: emptyHead, shown: 0 };
  for (let count = 1; count <= rows.length; count += 1) {
    const head = headLines(count).join('\n');
    const candidate = `${head}\n${renderTable(columns, rows.slice(0, count), { maxRows: count, maxCell })}`;
    if (utf8Bytes(candidate) > budget) break;
    best = { body: candidate, shown: count };
  }
  return best;
}

const crossSpeciesHomologs: ToolDefinition = {
  name: 'wheatomics_cross_species_homologs',
  description:
    '把一个小麦基因映射到其他物种的同源基因（BLAST 比对结果，含 identity、覆盖度、E 值、得分），用于跨物种功能推断。'
    + '当用户问「这个小麦基因在水稻/拟南芥里对应哪个基因」时用。'
    + '**覆盖范围只有水稻与拟南芥**——实测返回的 species 是 Rice 与 Arabidopsis，不是全部物种，也不代表全部禾本科。'
    + '注意：上游没有给出直系同源/旁系同源的分类字段，本工具**不区分 ortholog 与 paralog**，只报同源命中；'
    + 'max_targets 是**每个物种**的返回上限，不是总条数。'
    + '查无返回"本次返回 0 条"，不代表该基因不存在。',
  parameters: {
    type: 'object',
    properties: {
      gene_id: {
        type: 'string',
        description: '小麦基因 ID，例如 TraesCS5A02G391700（只接受单个 ID；不做格式猜测，上游对不存在的 ID 返回合法空结果）',
      },
      max_targets: {
        type: 'integer',
        description: '每个物种最多返回几个同源基因（1–100，默认 3）。是**每物种**上限，不是总数',
        default: 3,
        minimum: 1,
        maximum: 100,
      },
    },
    required: ['gene_id'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const geneId = requireStringArg(args, 'gene_id', 200);
    const maxTargets = optionalIntArg(args, 'max_targets', 3, 1, 100);

    const url = endpoint('/homologs/wheat-rice-arabidopsis', { gene_id: geneId, max_targets: maxTargets });
    const { res, result } = await query(ctx, url, { max_targets: maxTargets });
    const data = unwrap<Record<string, unknown>>(res.data, url);

    // 身份对账：返回的 query_gene 必须就是请求的那个基因，否则拒绝展示。
    const echoed = data.query_gene;
    if (typeof echoed !== 'string' || echoed.trim() === '') {
      throw new UpstreamShapeError('同源响应缺少 query_gene，无法确认这是本次请求的结果——上游契约可能已变', { url });
    }
    if (echoed.trim() !== geneId) {
      throw new UpstreamShapeError(
        `返回的 query_gene（${echoed.trim()}）与请求的 gene_id（${geneId}）不一致——身份不符，拒绝把无关记录当同源结果；请检查 ID 大小写与形式`,
        { url },
      );
    }

    const hits = strictObjects(requireArrayField(data, 'hits', url, '同源查询'), url, '同源查询 hits');
    // 计数必须真实存在（审查 WHT3-01）：缺 count 时不许自己编一个 0。
    const declared = requireCount(data, 'count', url, '同源查询');
    if (declared !== hits.length) {
      throw new UpstreamShapeError(
        `上游自相矛盾：count=${declared} 但 hits 实际 ${hits.length} 条——不挑一个当真值`,
        { url },
      );
    }

    /**
     * 逐条身份对账（审查 WHT3-02）。
     *
     * 原来只查顶层 `query_gene`。缓存混包或上游串号时，顶层可能是对的、单条却是别的基因，
     * 那种记录会被当成"本次请求的同源结果"展示，而完整 GET 出处反而替错误归属背书。
     */
    const mismatched = hits
      .map((hit, index) => ({ index, echoed: hit.query_gene }))
      .filter(({ echoed }) => echoed !== undefined && echoed !== null && String(echoed).trim() !== geneId)
      .map(({ index, echoed }) => `第 ${index + 1} 条 query_gene=${String(echoed).trim()}`);
    if (mismatched.length > 0) {
      throw new UpstreamShapeError(
        `单条命中记录的 query_gene 与请求的 gene_id（${geneId}）不一致：${mismatched.slice(0, 3).join('、')}`
        + '——身份不符，拒绝把无关基因的同源记录当成结果；请检查 ID 大小写与形式',
        { url },
      );
    }

    if (hits.length === 0) {
      return result(
        `「${geneId}」本次返回 0 条同源基因（上游 count=0）。\n`
        + '说明：本工具只覆盖水稻与拟南芥两个物种；0 条只表示本次比对无命中，不代表该基因不存在或没有同源基因。',
        res,
        // 空结果也走白名单（审查 WHT3-03）：不能因为"没记录"就把整包 data 原样带出去。
        { query_gene: geneId, count: declared, hits: [] },
        'count=0',
      );
    }

    // 按物种分组，实测物种优先，其余原样追加（不为未测物种编造名字）。
    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const hit of hits) {
      const species = str(hit.species) ?? '(上游未给物种)';
      const bucket = grouped.get(species);
      if (bucket) bucket.push(hit);
      else grouped.set(species, [hit]);
    }
    const ordered = [...grouped.keys()].sort((a, b) => {
      const ai = SPECIES_ORDER.indexOf(a);
      const bi = SPECIES_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });

    const counts = ordered.map((species) => `${species} ${grouped.get(species)!.length}`).join('、');

    const rows = hits.map((hit) => [
      hit.species,
      hit.target_gene,
      hit.gene_name,
      Number.isFinite(toNum(hit.identity)) ? `${num(hit.identity, 2)}%` : '-',
      Number.isFinite(toNum(hit.qcovs)) ? `${num(hit.qcovs, 1)}%` : '-',
      hit.evalue,
      hit.score,
    ]);

    // 头部由 shown 算出来（审查 WHT3-04）：先写死"展示 N 条"会和表格实际行数冲突。
    const { body, shown } = fitTable(
      (shownCount) => [
        `「${geneId}」命中 ${hits.length} 条同源基因（${counts}）｜max_targets=${maxTargets} 是**每物种**上限`
        + (shownCount < hits.length ? `｜本次正文展示 ${shownCount} 条` : ''),
        '注：不区分直系/旁系同源（上游无该字段）；覆盖范围仅水稻与拟南芥。',
      ],
      ['物种', '同源基因', '基因名', 'identity', '覆盖度', 'E 值', '得分'],
      rows,
      url,
      HOMOLOG_BODY_BUDGET,
      60,
    );
    const tail = shown < rows.length ? `\n（本次正文展示 ${shown} 条，另有 ${rows.length - shown} 条未展示；可减小 max_targets 或按物种分开查询）` : '';
    return result(`${body}${tail}`, res, {
      query_gene: geneId,
      count: declared,
      hits: hits.map((hit) => ({
        target_gene: hit.target_gene,
        gene_name: hit.gene_name,
        species: hit.species,
        identity: hit.identity,
        qcovs: hit.qcovs,
        evalue: hit.evalue,
        score: hit.score,
      })),
    }, `count=${hits.length}`);
  },
};

const variantDatasets: ToolDefinition = {
  name: 'wheatomics_variant_datasets',
  description:
    '列出 WheatOmics VariantHub 收录的小麦变异数据集（参考基因组 + dataset key），共 29 个数据集、3 个参考基因组。'
    + '当用户想查某个区间的 SNP/InDel 时，**先用它拿到 dataset key**，再调 wheatomics_variant_query。'
    + '**注意 genome_concordant 字段**：它标示该数据集的坐标是否与所选参考基因组一致；实测 29 个数据集里 27 个为 true、'
    + '2 个为 false（`WEC_filtered_SNPs`、`WEC_filtered_INDELs`）。选非一致数据集时，0 条结果不能解读为该区间没有变异——'
    + '**但"为什么返回 0"本仓未查明，不做推断**。优先选 genome_concordant=true 的数据集。',
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '可选，**本地**按 dataset key / label / source 做不区分大小写的子串过滤（不发给上游），例如 exome、GBS、Kronos',
      },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const keyword = optionalStringArg(args, 'keyword', 100);
    const url = endpoint('/VariantHub/datasets');
    const { res, result } = await query(ctx, url, { keyword: keyword ?? null });
    const data = unwrap<Record<string, unknown>>(res.data, url);

    const references = strictObjects(requireArrayField(data, 'references', url, '变异数据集目录'), url, '变异数据集目录 references');
    if (references.length === 0) {
      // 空结果也走白名单（审查 WHT3-03），不带整包原始 data。
      return result('上游返回 0 个参考基因组（不是解析失败）。', res, { references: [] }, 'references=0');
    }

    interface Row {
      reference: string;
      key: string;
      label: string;
      source: string;
      concordant: boolean | undefined;
      hasSampleMeta: boolean | undefined;
    }

    const all: Row[] = [];
    for (const reference of references) {
      /**
       * 真实响应的字段名是 `name`（不是 `reference`）。
       *
       * 2026-10-29 用真实抓取比对时才发现：合成 fixture 里我写的是 `reference`，
       * 而实现优先读 `reference`、回退到 `display`，于是永远拿不到 `name`——
       * 显示成 "Chinese Spring (IWGSCv1.0)" 这类 display 而非稳定标识。
       * 三个键都试，都缺就是结构漂移（不许用占位符顶上去）。
       */
      const refId = str(reference.name) ?? str(reference.reference) ?? str(reference.display);
      if (!refId) {
        throw new UpstreamShapeError(
          '参考基因组条目缺少 name / reference / display 三个标识字段——上游契约可能已变，不猜归属',
          { url },
        );
      }
      const list = reference.datasets;
      if (!Array.isArray(list)) {
        throw new UpstreamShapeError(
          `参考基因组 ${refId} 的 datasets 不是数组（实际 ${typeof list}）——上游契约可能已变；`
          + '本仓只实测过"数组形式"，不猜其他嵌套形态',
          { url },
        );
      }
      for (const raw of list) {
        // 元素必须是对象：纯字符串 key 尽管可能出现，但本仓**未实测过**该形态，
        // 猜它等于 key 会把结构漂移当成正常数据（审查 WHT3-01 同类问题）。
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new UpstreamShapeError(
            `参考基因组 ${refId} 的 datasets 里有非对象元素（实际 ${raw === null ? 'null' : Array.isArray(raw) ? '数组' : typeof raw}）`
            + '——上游契约可能已变，本仓未实测该形态，不猜',
            { url },
          );
        }
        const item = raw as Record<string, unknown>;
        const key = str(item.key);
        if (!key) {
          throw new UpstreamShapeError(`参考基因组 ${refId} 下有数据集缺少 key 字段——上游契约可能已变`, { url });
        }
        all.push({
          reference: refId,
          key,
          label: str(item.label) ?? '-',
          source: str(item.source) ?? '-',
          concordant: typeof item.genome_concordant === 'boolean' ? item.genome_concordant : undefined,
          hasSampleMeta: typeof item.has_sample_meta === 'boolean' ? item.has_sample_meta : undefined,
        });
      }
    }

    // 同一 dataset key 出现在两个参考基因组下 = 上游归属矛盾，不猜谁对。
    const seenKeys = new Map<string, string>();
    for (const row of all) {
      const previous = seenKeys.get(row.key);
      if (previous !== undefined && previous !== row.reference) {
        throw new UpstreamShapeError(
          `数据集 key「${row.key}」同时出现在 ${previous} 与 ${row.reference} 两个参考基因组下——上游归属自相矛盾，不挑一个当真`,
          { url },
        );
      }
      seenKeys.set(row.key, row.reference);
    }

    const needle = keyword?.toLowerCase();
    const kept = needle
      ? all.filter((row) => [row.key, row.label, row.source, row.reference].some((field) => field.toLowerCase().includes(needle)))
      : all;

    const concordantCount = all.filter((row) => row.concordant === true).length;
    const unknownCount = all.filter((row) => row.concordant === undefined).length;
    const recommended = all.filter((row) => row.concordant === true).map((row) => row.key);
    const head = [
      `共 ${references.length} 个参考基因组、${all.length} 个变异数据集；`
      + `其中 genome_concordant=true 的 ${concordantCount} 个${unknownCount > 0 ? `，字段缺失 ${unknownCount} 个` : ''}。`,
      // 推荐 key 单独一行：29 个数据集放不进正文时表格会被截断，
      // 若把"该用哪个"只放在表格里，用户拿到的恰恰可能是被截掉的那几个。
      recommended.length > 0
        ? `建议优先使用（genome_concordant=true）：${recommended.slice(0, 10).join('、')}${recommended.length > 10 ? ` 等 ${recommended.length} 个` : ''}`
        : '本批响应里没有 genome_concordant=true 的数据集——查询前请谨慎解读 0 条结果。',
      keyword ? `本地关键词「${keyword}」命中 ${kept.length} 个（该过滤不发给上游）。` : '',
      '⚠️ genome_concordant=false 的数据集（本批 2 个）坐标与所选参考基因组不一致；查这类数据集时，0 条不能解读为该区间没有变异——为什么返回 0 本仓未查明，不做推断。',
    ].filter(Boolean);

    const rows = kept.map((row) => [
      row.reference,
      row.key,
      row.label,
      row.concordant === undefined ? '未知' : String(row.concordant),
      row.hasSampleMeta === undefined ? '未知' : row.hasSampleMeta ? '有' : '无',
    ]);

    if (rows.length === 0) {
      return result(
        `${head.join('\n')}\n\n本次没有匹配的数据集（本地过滤结果为空；可去掉 keyword 看全部）。`,
        res,
        { total: all.length },
        `datasets=${all.length}`,
      );
    }

    const { body, shown } = fitTable(
      () => head,
      ['参考基因组', 'dataset key', 'label', 'genome_concordant', '样本元数据'],
      rows,
      url,
      // 目录工具的省略句仍在 fitTable 之后后拼，必须留位（不用 variant_query 那个吃满预算的常量）
      VARIANT_CATALOG_BODY_BUDGET,
      48,
    );
    const tail = shown < rows.length ? `\n（表中仅列 ${shown} 个，共 ${rows.length} 个；用 keyword 缩小范围）` : '';
    const out = result(`${body}${tail}`, res, {
      references: references.length,
      total: all.length,
      concordant: concordantCount,
      datasets: all.map((row) => ({
        reference: row.reference,
        key: row.key,
        label: row.label,
        genome_concordant: row.concordant,
        has_sample_meta: row.hasSampleMeta,
      })),
    }, `datasets=${all.length}`);
    /**
     * 后拼省略句的**最终文本**守卫（2026-10-30，按审查意见加强）。
     *
     * 目录工具是"先排表、后拼 tail"的形态：正文顶满预算时，`tail` 会被 `finishResult` 裁掉。
     * 只检查 `body + tail` 不够——真正给用户看的是 `out.text`，所以这里断言的是**最终文本**：
     *   ① 省略句完整出现在 `out.text`（被裁即抛错）；
     *   ② 省略句里的数字与表格实际行数一致（不许"报的数"和"给的数"不同）；
     *   ③ 整包 ≤ 4096 B、出处仍完整。
     */
    if (tail) {
      const sentence = `（表中仅列 ${shown} 个，共 ${rows.length} 个；用 keyword 缩小范围）`;
      const renderedRows = out.text.split('\n').filter((line) => line.trim().startsWith('|')).length - 2;
      if (!out.text.includes(sentence) || renderedRows !== shown) {
        throw new UpstreamShapeError(
          `数据集目录的省略句未完整出现在最终正文（渲染 ${renderedRows} 行 / 报告 ${shown} 行）`
          + '——被预算裁掉就等于没告诉用户"还有更多"，拒绝输出',
          { url },
        );
      }
    }
    if (utf8Bytes(out.text) > 4096) {
      throw new UpstreamShapeError(`数据集目录整包 ${utf8Bytes(out.text)} B 超 4096 B 上限`, { url });
    }
    return out;
  },
};

/**
 * 区间参数：`chrom:start-end`。
 *
 * **语义（2026-10-29 五次边界实验证实）**：`start` 与 `end` 都包含，即闭区间 `start <= pos <= end`。
 * 半开解释被第④（`168830-168831` 命中 168831）与第⑤（`168829-168831` 命中 168831）两次证伪。
 *
 * **不写"1-based"或"0-based"**：实验能证明的只有端点包含性；从 `pos=168831` 反推基数命名没有依据，
 * 也不需要反推。此前描述里的"1-based"是产品口径而非实测结论，已删除。
 *
 * **单点输入**（`start === end`）：上游校验式写成 `length = end − start`，于是合法的 1 bp 区间被判
 * `Region length must be > 0` 并返回 **400**。这是上游对该形态的校验行为。
 *
 * 本仓的处理是**本地拒绝**（`InvalidArgumentError`，零请求），并提示改用 `pos-1..pos+1`。
 * 理由：扩窗会把相邻位点带回来，需要额外过滤、还要向用户解释"实际请求范围与你的输入不同"，
 * 失败模式更复杂；本地拒绝行为单一、可验证，也不会让用户把 400 误读成"该位点没有变异"。
 */
interface Region {
  /** 用户原始输入，用于回显 */
  text: string;
  chrom: string;
  /** 用户请求的闭区间两端（都包含） */
  start: number;
  end: number;
}

function regionArg(raw: unknown): Region {
  if (typeof raw !== 'string') {
    throw new InvalidArgumentError('参数 region 必须是字符串，格式为 chrom:start-end（例如 chr1A:1-200000）');
  }
  if (raw !== raw.trim()) {
    throw new InvalidArgumentError('参数 region 首尾含空白；本仓不改写输入，请去掉空白后重试（尚未联网）');
  }
  if (/[\u0000-\u001F\u007F]/.test(raw)) {
    throw new InvalidArgumentError('参数 region 含控制字符（换行/制表符等）；尚未联网');
  }
  if ([...raw].length > 100) {
    throw new InvalidArgumentError(`参数 region 过长（${[...raw].length} 字符，上限 100）`);
  }
  const match = /^([^:\s]{1,40}):(\d{1,12})-(\d{1,12})$/.exec(raw);
  if (!match) {
    throw new InvalidArgumentError('参数 region 格式必须为 chrom:start-end（单个字符串参数，不是 chrom/start/end 三个参数），例如 chr1A:1-200000');
  }
  const chrom = match[1]!;
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new InvalidArgumentError('参数 region 的坐标必须是安全整数');
  }
  if (start < 1) throw new InvalidArgumentError('参数 region 的起点必须 ≥ 1（0 或负数在本地拒绝）');
  if (start > end) throw new InvalidArgumentError(`参数 region 的起点 ${start} 大于终点 ${end}`);

  if (start === end) {
    // 单点：本地拒绝，零请求。上游对 `length = end − start` 的等端点会直接 400，
    // 放行只会把 400 透传给用户，还容易被误读成"该位点没有变异"。
    throw new InvalidArgumentError(
      `参数 region 的起点与终点相同（${start}）——上游会以 400 拒绝这种等端点区间，`
      + `这不是"该位点没有变异"；请改用区间查询，例如 ${chrom}:${Math.max(1, start - 1)}-${start + 1}`,
    );
  }
  return { text: raw, chrom, start, end };
}

const variantQuery: ToolDefinition = {
  name: 'wheatomics_variant_query',
  description:
    '查 WheatOmics VariantHub 里某个数据集、某个染色体区间的变异记录（SNP/InDel），返回位点、ID、ref/alt、质量、过滤标记与 VEP 注释摘要。'
    + '当用户问「chr1A 上 1–200kb 有哪些变异」「这个区间有没有 SNP」时用。'
    + '**region 是单个字符串参数**，格式 chrom:start-end（如 chr1A:1-200000），不是三个参数。'
    + '区间为**闭区间，两端都含**（start 与 end 都包含）——这是**端点包含性的实测结论，不涉及 1-based / 0-based 的命名**。'
    + '**起点与终点不能相同**：上游会以 400 拒绝这种等端点区间，本仓在本地先拒（不是"该位点没有变异"）；查单位点请给 pos-1-pos+1。'
    + '**0 条不等于该区间没有变异**：数据集与坐标体系可能不匹配，请先用 wheatomics_variant_datasets 确认 genome_concordant=true。'
    + '**区间参数非法会被上游以 400 拒绝，那不是"没有变异"**，本仓在本地先做该校验。'
    + '**本仓不暴露按变异 ID 查询**：上游该路径是全表扫描（实测约 19 s，超出本仓上游超时预算），能力面差异归本仓、不是上游缺陷；本工具只按区间查。'
    + '**本仓不提供 offset**：上游支持分页，本仓未暴露分页参数；上游标记"还有更多"时请缩小 region 后重查，不要指望翻页。',
    parameters: {
      type: 'object',
      properties: {
        dataset: {
          type: 'string',
          description: '数据集 key（来自 wheatomics_variant_datasets 的 dataset key 列），不是显示名，例如 whealbi_minocc10',
        },
        region: {
          type: 'string',
          description: '染色体区间，单个字符串 chrom:start-end，闭区间两端都含（start 与 end 都包含；这是端点包含性实测，不涉及 1-based/0-based 命名），例如 chr1A:1-200000。起点与终点不能相同（上游会返回 400）；查单位点请给 pos-1-pos+1。**本工具只支持按区间查**（未暴露 offset，也不按变异 ID 查）',
        },
      limit: {
        type: 'integer',
        description: '本次最多取回多少条（1–100，默认 20）。**入参范围与已发布契约一致，本仓不收缩**；体积由**输出侧预算统一裁剪**（不在这里承诺具体字节数），被裁时正文分层报「命中 / 本次取回 / 正文展示 / 本页另有未展示 / 另有未取回」，并给出缩小区间或减小 limit 的重查指引',
        default: 20,
        minimum: 1,
        maximum: 100,
      },
    },
    required: ['dataset', 'region'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const dataset = requireStringArg(args, 'dataset', 100);
    const region = regionArg(args.region);
    const limit = optionalIntArg(args, 'limit', 20, 1, 100);

    // 区间按用户输入原样发送；等端点已在解析阶段本地拒绝，不会走到这里
    const url = endpoint('/VariantHub/query', { dataset, region: region.text, limit });
    const { res, result } = await query(ctx, url, { limit });
    const data = unwrap<Record<string, unknown>>(res.data, url);

    const records = strictObjects(requireArrayField(data, 'records', url, '变异区间查询'), url, '变异区间查询 records');

    /**
     * 数据集身份对账（审查 WHT3-02）。
     *
     * 原来只核对坐标。若上游返回了另一个数据集的记录（缓存混包/串号），
     * 坐标照样落在请求区间内，于是整包结果被当成 `dataset=whealbi_minocc10` 展示。
     * 上游确实给了 `data.dataset`，就必须拿它核对；判不了就报错，不猜别名。
     */
    const echoedDataset = data.dataset;
    if (typeof echoedDataset !== 'string' || echoedDataset.trim() === '') {
      throw new UpstreamShapeError(
        '变异响应缺少 dataset 字段，无法确认返回的是否为所请求的数据集——上游契约可能已变',
        { url },
      );
    }
    if (echoedDataset.trim() !== dataset) {
      throw new UpstreamShapeError(
        `返回的 dataset（${echoedDataset.trim()}）与请求的 dataset（${dataset}）不一致——身份不符，`
        + '拒绝把其他数据集的记录当成本次结果；请用 wheatomics_variant_datasets 核对 key',
        { url },
      );
    }

    // 区间回显：给了就核对，必须与用户请求的区间一致。
    const echoedRegion = data.region;
    if (echoedRegion !== undefined && echoedRegion !== null) {
      if (typeof echoedRegion !== 'string') {
        throw new UpstreamShapeError(`变异响应的 region 字段不是字符串（实际 ${typeof echoedRegion}）`, { url });
      }
      if (echoedRegion.trim() !== region.text) {
        throw new UpstreamShapeError(
          `返回的 region（${echoedRegion.trim()}）与请求的 region（${region.text}）不一致——身份不符`,
          { url },
        );
      }
    }

    // 计数必须真实存在（审查 WHT3-01）：缺 total 时不许把尾注写成 total=0。
    const total = requireCount(data, 'total', url, '变异区间查询');
    const totalShown = requireCount(data, 'total_shown', url, '变异区间查询');
    const hasMore = data.has_more;
    const nSamples = optNumber(data, 'n_samples', url, '变异区间查询');

    // 上游三个计数必须自洽；互相矛盾时抛错，不挑一个当真值。
    if (records.length > 0 && totalShown !== records.length) {
      throw new UpstreamShapeError(
        `上游自相矛盾：total_shown=${totalShown} 但 records 实际 ${records.length} 条——不挑一个当真值`,
        { url },
      );
    }
    if (totalShown > total) {
      throw new UpstreamShapeError(`上游自相矛盾：total_shown=${totalShown} 大于 total=${total}`, { url });
    }
    if (records.length === 0 && total > 0) {
      throw new UpstreamShapeError(
        `上游自相矛盾：total=${total} 但 records 为空——这可能不是"没有结果"，拒绝当成空结果返回`,
        { url },
      );
    }

    const summaryHead = (shownCount: number): string => (
      `dataset=${dataset}｜区间 ${region.text}｜`
      + (nSamples !== undefined ? `n_samples=${nSamples}｜` : '')
      // 三个计数必须分开：命中（上游判定）/ 本次取回（本页）/ 正文展示（真正进了正文的行）
      + `命中 ${total} 条；本次取回 ${records.length} 条；正文展示 ${shownCount} 条`
      + (hasMore === true ? '｜上游标记还有更多（has_more=true，本仓未暴露 offset）' : '')
    );

    if (records.length === 0) {
      /**
       * 空结果也必须自洽（2026-10-30 审查复现）：`has_more=true` 却说"这次一条都没有"，
       * 是上游自己矛盾。此前只有非空分支查这一条，空分支直接当成功返回——
       * 那会让用户看到"0 条"，却不知道上游声称还有更多。
       */
      if (hasMore === true) {
        throw new UpstreamShapeError(
          `上游自相矛盾：records 为空（total=${total}、total_shown=${totalShown}）却标记 has_more=true`
          + '——不猜"还有多少"，也不当作空结果返回',
          { url },
        );
      }
      return result(
        `${summaryHead(0)}\n\n该数据集在该区间返回 0 条记录（上游 total=0、records 为空）。\n`
        + '⚠️ 0 条不等于该区间没有变异。若所用数据集 genome_concordant=false（坐标与参考基因组不一致），更不能据此判断无变异；'
        + '请先用 wheatomics_variant_datasets 确认数据集一致性，或换一个 genome_concordant=true 的数据集再查。',
        res,
        // 空结果也走白名单（审查 WHT3-03）：绝不把整包 data（含 samples/genotypes/info_raw）带进 raw。
        { dataset, region: region.text, n_samples: nSamples, total, total_shown: totalShown, has_more: hasMore, records: [] },
        'total=0',
      );
    }

    /**
     * 身份对账：记录必须落在**用户请求的闭区间**内。
     *
     * 单点输入（`start === end`）已在解析阶段本地拒绝，实际请求区间恒等于用户输入，
     * 因此这里比对的就是用户给的那段区间，不存在"请求区间与用户输入不同"的情形。
     * 逐条核对染色体与坐标：区间外或染色体不符的记录属于身份不符，直接报错，不把无关位点当结果。
     *
     * 端点包含性已由五次实验证实为闭区间（`start <= pos <= end`）。
     */
    const wantedChrom = region.chrom.toLowerCase();
    const outside: string[] = [];
    const kept: Array<Record<string, unknown>> = [];
    for (const record of records) {
      const chrom = str(record.chrom);
      const pos = toNum(record.pos);
      if (chrom === undefined || !Number.isFinite(pos)) {
        throw new UpstreamShapeError('变异记录缺少 chrom 或 pos，无法核对是否属于本次请求区间——上游契约可能已变', { url });
      }
      if (chrom.toLowerCase() !== wantedChrom) {
        outside.push(`${chrom}（染色体不符）`);
        continue;
      }
      if (pos < region.start || pos > region.end) {
        outside.push(`${chrom}:${pos}`);
        continue;
      }
      kept.push(record);
    }
    if (outside.length > 0) {
      throw new UpstreamShapeError(
        `返回了请求区间之外的记录：${outside.slice(0, 3).join('、')}——身份不符，拒绝把无关记录当结果；`
        + '请检查染色体命名与区间端点',
        { url },
      );
    }

    /**
     * 从 VEP `info.ANN` 提取 consequence / impact / gene。
     *
     * ⚠️ 字段顺序（0-based，按 VEP 标准 ANN 规范，上游原文形如
     * `T|downstream_gene_variant|MODIFIER|TraesCS1A02G000700|TraesCS1A02G000700.1|protein_coding|4/5`）：
     *   0 Allele ｜ 1 Consequence ｜ 2 IMPACT ｜ 3 SYMBOL ｜ 4 Gene ｜ 5 Feature_type ｜ 6 Feature
     *
     * 原来写成取 `parts[0..2]`，实际拿到的是「等位基因|consequence|impact」——**基因 ID 被整个丢掉**，
     * 且因为等位基因位存在，错位看起来像是正常的 `effect|impact|gene` 三段。这是最危险的一类错：
     * 输出格式没坏、只是每一列都错了一格。已由调研者的字段核对暴露。
     */
    const annOf = (record: Record<string, unknown>): string => {
      const info = record.info;
      if (!info || typeof info !== 'object' || Array.isArray(info)) return '-';
      const ann = (info as Record<string, unknown>).ANN;
      if (typeof ann !== 'string' || !ann.trim()) return '-';
      const first = ann.split(',')[0] ?? '';
      const parts = first.split('|');
      // 少于 5 段时无法可靠定位 Gene 位；宁可显式报缺失，也不按错位的下标硬取。
      if (parts.length < 5) {
        throw new UpstreamShapeError(
          `info.ANN 的字段数只有 ${parts.length} 段，少于 VEP 标准的前 5 段（Allele|Consequence|IMPACT|SYMBOL|Gene）——`
          + '无法可靠提取基因，拒绝按错位下标硬取',
          { url },
        );
      }
      const consequence = parts[1] ?? '';
      const symbol = parts[3] ?? '';
      const gene = parts[4] ?? '';
      // SYMBOL 与 Gene 常常相同，相同时不重复打印。
      const geneLabel = gene && symbol && gene !== symbol ? `${gene}(${symbol})` : gene || symbol;
      // 契约要求「基因 ID 与 consequence」；impact 不进正文（单元格 46 字符预算放不下三段）。
      const picked = [consequence, geneLabel].filter(Boolean).join(' / ');
      return picked || '-';
    };

    /**
     * 点号占位不是空值。
     *
     * 上游实测 `qual="."`（`filter="PASS"`）。VCF 里 `.` 表示"未计算/无值"，不是 0、也不是缺失字段。
     * 直接打印成 `-` 会让人以为我们没取到，直接打印 `.` 又容易被忽略，所以显式标注。
     */
    const qualOf = (value: unknown): string => {
      if (value === null || value === undefined || value === '') return '(未给)';
      const text = String(value).trim();
      if (text === '.') return '.(未计算)';
      return text;
    };

    const filterOf = (value: unknown): string => {
      if (value === null || value === undefined || value === '') return '(未给)';
      const text = String(value).trim();
      return text === '.' ? '.(未给过滤标记)' : text;
    };

    const rows = kept.map((record) => [
      `${str(record.chrom) ?? '?'}:${record.pos ?? '?'}`,
      record.id,
      `${str(record.ref) ?? '?'}>${str(record.alt) ?? '?'}`,
      qualOf(record.qual),
      filterOf(record.filter),
      annOf(record),
    ]);

    /**
     * 计数有**两个不同的缺口**，禁止合并成一句「另有 N 条」（WHT-01，负责人 2026-10-30 定口径）：
     *
     *   缺口一「本页内未展示」= 本次取回 − 正文展示 → 动作：减小 limit 让本页放得下，或缩小区间；
     *   缺口二「未取回」      = 命中总数 − 本次取回 → 动作：调大 limit（≤100），仍不够只能缩小区间。
     *
     * 合并报的后果是真实的：`total=427 / 本页 50 / 展示 6` 时报「另有 44 条」，
     * 用户以为快看完了，实际还剩 421 条——**少报 377**。
     *
     * **缺口文案必须参与字节预算**（2026-10-30 审查复现）：原来它拼在 `fitTable` 之后，
     * 正文一顶到预算就被裁掉，用户看不到"还有 N 条没取回"这句——报数再准也没送到。
     * 所以它进 headLines，由 fitTable 逐行试排时算进去。
     */
    const pageRecords = rows.length;
    const notFetchedTotal = total - pageRecords;
    const limitAtCap = limit >= 100;

    const gapText = (shownCount: number): string => {
      const parts: string[] = [];
      const omittedHere = pageRecords - shownCount;
      if (omittedHere > 0) {
        parts.push(`本页另有 ${omittedHere} 条未展示——可减小 limit 让本页放得下，或缩小区间后重查`);
      }
      if (notFetchedTotal > 0) {
        parts.push(limitAtCap
          ? `另有 ${notFetchedTotal} 条未取回（limit 已到本仓上限 100，本仓不分页）——请缩小区间后重查`
          : `另有 ${notFetchedTotal} 条未取回（本仓不分页）——可调大 limit（本仓上限 100）或缩小区间后重查`);
      }
      return parts.length ? `（${parts.join('；')}）` : '';
    };

    const { body, shown } = fitTable(
      (shownCount) => {
        const gap = gapText(shownCount);
        return [
          summaryHead(shownCount),
          // 只写已证实的端点包含性，不写 1-based/0-based（基数命名无法从数据反推）
          '注：区间为闭区间，两端都含（端点包含性实测，不涉及 1-based/0-based 命名）；`0 条` 与「无变异」不是一回事。'
          + '每条只给位点与注释摘要，不含逐样本基因型。',
          ...(gap ? [gap] : []),
        ];
      },
      ['位点', '变异 ID', 'ref>alt', 'qual', 'filter', 'VEP 注释'],
      rows,
      url,
      // 只有这一个调用点用满 1408：缺口句已进 headLines 参与试排，表格让位即可
      VARIANT_QUERY_BODY_BUDGET,
      46,
    );

    const omittedInPage = pageRecords - shown;
    const notFetched = notFetchedTotal;

    // 恒等式一：正文展示 + 本页未展示 = 本次取回
    if (omittedInPage < 0 || shown + omittedInPage !== pageRecords) {
      throw new UpstreamShapeError(
        `计数不自洽（一）：展示 ${shown} + 本页未展示 ${omittedInPage} ≠ 本次取回 ${pageRecords}——拒绝输出不可信计数`,
        { url },
      );
    }
    // 恒等式二：本次取回 + 未取回 = 命中总数。不成立说明上游 total 与 records 互相矛盾。
    if (notFetched < 0 || pageRecords + notFetched !== total) {
      throw new UpstreamShapeError(
        `计数不自洽（二）：本次取回 ${pageRecords} + 未取回 ${notFetched} ≠ 命中 ${total}——上游 total 与 records 矛盾`,
        { url },
      );
    }
    // has_more 与两个缺口必须自洽：说"还有更多"却一条都没少，就是上游自己矛盾——
    // 不替它猜"还有多少"，也不留下一句没有动作的"还有更多"。
    if (hasMore === true && notFetched === 0) {
      throw new UpstreamShapeError(
        `上游自相矛盾：has_more=true，但本次取回 ${pageRecords} 条已等于命中 ${total} 条——不猜还有多少，拒绝输出`,
        { url },
      );
    }
    // 报出的缺口必须真的出现在正文里（预算兜不住时宁可少排几行，也不能把这句话裁掉）
    if (!body.includes(gapText(shown)) && gapText(shown) !== '') {
      throw new UpstreamShapeError(
        '缺口提示未进入正文（被字节预算裁掉）——拒绝输出"报数在 raw、正文看不到"的结果',
        { url },
      );
    }

    /**
     * raw 白名单投影。
     *
     * **实测体积来源（2026-10-29 更正，见 `记录/20261029-更正-VariantHub响应体积来源判断.md`）**：
     * 单条 9398 B 的响应里，`data.samples`（487 个样本名）占 46.6%、`records[0].genotypes`（487 个基因型）占 41.5%，
     * 两者合计 **88.1%**；`info` 与 `info_raw` 各只占 3.5%。
     *
     * 我原先按"去掉 info_raw 就够了"实现是错的——那样仍有约 9 KB，会被 `result()` 硬截断，可能切掉出处或留半条记录。
     * 现在的裁剪是三条一起做：不读 `samples`、不读 `genotypes`、`info_raw` 也不读，只留六列 + ANN 摘要。
     * **空结果与非空结果共用同一投影规则**（审查 WHT3-03）。
     */
    const projected = kept.map((record) => ({
      chrom: record.chrom,
      pos: record.pos,
      id: record.id,
      ref: record.ref,
      alt: record.alt,
      qual: record.qual,
      filter: record.filter,
      ann: annOf(record) === '-' ? undefined : annOf(record),
    }));

    return result(body, res, {
      dataset,
      region: region.text,
      n_samples: nSamples,
      total,
      total_shown: totalShown,
      has_more: hasMore,
      records: projected,
    }, `total=${total}`);
  },
};

export const tools: ToolDefinition[] = [
  searchKnownGenes,
  geneDetail,
  expressionProjects,
  expressionQuery,
  searchPapers,
  convertGeneIds,
  crossSpeciesHomologs,
  variantDatasets,
  variantQuery,
  geneAnnotation,
  geneSequence,
];

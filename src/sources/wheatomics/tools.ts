import { InvalidArgumentError, UpstreamError } from '../../core/errors.js';
import { DEFAULT_MAX_BYTES, provenance, renderFields, renderTable, truncateToBytes, utf8Bytes } from '../../core/format.js';
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

/**
 * 统一收尾：正文按 **UTF-8 字节**预算截断，出处尾注永远保留。
 *
 * 出处必须带完整查询（含参数）与查询时刻——只有 pathname 的话，
 * `searchid=A` 与 `searchid=B` 的出处一模一样，等于没有出处（审查 R06 / A7）。
 */
function result(body: string, res: HttpResult, raw: unknown, extra?: string): ToolResult {
  const at = new Date().toISOString();
  const parsed = new URL(res.url);
  const request = `GET ${parsed.pathname}${parsed.search}`;
  const tail = provenance({
    sourceName: manifest.displayName,
    request,
    status: res.status,
    durationMs: res.durationMs,
    at,
    extra: [manifest.versionNote, extra].filter(Boolean).join('；') || undefined,
  });

  // 先扣掉尾注与截断提示，剩下的才是正文预算：出处不许被挤掉。
  const budget = Math.max(256, DEFAULT_MAX_BYTES - utf8Bytes(tail) - 120);
  const { text, truncated } = truncateToBytes(body, budget);
  const marker = truncated ? '\n…（正文已按 4 KB 上限截断；请缩小查询范围或分批查询）' : '';

  return {
    text: `${text}${marker}${tail}`,
    raw,
    meta: { sourceId: manifest.id, request, url: res.url, status: res.status, durationMs: res.durationMs, at },
  };
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
    const res = await ctx.http(url, { signal: ctx.signal });
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
    const res = await ctx.http(url, { signal: ctx.signal });
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
    const res = await ctx.http(url, { signal: ctx.signal });
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
    const res = await ctx.http(url, { signal: ctx.signal });
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
    const res = await ctx.http(url, { signal: ctx.signal });
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
    const res = await ctx.http(url, { signal: ctx.signal });
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

export const tools: ToolDefinition[] = [
  searchKnownGenes,
  geneDetail,
  expressionProjects,
  expressionQuery,
  searchPapers,
  convertGeneIds,
];

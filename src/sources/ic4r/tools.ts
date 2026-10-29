import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { renderFields, utf8Bytes } from '../../core/format.js';
import { validateArgs } from '../../core/invoke.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest, withRequestEvidence } from '../../core/request.js';
import type { HttpResult, JsonSchema, ToolContext, ToolDefinition } from '../../core/types.js';
import { manifest } from './manifest.js';

type Obj = Record<string, unknown>;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const MAX_ID_CODE_POINTS = 128;
/** 给隐私省略与预算提示留余量，避免 finishResult 再按字节截断。 */
const BODY_BUDGET = MAX_BODY_BYTES - 128;
const ANNOTATION_ROWS_PER_CATEGORY = 2;
const ANNOTATION_DESC_LIMIT = 120;

const idSchema = (description: string): JsonSchema => ({ type: 'string', description });

function object(value: unknown, url: string, what: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpstreamShapeError(`${what}不是对象`, { url });
  }
  return value as Obj;
}

function isEmptyObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Obj).length === 0;
}

function nonEmptyString(value: unknown, url: string, what: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new UpstreamShapeError(`${what}缺失或不是非空字符串`, { url });
  }
  return value.trim();
}

function optString(data: Obj, key: string, url: string): string | undefined {
  const value = data[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new UpstreamShapeError(`字段 ${key} 类型不是字符串`, { url });
  const text = value.trim();
  return text ? text : undefined;
}

function optScalar(data: Obj, key: string, url: string): string | number | undefined {
  const value = data[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.trim() ? value.trim() : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new UpstreamShapeError(`字段 ${key} 既不是字符串也不是数字`, { url });
}

function safe(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return EMAIL_PATTERN.test(text) ? undefined : text;
}

function safeEcho(value: unknown): string {
  const text = String(value);
  if (EMAIL_PATTERN.test(text)) return '（上游取值含联系方式，已省略）';
  return [...text].slice(0, 64).join('');
}

function scrubBody(body: string): string {
  const kept: string[] = [];
  let omitted = 0;
  for (const line of body.split('\n')) {
    if (EMAIL_PATTERN.test(line)) {
      omitted += 1;
      continue;
    }
    kept.push(line);
  }
  if (omitted === 0) return body;
  return `${kept.join('\n')}\n（另有 ${omitted} 行含联系方式文本，已整行省略）`;
}

function scrubRaw(value: unknown): unknown {
  if (typeof value === 'string') return EMAIL_PATTERN.test(value) ? null : value;
  if (Array.isArray(value)) return value.map((item) => scrubRaw(item));
  if (value && typeof value === 'object') {
    const out: Obj = {};
    for (const [key, item] of Object.entries(value as Obj)) out[key] = scrubRaw(item);
    return out;
  }
  return value;
}

/** ID 只检查原始串，不 trim、不改写；拼 URL 时按原始串编码一次。 */
function idArg(args: Record<string, unknown>, key: 'locus' | 'accession'): string {
  const raw = args[key];
  const label = key === 'locus' ? 'locus' : 'accession';
  if (typeof raw !== 'string') throw new InvalidArgumentError(`参数 ${label} 必须是字符串`);
  if (raw.trim() === '') throw new InvalidArgumentError(`参数 ${label} 不能为空（尚未联网）`);
  if (raw !== raw.trim()) {
    throw new InvalidArgumentError(`参数 ${label} 首尾含空白；本仓不改写输入，请去掉空白后重试（尚未联网）`);
  }
  if ([...raw].length > MAX_ID_CODE_POINTS) {
    throw new InvalidArgumentError(`参数 ${label} 超过本仓 ${MAX_ID_CODE_POINTS} 个 Unicode 码点上限（尚未联网）`);
  }
  if (/[\u0000-\u001F\u007F]/.test(raw)) {
    throw new InvalidArgumentError(`参数 ${label} 含控制字符，拒绝拼进 URL（尚未联网）`);
  }
  if (raw === '.' || raw === '..') {
    throw new InvalidArgumentError(`参数 ${label} 不能是 "." 或 ".."（路径规范化危险值，尚未联网）`);
  }
  return raw;
}

function fitLines(lines: string[], url: string): string {
  let body = '';
  for (const line of lines) {
    const candidate = body ? `${body}\n${line}` : line;
    if (utf8Bytes(candidate) > BODY_BUDGET) break;
    body = candidate;
  }
  if (!body) throw new UpstreamShapeError('首个摘要行已超出正文预算，无法在不失真的前提下展示', { url });
  return body;
}

function checked(def: ToolDefinition): ToolDefinition {
  const run = def.run;
  def.run = async (args, ctx) => {
    validateArgs(def, args);
    return withRequestEvidence(ctx, (scoped) => run(args, scoped));
  };
  return def;
}

type ResponseKind = 'empty' | 'json' | 'ambiguous';

async function request(ctx: ToolContext, path: string) {
  return requestUrl(ctx, `${manifest.apiBase}${path}`);
}

/** 列表端点 `/ic4r/genes/view` 不在 apiBase 下，需要绝对 URL。 */
async function requestUrl(ctx: ToolContext, url: string) {
  const prepared = prepareRequest({ url, sourceName: manifest.displayName });
  const res = await fetchPrepared(ctx, prepared);
  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(`上游 HTTP ${res.status}，不是成功结果`, {
      url: prepared.url,
      request: prepared.request,
      status: res.status,
      contentType: res.contentType,
    });
  }
  // 零长度正文允许没有 content-type，不能按“非 JSON”报错。
  const kind: ResponseKind = res.bodyKind === 'empty'
    ? 'empty'
    : res.bodyKind === 'json'
      ? 'json'
      : isEmptyObject(res.data) ? 'ambiguous' : 'json';
  if (kind !== 'empty' && res.contentType && !/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(res.contentType)) {
    throw new UpstreamError('上游响应格式错误：成功响应不是 JSON', {
      url: prepared.url,
      request: prepared.request,
      status: res.status,
      contentType: res.contentType,
    });
  }
  return { prepared, res, kind };
}

function finish(body: string, res: HttpResult, raw: unknown, prepared: ReturnType<typeof prepareRequest>, extra: string) {
  return finishResult({ body: scrubBody(body), res, raw: scrubRaw(raw), prepared, sourceId: manifest.id, extra });
}

function integrity(message: string, prepared: ReturnType<typeof prepareRequest>): never {
  throw new UpstreamShapeError(`响应与请求不一致：${message}`, { url: prepared.url, request: prepared.request });
}

/** 200 + 0 字节：只能报“无法确认”，不许判不存在或结构漂移。 */
function emptyResponse(idLabel: string, id: string, idSpaceHint: string, res: HttpResult, prepared: ReturnType<typeof prepareRequest>, extra: string) {
  const body = [
    `无法确认：上游返回空响应（HTTP 200、0 字节正文），不判 ${idLabel}=${id} 是否存在。`,
    '既有观测里，四个单对象端点在没有记录时就是 0 字节正文；但样本只有一次，不能据此推广成“空响应 = 记录一定没有”。',
    idSpaceHint,
  ].join('\n');
  return finish(body, res, { kind: 'empty', bodyBytes: 0 }, prepared, extra);
}

/** bodyKind 缺失且正文是 {}：类型未知，既不判查无也不判正常。 */
function unknownResponse(idLabel: string, id: string, res: HttpResult, prepared: ReturnType<typeof prepareRequest>, extra: string) {
  const body = [
    `无法确认：响应类型未知（bodyKind 缺失），无法确认 ${idLabel}=${id} 是否存在。`,
    '响应体是空对象 {}，而空对象既可能是“零字节正文被解析成 {}”，也可能是上游真的回了 {}；本仓不在这两者之间猜。',
    '如需确认，请重试；若持续如此，请把该请求与响应交给维护者。',
  ].join('\n');
  return finish(body, res, { kind: 'ambiguous', bodyKind: null }, prepared, extra);
}

/** epoch 毫秒 → UTC ISO；未知类型直接算漂移，不猜时区。 */
function timestamp(data: Obj, key: string, url: string): string | undefined {
  const value = data[key];
  if (value === null || value === undefined) return undefined;
  let ms: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value)) ms = value;
  if (typeof value === 'string' && /^\d{10,14}$/.test(value.trim())) ms = Number(value.trim());
  if (ms === undefined) throw new UpstreamShapeError(`字段 ${key} 不是 epoch 毫秒`, { url });
  return `${new Date(ms).toISOString()}（epoch 毫秒 ${ms}，按 UTC 解释）`;
}

const gene = checked({
  name: 'ic4r_gene',
  description:
    '按精确 IC4R 基因 locus 取水稻基因记录：同义词、描述、MSU/RAP-DB accession、类型、链、染色体、基因长度、位置；不含序列。只覆盖水稻单一物种；不能按名称检索，按染色体浏览请用 ic4r_gene_list；locus 是基因 ID 空间（…G…），与 circRNA（…Circ…）、lncRNA（…Lnc…）不通用。上游查无时返回 0 字节正文，本工具报“无法确认是否存在”，不判记录不存在。',
  parameters: { type: 'object', properties: { locus: idSchema('精确 IC4R 基因 locus，例如 IC4R-OSJ01G000600，最多128码点') }, required: ['locus'], additionalProperties: false },
  async run(args, ctx) {
    const locus = idArg(args, 'locus');
    const { prepared, res, kind } = await request(ctx, `/gene/${encodeURIComponent(locus)}`);
    if (kind === 'empty') {
      return emptyResponse('locus', locus, '提示：空响应也可能是 ID 类型不匹配——本端点只接受基因 locus（…G…）。', res, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    }
    if (kind === 'ambiguous') return unknownResponse('locus', locus, res, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    if (Array.isArray(res.data)) {
      throw new UpstreamShapeError('基因端点返回数组，与已测单对象形态不符', { url: prepared.url, request: prepared.request });
    }
    const record = object(res.data, prepared.url, '基因记录');
    if (Object.keys(record).length === 0) {
      throw new UpstreamShapeError('返回合法 JSON 空对象，与单对象端点形态不符，不能解释为查无', { url: prepared.url, request: prepared.request });
    }
    if (!('locus' in record)) throw new UpstreamShapeError('基因记录缺少身份字段 locus', { url: prepared.url, request: prepared.request });
    if (String(record.locus) !== locus) integrity(`请求 locus=${locus}，响应 locus=${safeEcho(record.locus)}`, prepared);

    const body = fitLines(
      [
        `基因 ${locus}：${safe(optString(record, 'description', prepared.url)) ?? '（无描述）'}`,
        renderFields([
          ['物种', safe(optString(record, 'source', prepared.url))],
          ['类型', safe(optString(record, 'type', prepared.url))],
          ['染色体', optScalar(record, 'chromosome', prepared.url)],
          ['位置', safe(optString(record, 'location', prepared.url))],
          ['基因长度（bp）', optScalar(record, 'geneLength', prepared.url)],
          ['链', safe(optString(record, 'strand', prepared.url))],
          ['MSU accession', safe(optString(record, 'msuAccession', prepared.url))],
          ['RAP-DB accession', safe(optString(record, 'rapdbAccession', prepared.url))],
          ['同义词', safe(optString(record, 'synonym', prepared.url))],
          ['更新时间', timestamp(record, 'lastModified', prepared.url)],
        ]),
        '本工具不含序列；需要其他库的 ID 对照时用 ic4r_id_convert。',
      ],
      prepared.url,
    );
    return finish(
      body,
      res,
      {
        locus,
        description: safe(optString(record, 'description', prepared.url)) ?? null,
        source: safe(optString(record, 'source', prepared.url)) ?? null,
        type: safe(optString(record, 'type', prepared.url)) ?? null,
        chromosome: optScalar(record, 'chromosome', prepared.url) ?? null,
        location: safe(optString(record, 'location', prepared.url)) ?? null,
        geneLength: optScalar(record, 'geneLength', prepared.url) ?? null,
        strand: safe(optString(record, 'strand', prepared.url)) ?? null,
        msuAccession: safe(optString(record, 'msuAccession', prepared.url)) ?? null,
        rapdbAccession: safe(optString(record, 'rapdbAccession', prepared.url)) ?? null,
        lastModified: typeof record.lastModified === 'number' || typeof record.lastModified === 'string' ? record.lastModified : null,
      },
      prepared,
      '版本口径：IC4R 2.0（文档声明，2018-05）；lastModified 按 UTC 解释',
    );
  },
});

const annotation = checked({
  name: 'ic4r_annotation',
  description:
    '按精确 IC4R 基因 locus 取功能注释（SUPPERFAMILY / Gene3D / InterPro / Pfam / CDD 等类别），按类别分组、每组最多展示 2 条并报本次返回条数。只覆盖水稻单物种；annotation 端点查无时返回空数组 []，本工具报“本次未返回注释”，不表示该基因没有注释。',
  parameters: { type: 'object', properties: { locus: idSchema('精确 IC4R 基因 locus，例如 IC4R-OSJ01G000600，最多128码点') }, required: ['locus'], additionalProperties: false },
  async run(args, ctx) {
    const locus = idArg(args, 'locus');
    const { prepared, res, kind } = await request(ctx, `/annotation/${encodeURIComponent(locus)}`);
    if (kind === 'empty') {
      return emptyResponse('locus', locus, '提示：本端点只接受基因 locus（…G…）。', res, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    }
    if (kind === 'ambiguous') return unknownResponse('locus', locus, res, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    if (!Array.isArray(res.data)) {
      throw new UpstreamShapeError('annotation 端点应返回数组，本次不是数组', { url: prepared.url, request: prepared.request });
    }
    const entries = res.data;
    if (entries.length === 0) {
      const body = `本次未返回功能注释：上游返回空数组 []（不表示该基因没有注释，只表示本次没有返回条目）。\nlocus：${locus}`;
      return finish(body, res, { locus, returned: 0 }, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    }

    const groups = new Map<string, Obj[]>();
    for (const item of entries) {
      const row = object(item, prepared.url, 'annotation 成员');
      const category = safe(optString(row, 'functionalCategory', prepared.url)) ?? '（未标注类别）';
      const list = groups.get(category) ?? [];
      list.push(row);
      groups.set(category, list);
    }

    const header = [
      `功能注释：本次返回 ${entries.length} 条、${groups.size} 个类别（不表示该基因的全部注释）。`,
      `locus：${locus}`,
    ].join('\n');

    const blocks: string[] = [];
    for (const [category, rows] of groups) {
      const lines = [`【${category}】${rows.length} 条`];
      for (const row of rows.slice(0, ANNOTATION_ROWS_PER_CATEGORY)) {
        const functionalId = safe(optString(row, 'functionalId', prepared.url)) ?? '（无 functionalId）';
        const description = safe(optString(row, 'description', prepared.url));
        const descText = description === undefined ? '' : `：${[...description].slice(0, ANNOTATION_DESC_LIMIT).join('')}${[...description].length > ANNOTATION_DESC_LIMIT ? '…（已截断）' : ''}`;
        lines.push(`- ${functionalId}${descText}`);
      }
      if (rows.length > ANNOTATION_ROWS_PER_CATEGORY) lines.push(`- …该类别另有 ${rows.length - ANNOTATION_ROWS_PER_CATEGORY} 条未展示`);
      blocks.push(lines.join('\n'));
    }

    // 每个类别整块放入；放不下的整组省略，绝不输出半组。
    let body = header;
    let dropped = 0;
    for (const block of blocks) {
      const candidate = `${body}\n${block}`;
      if (utf8Bytes(candidate) > BODY_BUDGET) {
        dropped += 1;
        continue;
      }
      body = candidate;
    }
    if (dropped > 0) {
      const footer = `\n另有 ${dropped} 个功能类别因 4 KB 预算未展示（整组省略，未截断）。`;
      body = utf8Bytes(`${body}${footer}`) <= BODY_BUDGET ? `${body}${footer}` : body;
    }

    return finish(
      body,
      res,
      {
        locus,
        returned: entries.length,
        categoryCount: groups.size,
        categories: [...groups.entries()].map(([category, rows]) => ({ category, count: rows.length })),
        droppedCategories: dropped,
      },
      prepared,
      '版本口径：IC4R 2.0（文档声明，2018-05）；每组最多展示 2 条',
    );
  },
});

const circrna = checked({
  name: 'ic4r_circrna',
  description:
    '按精确 circRNA accession 取水稻 circRNA 记录：染色体、别名、长度、类型、亲本基因、起止、链、物种与序列。accession 是 circRNA ID 空间（…Circ…），不是基因 locus；序列默认整条展示，超过 4 KB 预算则整条省略（不截半条）。查无时上游返回 0 字节正文，本工具报“无法确认是否存在”。',
  parameters: { type: 'object', properties: { accession: idSchema('精确 circRNA accession，例如 IC4R-OSJ01Circ057100，最多128码点') }, required: ['accession'], additionalProperties: false },
  async run(args, ctx) {
    const accession = idArg(args, 'accession');
    const { prepared, res, kind } = await request(ctx, `/circRNA/${encodeURIComponent(accession)}`);
    if (kind === 'empty') {
      return emptyResponse('accession', accession, '提示：本端点只接受 circRNA accession（…Circ…），不是基因 locus。', res, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    }
    if (kind === 'ambiguous') return unknownResponse('accession', accession, res, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    if (Array.isArray(res.data)) {
      throw new UpstreamShapeError('circRNA 端点返回数组，与已测单对象形态不符', { url: prepared.url, request: prepared.request });
    }
    const record = object(res.data, prepared.url, 'circRNA 记录');
    if (Object.keys(record).length === 0) {
      throw new UpstreamShapeError('返回合法 JSON 空对象，与单对象端点形态不符，不能解释为查无', { url: prepared.url, request: prepared.request });
    }
    if (!('accession' in record)) throw new UpstreamShapeError('circRNA 记录缺少身份字段 accession', { url: prepared.url, request: prepared.request });
    if (String(record.accession) !== accession) integrity(`请求 accession=${accession}，响应 accession=${safeEcho(record.accession)}`, prepared);

    const sequence = safe(optString(record, 'sequence', prepared.url));
    const header = fitLines(
      [
        `circRNA ${accession}：${safe(optString(record, 'parentalGeneDesc', prepared.url)) ?? '（无亲本基因描述）'}`,
        renderFields([
          ['物种', safe(optString(record, 'organism', prepared.url))],
          ['染色体', optScalar(record, 'chromosome', prepared.url)],
          ['别名', safe(optString(record, 'alias', prepared.url))],
          ['长度（bp）', optScalar(record, 'length', prepared.url)],
          ['类型', safe(optString(record, 'type', prepared.url))],
          ['亲本基因', safe(optString(record, 'parentalGene', prepared.url))],
          ['起止', [optScalar(record, 'start', prepared.url), optScalar(record, 'end', prepared.url)].filter((v) => v !== undefined).join('–') || undefined],
          ['链', safe(optString(record, 'strand', prepared.url))],
        ]),
      ],
      prepared.url,
    );

    let body = header;
    const notes: string[] = [];
    if (sequence) {
      const block = `序列（${sequence.length} bp）：\n${sequence}`;
      const candidate = `${body}\n${block}`;
      if (utf8Bytes(candidate) <= BODY_BUDGET) body = candidate;
      else {
        const note = `序列长度 ${sequence.length} bp，因 4 KB 版式预算整条未展示（不是上游没有序列，也未截断）。完整序列请用上游记录页或下载页。`;
        const withNote = `${body}\n${note}`;
        body = utf8Bytes(withNote) <= BODY_BUDGET ? withNote : body;
        notes.push(`序列未展示（${sequence.length} bp）`);
      }
    } else {
      notes.push('上游序列为空');
    }

    return finish(
      body,
      res,
      {
        accession,
        chromosome: optScalar(record, 'chromosome', prepared.url) ?? null,
        length: optScalar(record, 'length', prepared.url) ?? null,
        type: safe(optString(record, 'type', prepared.url)) ?? null,
        parentalGene: safe(optString(record, 'parentalGene', prepared.url)) ?? null,
        strand: safe(optString(record, 'strand', prepared.url)) ?? null,
        organism: safe(optString(record, 'organism', prepared.url)) ?? null,
        sequenceShown: sequence !== undefined && utf8Bytes(`${header}\n序列（${sequence.length} bp）：\n${sequence}`) <= BODY_BUDGET,
        sequenceLength: sequence?.length ?? null,
      },
      prepared,
      '版本口径：IC4R 2.0（文档声明，2018-05）；序列整条展示或整条省略',
    );
  },
});

const lncrna = checked({
  name: 'ic4r_lncrna',
  description:
    '按精确 lncRNA accession 取水稻 lncRNA 记录：染色体、链、位置、长度与序列。accession 是 lncRNA ID 空间（…Lnc…，可能带 .1 后缀），不是基因 locus；序列默认整条展示，超 4 KB 预算整条省略。注意：唯一实测样例的 1,639 bp 序列默认不展示，这是预算结果，并非上游没有序列。查无时上游返回 0 字节正文，本工具报“无法确认是否存在”。',
  parameters: { type: 'object', properties: { accession: idSchema('精确 lncRNA accession，例如 IC4R-OSJ01Lnc000600.1，最多128码点') }, required: ['accession'], additionalProperties: false },
  async run(args, ctx) {
    const accession = idArg(args, 'accession');
    const { prepared, res, kind } = await request(ctx, `/lncRNA/${encodeURIComponent(accession)}`);
    if (kind === 'empty') {
      return emptyResponse('accession', accession, '提示：本端点只接受 lncRNA accession（…Lnc…，可能带 .1 后缀），不是基因 locus。', res, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    }
    if (kind === 'ambiguous') return unknownResponse('accession', accession, res, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    if (Array.isArray(res.data)) {
      throw new UpstreamShapeError('lncRNA 端点返回数组，与已测单对象形态不符', { url: prepared.url, request: prepared.request });
    }
    const record = object(res.data, prepared.url, 'lncRNA 记录');
    if (Object.keys(record).length === 0) {
      throw new UpstreamShapeError('返回合法 JSON 空对象，与单对象端点形态不符，不能解释为查无', { url: prepared.url, request: prepared.request });
    }
    if (!('accession' in record)) throw new UpstreamShapeError('lncRNA 记录缺少身份字段 accession', { url: prepared.url, request: prepared.request });
    if (String(record.accession) !== accession) integrity(`请求 accession=${accession}，响应 accession=${safeEcho(record.accession)}`, prepared);

    const sequence = safe(optString(record, 'sequence', prepared.url));
    const header = fitLines(
      [
        `lncRNA ${accession}`,
        renderFields([
          ['IC4R accession', safe(optString(record, 'ic4rAccession', prepared.url))],
          ['染色体', optScalar(record, 'chr', prepared.url)],
          ['链', safe(optString(record, 'strand', prepared.url))],
          ['位置', safe(optString(record, 'location', prepared.url))],
          ['长度（bp）', optScalar(record, 'length', prepared.url)],
        ]),
      ],
      prepared.url,
    );

    let body = header;
    if (sequence) {
      const block = `序列（${sequence.length} bp）：\n${sequence}`;
      const candidate = `${body}\n${block}`;
      if (utf8Bytes(candidate) <= BODY_BUDGET) body = candidate;
      else {
        const note = `序列长度 ${sequence.length} bp，因 4 KB 版式预算整条未展示（不是上游没有序列，也未截断）。完整序列请用上游记录页或下载页。`;
        const withNote = `${body}\n${note}`;
        body = utf8Bytes(withNote) <= BODY_BUDGET ? withNote : body;
      }
    } else {
      const withNote = `${body}\n上游序列为空。`;
      body = utf8Bytes(withNote) <= BODY_BUDGET ? withNote : body;
    }

    return finish(
      body,
      res,
      {
        accession,
        ic4rAccession: safe(optString(record, 'ic4rAccession', prepared.url)) ?? null,
        chromosome: optScalar(record, 'chr', prepared.url) ?? null,
        strand: safe(optString(record, 'strand', prepared.url)) ?? null,
        location: safe(optString(record, 'location', prepared.url)) ?? null,
        length: optScalar(record, 'length', prepared.url) ?? null,
        sequenceLength: sequence?.length ?? null,
        sequenceShown: sequence !== undefined && utf8Bytes(`${header}\n序列（${sequence.length} bp）：\n${sequence}`) <= BODY_BUDGET,
      },
      prepared,
      '版本口径：IC4R 2.0（文档声明，2018-05）；序列整条展示或整条省略',
    );
  },
});

const idConversion = checked({
  name: 'ic4r_id_convert',
  description:
    '把精确 IC4R 基因 locus 映射到 MSU 与 RAP-DB 数据库的 ID（附 symbol）。只承诺已测方向：IC4R locus → MSU / RAP-DB；反向映射（MSU/RAP-DB → IC4R）未测，本工具不承诺，输入必须是 IC4R locus（…G…）。查无时上游返回 0 字节正文，本工具报“无法确认是否存在”。',
  parameters: { type: 'object', properties: { locus: idSchema('精确 IC4R 基因 locus，例如 IC4R-OSJ01G000600，最多128码点') }, required: ['locus'], additionalProperties: false },
  async run(args, ctx) {
    const locus = idArg(args, 'locus');
    const { prepared, res, kind } = await request(ctx, `/idConversion/${encodeURIComponent(locus)}`);
    if (kind === 'empty') {
      return emptyResponse('locus', locus, '提示：本端点只接受 IC4R 基因 locus（…G…）；MSU/RAP-DB ID 不能作为输入（反向映射未测）。', res, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    }
    if (kind === 'ambiguous') return unknownResponse('locus', locus, res, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    if (Array.isArray(res.data)) {
      throw new UpstreamShapeError('idConversion 端点返回数组，与已测单对象形态不符', { url: prepared.url, request: prepared.request });
    }
    const record = object(res.data, prepared.url, 'ID 映射记录');
    if (Object.keys(record).length === 0) {
      throw new UpstreamShapeError('返回合法 JSON 空对象，与单对象端点形态不符，不能解释为查无', { url: prepared.url, request: prepared.request });
    }
    if (!('ic4r' in record)) throw new UpstreamShapeError('ID 映射记录缺少身份字段 ic4r', { url: prepared.url, request: prepared.request });
    if (String(record.ic4r) !== locus) integrity(`请求 locus=${locus}，响应 ic4r=${safeEcho(record.ic4r)}`, prepared);

    const msu = safe(optString(record, 'msu', prepared.url));
    const rapDb = safe(optString(record, 'rapDb', prepared.url));
    const body = fitLines(
      [
        `IC4R locus ${locus} 的 ID 映射`,
        renderFields([
          ['MSU', msu],
          ['RAP-DB', rapDb],
          ['symbol', safe(optString(record, 'symbol', prepared.url))],
        ]),
        msu && rapDb
          ? '已测方向：IC4R → MSU / RAP-DB。反向映射未测，不要用 MSU/RAP-DB ID 再调本工具。'
          : '上游未同时提供 MSU 与 RAP-DB 两个 ID，缺项按响应如实展示。',
      ],
      prepared.url,
    );
    return finish(
      body,
      res,
      { locus, msu: msu ?? null, rapDb: rapDb ?? null, symbol: safe(optString(record, 'symbol', prepared.url)) ?? null },
      prepared,
      '版本口径：IC4R 2.0（文档声明，2018-05）；只承诺已测方向',
    );
  },
});

const LIST_ORIGIN = new URL(manifest.homepage).origin;
const LIST_PATH = '/ic4r/genes/view';
const LIST_MAX_START = 1_000_000;
const LIST_MAX_LENGTH = 50;
const LIST_DEFAULT_LENGTH = 20;
const LIST_DESC_LIMIT = 40;

/** 染色体取值 = 页面下拉枚举（1–12、Sy、Un），依据是页面内联配置，不是本仓猜的语法。 */
const CHROMOSOME_VALUES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'Sy', 'Un'] as const;
function chromosomeArg(args: Record<string, unknown>): string {
  const raw = args.chromosome;
  if (typeof raw !== 'string') throw new InvalidArgumentError('参数 chromosome 必须是字符串');
  if (raw.trim() === '') throw new InvalidArgumentError('参数 chromosome 不能为空（尚未联网）');
  if (raw !== raw.trim()) throw new InvalidArgumentError('参数 chromosome 首尾含空白；本仓不改写输入，请去掉空白后重试（尚未联网）');
  if ((CHROMOSOME_VALUES as readonly string[]).includes(raw)) return raw;
  throw new InvalidArgumentError(
    `参数 chromosome 只接受页面给出的取值：${CHROMOSOME_VALUES.join('、')}（依据是 /ic4r/genes/browse 的下拉枚举，不是本仓猜测）；收到「${safeEcho(raw)}」`,
  );
}

function intInRange(args: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number): number {
  const raw = args[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) throw new InvalidArgumentError(`参数 ${key} 必须是整数`);
  if (raw < minimum || raw > maximum) {
    throw new InvalidArgumentError(`参数 ${key} 必须在 ${minimum}–${maximum} 之间（收到 ${raw}），不做静默夹取`);
  }
  return raw;
}

/**
 * 列表信封。
 *
 * **实测只有裸对象** `{draw,recordsTotal,recordsFiltered,data,error}`：2026-10-28 对
 * `/genes/view?chromosome=99`（recordsTotal=0）的原始响应是 70 字节、首字节 0x7B(`{`)、末字节 0x7D(`}`)。
 * 单元素数组包裹这个形态**本仓没有实测到**，是按负责人要求做的**防御性兼容**，不声明为上游已观测行为。
 * 多元素数组、null、其他形状一律按结构漂移失败，不做静默归一。
 * 口径来源：负责人 2026-10-28 决定“两种信封都接受”，本条按防御性兼容实现并如实标注。
 */
function datatablesEnvelope(data: unknown, url: string): { envelope: Obj; form: 'object' | 'array-wrap' } {
  if (Array.isArray(data)) {
    if (data.length === 1 && data[0] && typeof data[0] === 'object' && !Array.isArray(data[0])) {
      return { envelope: data[0] as Obj, form: 'array-wrap' };
    }
    throw new UpstreamShapeError(`列表响应是长度 ${data.length} 的数组，不是已支持的单元素包裹形态`, { url });
  }
  return { envelope: object(data, url, '列表信封'), form: 'object' };
}

const geneList = checked({
  name: 'ic4r_gene_list',
  description:
    '按染色体分页列出 IC4R 粳稻基因的 locus（ID 发现入口）：chromosome 取页面的 1–12 / Sy / Un，start/length 为 DataTables 分页（length 本仓上限 50）。返回上游 recordsTotal、本次返回条数与每行 locus/描述/类型/位置；拿到 locus 后可用 ic4r_gene 取详情。只能按染色体浏览，不能按基因名、性状或区间检索；本仓不承诺 length 的上游上限（未测）。上游对枚举外的值（如 99）实测返回 HTTP 200 + recordsTotal=0，本地拒绝属于产品层白名单约束，不是上游限制。',
  parameters: {
    type: 'object',
    properties: {
      chromosome: { type: 'string', description: '染色体：1–12 / Sy / Un（页面下拉给出的取值），最多8码点' },
      start: { type: 'integer', minimum: 0, maximum: LIST_MAX_START, default: 0, description: 'DataTables 的 start（偏移），默认 0' },
      length: { type: 'integer', minimum: 1, maximum: LIST_MAX_LENGTH, default: LIST_DEFAULT_LENGTH, description: 'DataTables 的 length（本页条数），1–50，默认 20' },
    },
    required: ['chromosome'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const chromosome = chromosomeArg(args);
    const start = intInRange(args, 'start', 0, 0, LIST_MAX_START);
    const length = intInRange(args, 'length', LIST_DEFAULT_LENGTH, 1, LIST_MAX_LENGTH);
    const url = `${LIST_ORIGIN}${LIST_PATH}?chromosome=${encodeURIComponent(chromosome)}&draw=1&start=${start}&length=${length}`;
    const { prepared, res, kind } = await requestUrl(ctx, url);
    if (kind === 'empty') {
      return emptyResponse('chromosome', chromosome, '提示：列表端点本次返回 0 字节正文，无法确认该染色体是否有记录。', res, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    }
    if (kind === 'ambiguous') return unknownResponse('chromosome', chromosome, res, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');

    const { envelope, form: envelopeForm } = datatablesEnvelope(res.data, prepared.url);
    const total = envelope.recordsTotal;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
      throw new UpstreamShapeError('列表响应缺少合法的 recordsTotal（非负整数）', { url: prepared.url, request: prepared.request });
    }
    const filtered = envelope.recordsFiltered;
    if (filtered !== undefined && filtered !== null && (typeof filtered !== 'number' || !Number.isSafeInteger(filtered))) {
      throw new UpstreamShapeError('recordsFiltered 不是整数', { url: prepared.url, request: prepared.request });
    }
    if (!Array.isArray(envelope.data)) {
      throw new UpstreamShapeError('列表响应的 data 不是数组', { url: prepared.url, request: prepared.request });
    }
    const rows = envelope.data as unknown[];

    const filteredText = typeof filtered === 'number' ? String(filtered) : '未提供';
    const summary = `染色体 ${chromosome}：上游 recordsTotal=${total}；recordsFiltered=${filteredText}；本次请求 start=${start}、length=${length}；本次返回 ${rows.length} 条。`;

    if (rows.length === 0 && total === 0) {
      const body = [
        summary,
        '该染色体上游记录数为 0（recordsTotal=0），本页没有行。',
        '染色体取值来自 /ic4r/genes/browse 的下拉枚举（1–12、Sy、Un）；若你要按基因名或性状检索，本仓不提供。',
      ].join('\n');
      return finish(body, res, { recordsTotal: 0, recordsFiltered: filteredText, envelopeForm, start, length, returned: 0, loci: [] }, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
    }

    if (rows.length === 0) {
      if (start >= total) {
        const body = [
          summary,
          `start=${start} 已越过末页（recordsTotal=${total}）：这是分页越界，不是“无基因”的结论。请把 start 调回 0–${Math.max(0, total - 1)}。`,
        ].join('\n');
        return finish(body, res, { recordsTotal: total, recordsFiltered: filteredText, envelopeForm, start, length, returned: 0, loci: [] }, prepared, '版本口径：IC4R 2.0（文档声明，2018-05）');
      }
      throw new UpstreamShapeError('data 为空但 start 仍在记录范围内且 recordsTotal>0，该空形态未实测，不判为“无基因”', {
        url: prepared.url,
        request: prepared.request,
      });
    }

    const values: string[][] = [];
    for (const item of rows) {
      const row = object(item, prepared.url, '基因行');
      const locus = nonEmptyString(row.locus, prepared.url, '基因行 locus');
      const description = safe(optString(row, 'description', prepared.url));
      values.push([
        locus,
        description === undefined ? '-' : `${[...description].slice(0, LIST_DESC_LIMIT).join('')}${[...description].length > LIST_DESC_LIMIT ? '…' : ''}`,
        safe(optString(row, 'type', prepared.url)) ?? '-',
        safe(optString(row, 'location', prepared.url)) ?? '-',
      ]);
    }

    const header = [
      summary,
      '按染色体浏览（IC4R 2.0 粳稻注释）；不能按基因名或性状检索。拿到 locus 后用 ic4r_gene 取详情。',
    ].join('\n');

    const footerFor = (shownCount: number) => `\n本次返回 ${values.length} 条，实际展示 ${shownCount} 条；另有 ${values.length - shownCount} 条本次未展示（4 KB 预算），请缩小 length 或调整 start。`;
    let body = header;
    let shown = 0;
    for (let count = 1; count <= values.length; count += 1) {
      const table = `| locus | 描述 | 类型 | 位置 |\n| --- | --- | --- | --- |\n${values
        .slice(0, count)
        .map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '/')).join(' | ')} |`)
        .join('\n')}`;
      const candidate = `${header}\n${table}`;
      const needsFooter = count < values.length;
      if (utf8Bytes(needsFooter ? `${candidate}${footerFor(count)}` : candidate) > BODY_BUDGET) break;
      body = candidate;
      shown = count;
    }
    if (shown < values.length) body = `${body}${footerFor(shown)}`;

    return finish(
      body,
      res,
      {
        recordsTotal: total,
        recordsFiltered: typeof filtered === 'number' ? filtered : null,
        envelopeForm,
        chromosome,
        start,
        length,
        returned: rows.length,
        shown,
        loci: values.map((row) => row[0]),
      },
      prepared,
      '版本口径：IC4R 2.0（文档声明，2018-05）；recordsTotal 为上游字段，本次返回条数不等于总数',
    );
  },
});

export const tools: ToolDefinition[] = [gene, annotation, circrna, lncrna, idConversion, geneList];

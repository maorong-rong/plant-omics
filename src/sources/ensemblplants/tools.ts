import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { renderFields, renderTable, utf8Bytes } from '../../core/format.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest } from '../../core/request.js';
import type { HttpResult, JsonSchema, ToolContext, ToolDefinition } from '../../core/types.js';
import { manifest } from './manifest.js';

type Obj = Record<string, unknown>;

/**
 * 物种白名单：常量，不接受上游 /info/species 动态生成（那会重开人类基因入口）。
 *
 * `assembly` 是 2026-10-30 实测的当前组装名（release 116），用于查无时告知
 * "本源的当前组装是什么"。**ID 是分代次的**：玉米 B73 v4 的 `Zm00001d…`
 * 在 NAM-5.0 上查不到，且与"基因真不存在"返回一模一样（ENSP-06）。
 */
export const SPECIES = Object.freeze({
  'arabidopsis_thaliana': { label: '拟南芥 Arabidopsis thaliana', assembly: 'TAIR10' },
  'oryza_sativa': { label: '水稻 Oryza sativa', assembly: 'IRGSP-1.0' },
  'triticum_aestivum': { label: '小麦 Triticum aestivum', assembly: 'IWGSC' },
  'zea_mays': { label: '玉米 Zea mays', assembly: 'Zm-B73-REFERENCE-NAM-5.0' },
} as const);
export type SpeciesId = keyof typeof SPECIES;

/** 已知的旧代次 ID 前缀：命中时查无文案必须给出更强的提示（ENSP-06）。 */
/**
 * 已实测的旧代次编号 → 提示语。
 *
 * 只用**实测过的具体编号**触发，**不做整类前缀判定**：一个旧 ID 查无只证明该 ID 本次未返回，
 * 不能外推"所有 `Zm00001d…` 都不可查"（审查意见）。也不新增任何本地拒绝规则——
 * 那等于我们替上游判定版本。
 */
const STALE_ID_HINTS: ReadonlyArray<{ test: (query: string, species: string) => boolean; note: string }> = [
  {
    test: (query, species) => species === 'zea_mays' && query === 'Zm00001d027624',
    note: '已实测旧编号 `Zm00001d027624`（B73 v4）在本源查无；玉米当前组装为 NAM-5.0（`Zm00001eb…`），旧编号可能因代次差异不可查',
  },
];

const speciesSchema: JsonSchema = {
  type: 'string', enum: Object.keys(SPECIES),
  description: '已实测物种：arabidopsis_thaliana / oryza_sativa / triticum_aestivum / zea_mays；其他物种未实测，本地拒绝',
};

const VERSION = manifest.versionNote ?? '版本未知';
const NOT_FOUND_NOTE = '上游明确未找到，不代表该基因在其他库或其他注释版本中不存在';

function versionExtra(): string { return VERSION; }

function obj(value: unknown, url: string, what: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpstreamShapeError(`${what}不是对象`, { url });
  }
  return value as Obj;
}

function text(value: unknown, url: string, what: string, max = 400): string {
  if (typeof value !== 'string' || !value.trim()) throw new UpstreamShapeError(`${what}缺失或不是非空字符串`, { url });
  const chars = [...value.trim()];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function optText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s ? s : undefined;
}

function position(value: unknown, url: string, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new UpstreamShapeError(`${what}不是非负安全整数`, { url });
  }
  return value;
}

function requireSpeciesId(args: Obj): SpeciesId {
  const raw = args.species;
  // 必须用 hasOwn：`'constructor' in SPECIES` 为 true，原型键会让白名单形同虚设（审查反例）。
  if (typeof raw !== 'string' || !Object.hasOwn(SPECIES, raw)) {
    throw new InvalidArgumentError(
      `物种未实测或不在白名单：${typeof raw === 'string' ? raw : '(缺)'}；本工具只开放 ${Object.keys(SPECIES).join('、')}（尚未联网）`,
    );
  }
  return raw as SpeciesId;
}

/** 恰好一个：两个都给、都不给都拒；不静默择一。 */
function exactlyOne(args: Obj, keys: readonly ['symbol', 'id'][number][]): { key: 'symbol' | 'id'; value: string } {
  const present = keys.filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== '');
  if (present.length !== 1) {
    throw new InvalidArgumentError(`参数 ${keys.join(' / ')} 必须且只能给一个（已给 ${present.length} 个；尚未联网）`);
  }
  const key = present[0]! as 'symbol' | 'id';
  const raw = args[key];
  if (typeof raw !== 'string') throw new InvalidArgumentError(`参数 ${key} 必须是字符串（尚未联网）`);
  const value = raw.trim();
  const pattern = key === 'id' ? /^[A-Za-z0-9._-]{1,40}$/ : /^[A-Za-z0-9._-]{1,60}$/;
  if (!pattern.test(value)) throw new InvalidArgumentError(`参数 ${key} 形状非法：${value.slice(0, 40)}（尚未联网）`);
  return { key, value };
}

function only(args: Obj, keys: string[]): void {
  const unknown = Object.keys(args).filter((k) => !keys.includes(k));
  if (unknown.length) throw new InvalidArgumentError(`未知参数：${unknown.join(', ')}（尚未联网）`);
}

// ── 400 分流：端点 + 请求身份 + 完整 JSON，三条并列 ──────────────────────────

export interface Classify400Input {
  endpoint: 'lookup-symbol' | 'lookup-id' | 'sequence-id' | 'xrefs-id' | 'xrefs-symbol';
  requestKey: string;
  contentType: string;
  /** 未经处理的完整响应体。缺失即无法核验结构，一律不归空（ENSP-02）。 */
  rawBody?: string;
  /** 兼容：仅有压平截断片段时使用，**不足以判定 not-found**。 */
  bodySnippet?: string;
}
export type FourHundredKind = 'not-found' | 'bad-request' | 'unknown';

/** snippet() 的截断上限（src/core/http.ts 的 `snippet(text, max = 300)`）。 */
export const SNIPPET_LIMIT = 300;

function mediaType(contentType: string): string {
  return contentType.split(';', 1)[0]!.trim().toLowerCase();
}

/**
 * 只有同时满足四条才判 not-found，否则一律 unknown（抛错）。
 *
 * 1. **端点绑定**：两个 not-found 形态各有唯一归属端点；`sequence`/`xrefs` 的
 *    not-found 形态**未实测**，永远不在这里归空。
 * 2. **请求身份**：正文里的符号/ID 必须逐字符等于本次请求值。
 * 3. **完整原体**：必须有 `rawBody`；只有压平截断的 `bodySnippet` 时**不判定**。
 * 4. **原体可直接解析**：对 `rawBody` 严格 `JSON.parse`。上游若在字符串里塞了
 *    非法换行等字符，`snippet()` 的空白压平会把它"洗"成合法 JSON 并命中模板
 *    （审查 ENSP-02 反例）。只有原体本身解析成功且字段值完全相等，才算查无。
 */
export function classify400(input: Classify400Input): FourHundredKind {
  const { endpoint, requestKey, contentType, rawBody } = input;
  const isJson = mediaType(contentType) === 'application/json';
  if (!isJson) return 'unknown';

  // 参数错的识别不依赖归空判定，可用压平片段（它只会导致保守，不会误判为空）。
  const coarse = (rawBody ?? input.bodySnippet ?? '').replace(/\s+/g, ' ');
  const looksParameterError = coarse.includes('Please rerun') || coarse.includes('multiple_sequences');

  // 无原体 → 无法核验结构，绝不归空。
  if (rawBody === undefined) return looksParameterError ? 'bad-request' : 'unknown';
  if (rawBody.length >= SNIPPET_LIMIT && !looksLikelyCompleteJson(rawBody)) return 'unknown';

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // 原体本身不是合法 JSON（含被压平后才合法的情况）：保守抛错。
    return looksParameterError ? 'bad-request' : 'unknown';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
  const errorText = (parsed as Record<string, unknown>).error;
  if (typeof errorText !== 'string') return 'unknown';
  if (looksParameterError) return 'bad-request';
  const expected = endpoint === 'lookup-symbol'
    ? `No valid lookup found for symbol ${requestKey}`
    : endpoint === 'lookup-id'
      ? `ID '${requestKey}' not found`
      : null;
  return expected !== null && errorText === expected ? 'not-found' : 'unknown';
}

/** 原体是否像一个完整 JSON 对象（仅用于避免对明显半截的原文做解析尝试）。 */
function looksLikelyCompleteJson(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith('{') && t.endsWith('}');
}

/**
 * 从错误里取**可判定**的响应原体。
 *
 * 公共层目前只提供 `snippet(body)`（压平空白 + 截断 300）。审查 ENSP-02 已证明
 * 压平会制造假阳：原体里含非法换行的 JSON 会被洗成合法 JSON 并命中查无模板。
 * 因此本函数**只接受真正的原体**，并且：
 *   - `rawBody` 字段不存在 → undefined；
 *   - **`rawBodyTruncated === true` → undefined**（负责人规格：截断体不得参与判定）。
 *     不能只靠"截断后 JSON 解析失败"侥幸兜住——那只在截断点恰好破坏语法时成立。
 * 需要代码改动者在 `UpstreamError.meta` 增加 `rawBody`（≤4 KB）与 `rawBodyTruncated`。
 */
function rawBodyOf(error: UpstreamError): string | undefined {
  const meta = error.meta as unknown as { rawBody?: unknown; rawBodyTruncated?: unknown };
  if (meta.rawBodyTruncated === true) return undefined;
  return typeof meta.rawBody === 'string' ? meta.rawBody : undefined;
}

/**
 * 非 not-found 的错误转成契约要求的表述；未知形态一律抛，绝不转空结果。
 * 调用方（fetchClassified）已先处理 not-found，这里不再重复分流。
 */
function rethrow(error: unknown, input: Classify400Input): never {
  if (!(error instanceof UpstreamError)) throw error;
  const status = error.meta.status;
  if (status === 400) {
    const kind = classify400({
      ...input,
      contentType: error.meta.contentType ?? '',
      rawBody: rawBodyOf(error),
      bodySnippet: error.meta.bodySnippet ?? '',
    });
    throw new UpstreamError(
      kind === 'bad-request'
        ? '上游以 400 拒绝本次参数（不是“查无”）；本工具不把参数错误当成没有该基因'
        : '上游返回 400，但缺少可核验的响应原体或形态未实测，无法判定是否为查无；拒绝当作空结果',
      { url: error.meta.url, request: error.meta.request, status, attempts: error.meta.attempts },
    );
  }
  if (status !== undefined && status >= 500) {
    throw new UpstreamError(
      `本次请求失败（HTTP ${status}，已重试 ${Math.max(0, (error.meta.attempts ?? 1) - 1)} 次）；`
      + '单次失败不构成对该端点或本源状态的判断，请稍后重试',
      { url: error.meta.url, request: error.meta.request, status, attempts: error.meta.attempts },
    );
  }
  throw error;
}

interface Prepared { url: string; sourceName: string; request: string }

type Fetched =
  | { kind: 'ok'; res: HttpResult; prepared: Prepared }
  | { kind: 'not-found'; prepared: Prepared; status: number; durationMs: number };

/** 取一次数据；not-found 表示上游明确判未找到（合法空），耗时由本地观测。 */
async function fetchClassified(
  ctx: ToolContext, url: string, input: Omit<Classify400Input, 'contentType' | 'bodySnippet'>,
): Promise<Fetched> {
  const prepared = prepareRequest({ url, sourceName: manifest.displayName });
  const started = Date.now();
  try {
    const res = await fetchPrepared(ctx, prepared);
    return { kind: 'ok', res, prepared };
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    const status = error.meta.status;
    const kind = status === 400
      ? classify400({ ...input, contentType: error.meta.contentType ?? '',
          rawBody: rawBodyOf(error), bodySnippet: error.meta.bodySnippet ?? '' })
      : null;
    if (kind === 'not-found') {
      return { kind: 'not-found', prepared, status: 400, durationMs: Date.now() - started };
    }
    rethrow(error, { ...input, contentType: error.meta.contentType ?? '', rawBody: rawBodyOf(error),
      bodySnippet: error.meta.bodySnippet ?? '' });
  }
}

function speciesOf(data: Obj, url: string): SpeciesId {
  const raw = data.species;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new UpstreamShapeError('响应未给出对象所属物种，无法确认是否在白名单内——拒绝放行', { url });
  }
  const id = raw.trim();
  if (!Object.hasOwn(SPECIES, id)) {
    throw new UpstreamShapeError(
      `对象所属物种 ${id} 不在白名单内（该 REST 跨分区，可能返回非植物对象）——拒绝展示`,
      { url },
    );
  }
  return id as SpeciesId;
}

// ── 工具 ────────────────────────────────────────────────────────────────

export const lookupGene: ToolDefinition = {
  name: 'ensemblplants_lookup_gene',
  description:
    '在 Ensembl Plants 按基因符号或基因 ID 定位单个植物基因，返回其 ID、符号、生物类型、组装版本、染色体位置与描述。'
    + '当用户给出拟南芥/水稻/小麦/玉米的基因名（如 FT、Os01g0100100）或 Ensembl 基因 ID 并想知道“它是什么、在哪”时用它。'
    + '只支持已实测的四个物种；其他物种与人类等非植物对象会被拒绝。'
    + '**基因 ID 是分代次的**：已实测旧编号 `Zm00001d027624`（B73 v4）在本源查无，玉米当前组装为 NAM-5.0（`Zm00001eb…`）；'
    + '旧编号可能因代次差异不可查，但本工具不据此判定整类编号。'
    + '不支持批量查询（一次一个基因），也不返回序列、外链 ID 或区间内基因。',
  parameters: {
    type: 'object',
    properties: {
      species: speciesSchema,
      symbol: { type: 'string', description: '基因符号，例如 FT、VRN1；与 id 二选一' },
      id: { type: 'string', description: 'Ensembl 基因 ID，例如 AT1G65480、Zm00001eb000010；与 symbol 二选一' },
    },
    required: ['species'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    only(args, ['species', 'symbol', 'id']);
    const species = requireSpeciesId(args);
    const pick = exactlyOne(args, ['symbol', 'id']);
    const endpoint = pick.key === 'symbol' ? 'lookup-symbol' : 'lookup-id';
    const url = pick.key === 'symbol'
      ? `${manifest.apiBase}/lookup/symbol/${species}/${encodeURIComponent(pick.value)}?content-type=application/json`
      : `${manifest.apiBase}/lookup/id/${encodeURIComponent(pick.value)}?content-type=application/json;species=${species}`;

    const got = await fetchClassified(ctx, url, { endpoint, requestKey: pick.value });
    if (got.kind === 'not-found') {
      // ENSP-06：查无必须带当前组装名；旧代次编号要给出更强的提示。
      const known = SPECIES[species];
      const stale = STALE_ID_HINTS.find((h) => h.test(pick.value, species));
      return finishResult({
        body: [
          `Ensembl Plants 未找到 ${pick.key === 'symbol' ? `符号「${pick.value}」` : `ID「${pick.value}」`}（物种 ${known.label}）。`,
          `本源当前该物种的组装是 **${known.assembly}**；基因 ID 分代次，其他组装/注释版本的编号可能查不到。`,
          ...(stale ? [`注意：${stale.note}，请换用 NAM-5.0 的 Zm00001eb… 编号后重试。`] : []),
          `${NOT_FOUND_NOTE}。`,
        ].join('\n'),
        res: { data: null, url: got.prepared.url, status: got.status, durationMs: got.durationMs, attempts: 1 },
        prepared: got.prepared, sourceId: manifest.id,
        raw: { species, assembly: known.assembly, query: { [pick.key]: pick.value }, found: false,
          stale_id_hint: stale ? stale.note : undefined },
        extra: `${VERSION}；上游以 HTTP 400 表达“未找到”，未找到不等于该基因不存在`,
      });
    }
    const { res, prepared } = got;
    const data = obj(res.data, prepared.url, 'lookup 响应');
    const echoed = speciesOf(data, prepared.url);
    if (echoed !== species) {
      throw new UpstreamShapeError(`响应物种 ${echoed} 与请求物种 ${species} 不一致——身份不符，拒绝展示`, { url: prepared.url });
    }
    if (!text(data.id, prepared.url, 'id', 60)) throw new UpstreamShapeError('id 缺失', { url: prepared.url });
    const id = text(data.id, prepared.url, 'id', 60);
    // 符号请求也核验身份：符号端点必须回显同一 symbols 值，避免上游串号。
    if (pick.key === 'id') {
      if (id !== pick.value) {
        throw new UpstreamShapeError(`响应 id ${id} 与请求 ID ${pick.value} 不一致——身份不符`, { url: prepared.url });
      }
    } else if ((optText(data.display_name) ?? '').toLowerCase() !== pick.value.toLowerCase()) {
      // 大小写不构成身份差异（上游符号多为大写），但不能容忍别的基因回显。
      throw new UpstreamShapeError(
        `响应符号 ${optText(data.display_name) ?? '(缺)'} 与请求符号 ${pick.value} 不一致——身份不符`,
        { url: prepared.url },
      );
    }
    const start = position(data.start, prepared.url, 'start');
    const end = position(data.end, prepared.url, 'end');
    if (end < start) throw new UpstreamShapeError('end 小于 start，坐标漂移', { url: prepared.url });
    const region = text(data.seq_region_name, prepared.url, 'seq_region_name', 40);
    const assembly = text(data.assembly_name, prepared.url, 'assembly_name', 60);
    const known = SPECIES[species];
    // ENSP-06：组装名进正文（响应值 + 该物种当前组装），因 ID 是分代次的。
    const assemblyLine = assembly === known.assembly
      ? known.assembly
      : `${assembly}（本仓实测该物种当前组装为 ${known.assembly}）`;
    const body = [
      `${id}｜${optText(data.display_name) ?? '-'}（物种 ${known.label}）`,
      renderFields([
        ['符号', optText(data.display_name)],
        ['生物类型', optText(data.biotype)],
        ['对象类型', optText(data.object_type)],
        ['组装版本', assemblyLine],
        ['位置', `${region}:${start}-${end}`],
        ['链方向', data.strand === 1 ? '+' : data.strand === -1 ? '-' : undefined],
        ['来源', optText(data.source)],
        ['描述', optText(data.description)],
      ]),
    ].join('\n');
    if (utf8Bytes(body) > MAX_BODY_BYTES) throw new InvalidArgumentError('lookup 正文超过 1408 UTF-8 字节，拒绝交给统一截断');
    return finishResult({
      body, res, prepared, sourceId: manifest.id, extra: versionExtra(),
      raw: { species, species_label: known.label, id, symbol: optText(data.display_name),
        biotype: optText(data.biotype), assembly_name: assembly, expected_assembly: known.assembly,
        seq_region_name: region, start, end,
        strand: data.strand === 1 ? 1 : data.strand === -1 ? -1 : undefined,
        description: optText(data.description), found: true },
    });
  },
};

/**
 * ENSP-01 两步核验：`/sequence/id` 与 `/xrefs/id` 响应**实测均不含 `species`**，
 * 因此必须先 `/lookup/id` 核验该 ID 的物种，再取数据。
 * 两次请求的完整出处都要进尾注——用户看到两次请求就不能只看到一处出处。
 */
async function verifySpeciesById(ctx: ToolContext, species: SpeciesId, id: string): Promise<{
  lookupRequest: string; status: number; durationMs: number; at: string; assembly: string;
}> {
  const url = `${manifest.apiBase}/lookup/id/${encodeURIComponent(id)}?content-type=application/json;species=${species}`;
  const prepared = prepareRequest({ url, sourceName: manifest.displayName });
  const started = Date.now();
  // 查询时刻在**发起前**取，与主请求的 at 同口径；缺它用户看到两条出处却只能复现一条。
  const at = new Date().toISOString();
  let res: HttpResult;
  try {
    res = await fetchPrepared(ctx, prepared);
  } catch (error) {
    if (error instanceof UpstreamError) {
      const kind = error.meta.status === 400
        ? classify400({ endpoint: 'lookup-id', requestKey: id, contentType: error.meta.contentType ?? '',
            rawBody: rawBodyOf(error), bodySnippet: error.meta.bodySnippet ?? '' })
        : null;
      if (kind === 'not-found') {
        throw new UpstreamError(
          `该 ID「${id}」在物种 ${species} 下未找到，无法核验物种，因此不查询目标端点。${NOT_FOUND_NOTE}`,
          { url: prepared.url, request: prepared.request, status: 400 },
        );
      }
      throw new UpstreamError('物种核验请求失败，未能确认对象物种，拒绝继续查询目标端点', {
        url: prepared.url, request: prepared.request, status: error.meta.status, attempts: error.meta.attempts,
      });
    }
    throw error;
  }
  const data = obj(res.data, prepared.url, '物种核验响应');
  const echoed = speciesOf(data, prepared.url);
  if (echoed !== species) {
    throw new UpstreamShapeError(`物种核验：响应物种 ${echoed} 与请求物种 ${species} 不一致——拒绝继续`, { url: prepared.url });
  }
  const echoedId = text(data.id, prepared.url, 'id', 60);
  if (echoedId !== id) {
    throw new UpstreamShapeError(`物种核验：响应 id ${echoedId} 与请求 ID ${id} 不一致——拒绝继续`, { url: prepared.url });
  }
  return { lookupRequest: prepared.request, status: res.status,
    durationMs: Date.now() - started, at,
    assembly: text(data.assembly_name, prepared.url, 'assembly_name', 60) };
}

/** 序列字符集校验：DNA 只有 ACGTN 等；蛋白含 20 种氨基酸与终止符。 */
function assertAlphabet(seq: string, kind: 'dna' | 'protein', url: string): void {
  const dna = /^[ACGTRYSWKMBDHVN]+$/i;
  const protein = /^[ACDEFGHIKLMNPQRSTVWYBXZJUO*]+$/i;
  const target = kind === 'dna' ? dna : protein;
  if (!target.test(seq)) throw new UpstreamShapeError(`序列含非 ${kind} 字符，结构漂移`, { url });
}

interface SeqRecord { id: string; molecule: string; seq: string; /** 原始长度，固定不变，避免截断后口径漂移 */ length: number }

export const sequence: ToolDefinition = {
  name: 'ensemblplants_sequence',
  description:
    '按 Ensembl 基因 ID 取该基因的基因组序列（genomic，单位 bp）或蛋白序列（protein，单位 aa）。'
    + '当用户要“这个基因的序列/蛋白序列/翻译产物”时用它。'
    + '**先查 lookup 核验物种再取序列**，因此每次调用会发两次上游请求，两处出处都会列出。'
    + '一次可能返回多条第转录本序列（实测一个基因回 2 条），**逐条列出、绝不拼接**，最多展示 3 条。'
    + '序列超过正文预算时只展示前缀，并会同时给出**完整长度、展示区间、已截断**三项。'
    + '只支持 genomic 与 protein 两种类型（**cdna/cds 未开放**）；只覆盖已实测四物种；不接区间取序列。',
  parameters: {
    type: 'object',
    properties: {
      species: speciesSchema,
      id: { type: 'string', description: 'Ensembl 基因 ID，例如 AT1G65480；不是转录本 ID' },
      type: {
        type: 'string', enum: ['genomic', 'protein'],
        default: 'genomic',
        description: 'genomic=基因组序列（bp）；protein=蛋白序列（aa）。cdna/cds 未开放',
      },
    },
    required: ['species', 'id'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    only(args, ['species', 'id', 'type']);
    const species = requireSpeciesId(args);
    const id = exactlyOne(args, ['id', 'symbol']).value;
    const type = args.type === undefined ? 'genomic' : args.type;
    if (type !== 'genomic' && type !== 'protein') {
      throw new InvalidArgumentError('type 只接受 genomic 或 protein；cdna/cds 未开放（尚未联网）');
    }
    const verified = await verifySpeciesById(ctx, species, id);

    const url = type === 'genomic'
      ? `${manifest.apiBase}/sequence/id/${encodeURIComponent(id)}?type=genomic;content-type=application/json`
      : `${manifest.apiBase}/sequence/id/${encodeURIComponent(id)}?type=protein;multiple_sequences=1;content-type=application/json`;
    const got = await fetchClassified(ctx, url, { endpoint: 'sequence-id', requestKey: id });
    if (got.kind === 'not-found') {
      throw new UpstreamError('序列端点返回未找到，但该形态未经实测，不能作为合法空结果', { url });
    }
    const { res, prepared } = got;

    const raw = res.data;
    // **两种顶层形态**：genomic 回对象，protein&multiple_sequences=1 回数组（实测）。
    // 先 Array.isArray 再分支，只按一种写另一种必崩。
    const list: unknown[] = Array.isArray(raw) ? raw : [raw];
    if (list.length === 0) throw new UpstreamShapeError('序列响应为空数组，结构漂移', { url: prepared.url });

    /**
     * 每条序列的**身份绑定**（负责人 2026-10-30 定）。
     *
     * 转录本条目里没有 `species`，物种只能由第 1 步对基因 ID 确认——这是**已知残余风险**，
     * 不得写成"逐条物种核验"。但**身份可以也必须逐条绑定**：
     *   1. `query` 字段（实测 = 请求的基因 ID）必须等于本次请求 ID；
     *   2. 条目 `id` 必须是该基因的转录本：等于请求 ID 或 `<请求ID>.<数字>`；
     * 不满足即整次报错——不允许混入别的基因的转录本。**不按 ID 前缀猜归属**。
     */
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const transcriptPattern = new RegExp(`^${escapedId}(?:\\.\\d{1,3})?$`);
    const seenIds = new Set<string>();
    list.forEach((item, index) => {
      const r = obj(item, prepared.url, '序列记录');
      if (!Object.hasOwn(r, 'query')) {
        throw new UpstreamShapeError(`第 ${index + 1} 条序列缺 query 字段，无法做身份绑定——拒绝展示`, { url: prepared.url });
      }
      const query = optText(r.query);
      if (query !== id) {
        throw new UpstreamShapeError(
          `第 ${index + 1} 条序列的 query=${query ?? '(空)'} 与请求基因 ID ${id} 不符——身份不符，拒绝展示`,
          { url: prepared.url },
        );
      }
      const recordId = text(r.id, prepared.url, 'id', 60);
      if (!transcriptPattern.test(recordId)) {
        throw new UpstreamShapeError(
          `第 ${index + 1} 条序列 id=${recordId} 不属于基因 ${id} 的转录本——身份不符，拒绝展示`,
          { url: prepared.url },
        );
      }
      // 条目间不得重复：重复 ID 会让"共 N 条"和多条展示都失真。
      if (seenIds.has(recordId)) {
        throw new UpstreamShapeError(`第 ${index + 1} 条序列 id=${recordId} 与前序条目重复——拒绝展示`, { url: prepared.url });
      }
      seenIds.add(recordId);
    });
    // 长度口径：上游不提供自报长度字段（实测键只有 id/molecule/seq/version/desc/query），
    // 因此长度只能取 seq 的实际字符数，并在正文标明"按序列字符数计"，不假装与上游字段核对过。

    const records: SeqRecord[] = list.map((item) => {
      const r = obj(item, prepared.url, '序列记录');
      const seqText = r.seq;
      if (typeof seqText !== 'string' || !seqText) throw new UpstreamShapeError('序列缺失或不是非空字符串', { url: prepared.url });
      const molecule = text(r.molecule, prepared.url, 'molecule', 20).toLowerCase();
      assertAlphabet(seqText, molecule === 'protein' ? 'protein' : 'dna', prepared.url);
      return { id: text(r.id, prepared.url, 'id', 60), molecule, seq: seqText, length: seqText.length };
    });
    const expectMolecule = type === 'genomic' ? 'dna' : 'protein';
    const wrong = records.find((r) => r.molecule !== expectMolecule);
    if (wrong) {
      throw new UpstreamShapeError(
        `请求 ${type} 但响应 molecule=${wrong.molecule}（期望 ${expectMolecule}）——单位无法确认，拒绝展示`,
        { url: prepared.url },
      );
    }
    // 与物种核验得到的组装名交叉：仅 genomic 的 desc 带组装名，转录本层 desc 实测为 null。
    const unit = type === 'genomic' ? 'bp' : 'aa';

    const MAX_SHOWN = 3;
    /** 每条标题行的近似开销（含换行），用于字节闸保守预留。 */
    const PER_RECORD_OVERHEAD = 110;
    const candidates = records.slice(0, MAX_SHOWN);

    /**
     * **条数口径（负责人 2026-10-30 P1）**：`shown` 只能等于**实际渲染出来的条目数**，
     * 不许用"打算展示的条数"或上游条数。
     *
     * 旧实现取 `shownRecords.length`（= 3），但字节闸把后两条挤成 0 字节时仍照报
     * `shown=3、omitted=0`——用户看到"3 条全给了"，实际只拿到 1 条，且没有任何提示。
     * 那是**谎报条数**，比截断严重。
     *
     * 现在：只有真正打进正文的条目才计数，未打进的一律并入 `omitted`，
     * 并满足恒等式 `shown + omitted === total_records`。
     */
    const build = (shrink = 1): { text: string; perRecord: number[]; rendered: number } => {
      const perRecord: number[] = [];
      const renderedLines: string[] = [];
      let rendered = 0;
      const head = [
        `${id}｜${type}（${unit}）｜共 ${records.length} 条序列`,
        `物种归属：由第 1 步 lookup/id 对基因 ID ${id} 确认为 ${species}；组装 ${verified.assembly}。`,
        '注：序列接口不含 species 字段，转录本条目的物种归属依赖上游一致性，属已知残余风险；长度按 seq 字符数计。',
      ];
      let used = utf8Bytes(head.join('\n')) + 200;
      for (const r of candidates) {
        const available = Math.floor((MAX_BODY_BYTES - used - PER_RECORD_OVERHEAD - 300) * shrink);
        // 放不下完整一行的空间：这条不渲染，计入 omitted（绝不 push(0) 后仍算它已展示）。
        if (available <= 0) break;
        const take = Math.max(0, Math.min(r.length, available));
        if (take <= 0) break;
        perRecord.push(take);
        rendered += 1;
        const truncated = take < r.length;
        const label = `${rendered}. ${r.id}｜共 ${r.length} ${unit}｜第 1–${take} ${unit}`
          + (truncated ? '｜**已截断，非完整序列**' : '（完整序列）');
        renderedLines.push('', label, r.seq.slice(0, take));
        used += PER_RECORD_OVERHEAD + take;
      }
      const omittedCount = records.length - rendered;
      const out = [...head];
      if (rendered === 0) {
        out.push('', '⚠️ 正文预算不足以渲染任何一条完整条目；请按单个转录本 ID 分别查询。');
      } else if (omittedCount > 0) {
        out.push('', `（本次正文展示 ${rendered} 条，另有 ${omittedCount} 条未展示；请按单个转录本 ID 查询）`);
      }
      out.push(...renderedLines, '', '本工具不拼接多条序列。');
      return { text: out.join('\n'), perRecord, rendered };
    };
    let built = build();
    if (utf8Bytes(built.text) > MAX_BODY_BYTES) {
      // 极端情况（标题异常长）：只收缩展示字节，不动 length 口径。
      built = build(0.5);
    }
    const body = built.text;
    if (utf8Bytes(body) > MAX_BODY_BYTES) {
      throw new InvalidArgumentError('序列正文超过 1408 UTF-8 字节，拒绝交给统一截断');
    }
    /**
     * **两层校验（负责人 2026-10-30）**：
     *
     * 内层 `shown + omitted === total` 只验两个**自报数字**相加——两个数一起错时等式照样成立，
     * 那正是 `shown=3/omitted=0` 那次的翻版（用同一份错误数据自洽校验）。所以必须再加一层：
     * **从最终正文里数出实际条目数**，与 `shown` 比对。
     *
     * 正文条目标题形态：`<序号>. <转录本ID>｜共 <N> <bp|aa>｜…`
     */
    const countRenderedEntries = (text: string): number =>
      text.split('\n').filter((l) => /^\d+\. \S+｜共 \d+ (bp|aa)｜/.test(l)).length;
    const shownCount = built.rendered;
    const omittedCount = records.length - shownCount;
    const inBody = countRenderedEntries(body);
    if (shownCount !== inBody) {
      throw new UpstreamShapeError(
        `序列正文实际渲染 ${inBody} 条，与报告的 shown=${shownCount} 不一致——拒绝返回谎报条数的结果`,
        { url: prepared.url },
      );
    }
    if (shownCount + omittedCount !== records.length) {
      throw new UpstreamShapeError('序列条数恒等式不成立（shown + omitted ≠ 上游返回条数），拒绝返回不可信计数', { url: prepared.url });
    }
    if (shownCount !== built.perRecord.length) {
      throw new UpstreamShapeError('序列计数与实际渲染条数不一致，拒绝返回谎报条数的结果', { url: prepared.url });
    }
    return finishResult({
      body, res, prepared, sourceId: manifest.id,
      extra: `${VERSION}；前置物种核验请求=${verified.lookupRequest}（HTTP ${verified.status}，${verified.durationMs} ms，查询时刻 ${verified.at}）；`
        + `响应体字节数与序列长度是两个量（本条示例：响应字节数 ≠ 碱基数）`,
      raw: { species, requested_id: id, type, unit, assembly: verified.assembly,
        total_records: records.length, shown: shownCount, omitted: omittedCount,
        lookup_request: verified.lookupRequest,
        records: candidates.slice(0, shownCount).map((r, i) => ({ id: r.id, molecule: r.molecule, length: r.length,
          shown_length: built.perRecord[i] ?? 0, truncated: (built.perRecord[i] ?? 0) < r.length,
          sequence: r.seq.slice(0, built.perRecord[i] ?? 0) })) },
    });
  },
};

export const xrefs: ToolDefinition = {
  name: 'ensemblplants_xrefs',
  description:
    '查一个 Ensembl 植物基因在其它数据库（TAIR、EntrezGene、UniProt、ArrayExpress 等）里的对应记录，用于跨库跳转。'
    + '当用户问“这个基因在 TAIR/NCBI 里叫什么”时用它。'
    + '**先查 lookup 核验物种再取映射**（xrefs 接口本身既无物种字段也无组装名），每次调用发两次上游请求，两处出处都会列出。'
    + '实测一个基因返回 9 条映射、2,030 B 超正文预算，因此只展示前若干条并报总数与省略数，不静默截断。'
    + '只覆盖已实测四物种；不按数据库过滤；不是序列或区间查询。',
  parameters: {
    type: 'object',
    properties: {
      species: speciesSchema,
      id: { type: 'string', description: 'Ensembl 基因 ID，例如 AT1G65480；与 symbol 二选一' },
      symbol: { type: 'string', description: '基因符号，例如 FT；与 id 二选一' },
    },
    required: ['species'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    only(args, ['species', 'id', 'symbol']);
    const species = requireSpeciesId(args);
    const pick = exactlyOne(args, ['symbol', 'id']);
    // 符号查询没有「响应侧物种」可比，因此统一用 lookup/id 路径核验需要先有 ID；
    // symbol 情形改为 lookup/symbol 核验（同一 ID 空间由响应 id 回显对齐）。
    const verified = pick.key === 'id'
      ? await verifySpeciesById(ctx, species, pick.value)
      : await (async () => {
        const url = `${manifest.apiBase}/lookup/symbol/${species}/${encodeURIComponent(pick.value)}?content-type=application/json`;
        const prepared = prepareRequest({ url, sourceName: manifest.displayName });
        const started = Date.now();
        const at = new Date().toISOString();
        let res: HttpResult;
        try {
          res = await fetchPrepared(ctx, prepared);
        } catch (error) {
          if (error instanceof UpstreamError) {
            throw new UpstreamError('符号核验请求失败，未能确认对象物种，拒绝继续查询映射', {
              url: prepared.url, request: prepared.request, status: error.meta.status, attempts: error.meta.attempts,
            });
          }
          throw error;
        }
        const data = obj(res.data, prepared.url, '符号核验响应');
        const echoed = speciesOf(data, prepared.url);
        if (echoed !== species) {
          throw new UpstreamShapeError(`符号核验：响应物种 ${echoed} 与请求物种 ${species} 不一致——拒绝继续`, { url: prepared.url });
        }
        const echoedSymbol = (optText(data.display_name) ?? '').toLowerCase();
        if (echoedSymbol !== pick.value.toLowerCase()) {
          throw new UpstreamShapeError(`符号核验：响应符号与请求不符——拒绝继续`, { url: prepared.url });
        }
        return { lookupRequest: prepared.request, status: res.status, durationMs: Date.now() - started, at,
          assembly: text(data.assembly_name, prepared.url, 'assembly_name', 60) };
      })();

    const url = pick.key === 'id'
      ? `${manifest.apiBase}/xrefs/id/${encodeURIComponent(pick.value)}?content-type=application/json`
      : `${manifest.apiBase}/xrefs/symbol/${species}/${encodeURIComponent(pick.value)}?content-type=application/json`;
    const got = await fetchClassified(ctx, url, {
      endpoint: pick.key === 'id' ? 'xrefs-id' : 'xrefs-symbol', requestKey: pick.value,
    });
    if (got.kind === 'not-found') {
      throw new UpstreamError('映射端点返回未找到，但该形态未经实测，不能作为合法空结果', { url });
    }
    const { res, prepared } = got;
    if (!Array.isArray(res.data)) throw new UpstreamShapeError('映射响应不是数组，结构漂移', { url: prepared.url });
    const items = res.data.map((item) => {
      const r = obj(item, prepared.url, '映射记录');
      return {
        dbname: text(r.dbname, prepared.url, 'dbname', 40),
        display_id: text(r.display_id, prepared.url, 'display_id', 60),
        primary_id: optText(r.primary_id),
        description: (optText(r.description) ?? '').slice(0, 80) || undefined,
      };
    });
    if (items.length === 0) {
      return finishResult({
        body: `${pick.key === 'id' ? `ID「${pick.value}」` : `符号「${pick.value}」`}在 Ensembl 未返回任何跨库映射（空数组）。\n不代表该基因没有对应记录，仅表示本源本次无映射。`,
        res, prepared, sourceId: manifest.id, raw: { species, query: { [pick.key]: pick.value }, total: 0, shown: 0, xrefs: [] },
        extra: `${VERSION}；前置物种核验请求=${verified.lookupRequest}（HTTP ${verified.status}，${verified.durationMs} ms，查询时刻 ${verified.at}）`,
      });
    }
    const rows: string[][] = items.map((r) => [r.dbname, r.display_id, r.primary_id ?? '-', r.description ?? '-']);
    const render = (shown: number): string => [
      `${pick.key === 'id' ? `ID「${pick.value}」` : `符号「${pick.value}」`}｜共 ${items.length} 条跨库映射，展示 ${shown} 条${shown < items.length ? `，另有 ${items.length - shown} 条未展示` : ''}。`,
      `物种核验：${species}｜组装 ${verified.assembly}；映射接口本身无物种与组装字段。`,
      renderTable(['数据库', 'display_id', 'primary_id', '描述'], rows.slice(0, shown), { maxRows: shown, maxCell: 40 }),
    ].join('\n');
    let shown = Math.min(items.length, 10);
    while (shown > 0 && utf8Bytes(render(shown)) > MAX_BODY_BYTES) shown -= 1;
    const body = render(shown);
    if (utf8Bytes(body) > MAX_BODY_BYTES) throw new InvalidArgumentError('映射正文超过 1408 UTF-8 字节，拒绝交给统一截断');

    /**
     * **ENSP-11 计数口径**（与 `sequence` 同规格）：`shown` 只能等于**实际渲染出来的条数**，
     * `shown + omitted === total` 恒等式必须成立；不成立即抛错，不返回不可信计数。
     *
     * 表格数据行数从**最终正文**数出来，而不是复用 `shown` 变量——
     * 那样等于用结论证明结论。两者不一致即说明渲染与报告已经脱节。
     */
    const tableRowCount = (text: string): number =>
      Math.max(0, text.split('\n').filter((l) => l.trim().startsWith('|')).length - 2);
    const renderedRows = tableRowCount(body);
    const omitted = items.length - shown;
    if (shown + omitted !== items.length) {
      throw new UpstreamShapeError('映射条数恒等式不成立（shown + omitted ≠ 总数），拒绝返回不可信计数', { url: prepared.url });
    }
    if (renderedRows !== shown) {
      throw new UpstreamShapeError(
        `映射正文实际渲染 ${renderedRows} 行，与报告的 shown=${shown} 不一致——拒绝返回谎报条数的结果`,
        { url: prepared.url },
      );
    }
    if (shown < items.length && !body.includes('另有')) {
      throw new UpstreamShapeError('映射省略提示缺失，拒绝返回不完整且未说明的结果', { url: prepared.url });
    }

    return finishResult({
      body, res, prepared, sourceId: manifest.id,
      extra: `${VERSION}；前置物种核验请求=${verified.lookupRequest}（HTTP ${verified.status}，${verified.durationMs} ms，查询时刻 ${verified.at}）`,
      raw: { species, query: { [pick.key]: pick.value }, total: items.length, shown,
        omitted, rendered_rows: renderedRows, xrefs: items.slice(0, shown) },
    });
  },
};

export const tools: ToolDefinition[] = [lookupGene, sequence, xrefs];

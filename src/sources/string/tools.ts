import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { renderFields, renderTable, utf8Bytes } from '../../core/format.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest } from '../../core/request.js';
import type { HttpResult, ToolDefinition, ToolResult } from '../../core/types.js';
import { manifest } from './manifest.js';

type Obj = Record<string, unknown>;

/**
 * 物种白名单见下方 `SPECIES` 定义（三个独立输入值，不做等价推断）。
 */

/** 已知但**基因级互作能力未验证**的物种：仅在错误文案里用于提示，不进白名单。 */
const UNVERIFIED_TAXA: Readonly<Record<number, string>> = Object.freeze({
  4565: '小麦 Triticum aestivum',
  4577: '玉米 Zea mays',
});

/**
 * **空输出的结构化条件**（负责人 2026-10-31 第三层要求）。
 *
 * 光把文案写好不够——"写了条件"≠"条件可用"。把三要素做成必填结构，
 * 让"抽象地写换个形式"在**结构上就写不出来**：
 *   - `condition`：哪一个条件（species / required_score / limit / identifier）
 *   - `current`：**当前值**，空即失败
 *   - `adjustable`：**可选值或范围**，必须非空
 *   - `action`：用户可执行的具体动作
 *
 * 断言据此三条检查：空分支必须带 `emptyCondition`、`current` 非空、`adjustable` 非空。
 */
export interface EmptyConditionItem {
  condition: 'species' | 'required_score' | 'limit' | 'identifier';
  current: string | number;
  adjustable: Array<string | number>;
  action: string;
}

/** 构造并校验；不合法直接抛，**不允许产出无条件的空**。 */
export function buildEmptyCondition(items: EmptyConditionItem[]): EmptyConditionItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('内部不变量破坏：空输出必须至少带一个 emptyCondition 项');
  }
  for (const item of items) {
    if (!item.condition) throw new Error('内部不变量破坏：emptyCondition.condition 必填');
    const cur = item.current;
    if (cur === undefined || cur === null || (typeof cur === 'string' && cur.trim() === '')) {
      throw new Error(`内部不变量破坏：emptyCondition(${item.condition}).current 不得为空`);
    }
    if (!Array.isArray(item.adjustable) || item.adjustable.length === 0) {
      throw new Error(`内部不变量破坏：emptyCondition(${item.condition}).adjustable 不得为空`);
    }
    if (typeof item.action !== 'string' || !item.action.trim()) {
      throw new Error(`内部不变量破坏：emptyCondition(${item.condition}).action 不得为空`);
    }
  }
  return items.map((i) => ({ ...i, adjustable: [...i.adjustable] }));
}

const VERSION = manifest.versionNote ?? '版本未知';

function obj(value: unknown, url: string, what: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpstreamShapeError(`${what}不是对象`, { url });
  }
  return value as Obj;
}

function text(value: unknown, url: string, what: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim()) throw new UpstreamShapeError(`${what}缺失或不是非空字符串`, { url });
  const chars = [...value.trim()];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function optText(value: unknown, max = 200): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function position(value: unknown, url: string, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new UpstreamShapeError(`${what}不是正整数`, { url });
  }
  return value;
}

/**
 * 取数的**三态**结果：`absent`（上游没给）/ `invalid`（给了但不是合法数）/ `value`。
 *
 * 三态必须分开，因为它们对应三种完全不同的处置（负责人 2026-11-01 裁定）：
 *   - `absent`  → 显示"未提供"，**不补 0、不兜底**
 *   - `invalid` → 抛错（结构漂移/数据坏了，是故障）
 *   - `value`   → 正常使用；越界另判
 *
 * **不能用 `Number(value)` 一把梭**：`Number(null) === 0`、`Number('') === 0`、`Number([]) === 0`
 * 全都 `isFinite` 为真，于是 `score: null` 会被静默变成 `0.000`；
 * 而 `Number('abc') === NaN` 又会让"坏值"混进"缺失"，同样是掩盖。
 * 原实现两种错都犯（REV-STR-01 回放在 `698CBF…` 字节上复现）。
 */
type NumProbe =
  | { kind: 'value'; value: number }
  | { kind: 'absent' }
  | { kind: 'invalid' };

function probeNumber(value: unknown): NumProbe {
  // "上游没给这一项"——只有这几种算缺席
  if (value === null || value === undefined) return { kind: 'absent' };
  if (typeof value === 'string' && value.trim() === '') return { kind: 'absent' };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { kind: 'value', value } : { kind: 'invalid' };
  }
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? { kind: 'value', value: n } : { kind: 'invalid' };
  }
  // 布尔、数组、对象等：给了东西但不是数 → 坏值，不是缺席
  return { kind: 'invalid' };
}

/**
 * 物种白名单：**三个独立输入值，各自原样发给上游，不做任何等价推断**。
 *
 * 负责人 2026-10-31 裁定：`3702` 原样发、回显 3702；`39947` 原样发、回显 39947（有正例）；
 * `4530` 原样发、回显 39947 —— 我们只是把 4530 发出去、如实转述上游回了什么，
 * **不认定 4530 与 39947 等价，也不允许反推**。
 *
 * `expectedEcho` 记录的是**上游实测会回什么**，用于核对与如实透出。
 */
export const SPECIES = Object.freeze({
  3702: { label: '拟南芥 Arabidopsis thaliana', expectedEcho: 3702 },
  39947: { label: '水稻 Oryza sativa Japonica', expectedEcho: 39947 },
  // 4530 原样发出去；上游实测回显 39947（粳稻）。这是记录行为，不是等价认定。
  4530: { label: '水稻 Oryza sativa（上游解析为粳稻 Japonica）', expectedEcho: 39947 },
} as const);
export type TaxonId = keyof typeof SPECIES;

/**
 * 物种入参：只接受白名单内的三个值（3702 / 39947 / 4530），**原样返回、不归一**。
 *
 * `species` 必填的理由**已实测**（不是推断）：`get_string_ids?identifiers=FT` 不传 species 时
 * 上游返回 `10090.ENSMUSP00000112375`（**小鼠**），而传 `species=3702` 才返回拟南芥 `3702.Q9SXZ2`。
 * 也就是说上游会跨物种乱解析，本仓必须显式指定并回读核对。
 */
export function requireTaxon(args: Obj): number {
  const raw = args.species;
  const n = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && /^\d{1,8}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(n) || !Object.hasOwn(SPECIES, n)) {
    const hint = Number.isSafeInteger(n) && UNVERIFIED_TAXA[n]
      ? `；${UNVERIFIED_TAXA[n]} 在本仓**尚未取得该物种的有效 STRING 标识符样例**`
        + '（实测只试过 1 个基因编号，返回 200+[]），故基因级互作能力未验证——这不等于该物种无数据'
      : '';
    throw new InvalidArgumentError(
      `物种不在已实测白名单内：${typeof raw === 'string' ? raw : String(raw)}；`
      + '本工具只开放 3702（拟南芥）、39947、4530（后两者上游均返回粳稻 Japonica）'
      + hint,
    );
  }
  return n;
}

/**
 * 回读 `ncbiTaxonId` 三条判定（负责人 2026-10-31 裁定，**不做等价推断**）：
 * 1. 等于请求值 → 通过，正文照常；
 * 2. 等于该输入值的**实测回显**（仅 4530 → 39947 这一例）→ 通过，且**必须透出**"本次返回粳稻"；
 * 3. 都不是 → 拒答，不猜、不兜底。
 *
 * **只认单向**：不存在"请求 39947 → 回显 4530"的通路，因为无此实测。
 */
export function checkTaxonEcho(requested: number, echoed: number, url: string): { aliasNote?: string } {
  const entry = SPECIES[requested as TaxonId];
  if (!entry) throw new UpstreamShapeError(`请求物种 ${requested} 不在白名单内`, { url });
  if (echoed === requested) return {};
  if (echoed === entry.expectedEcho) {
    // 上游把请求值解析成了另一个 taxon：通过但**必须如实透出**，
    // 不写就等于把"水稻"静默缩成"粳稻"。判据是 `echoed !== requested`，
    // 只要上游没原样回显就说明解析发生了。
    return {
      aliasNote: `上游将 ${requested} 解析为 ${echoed}（Oryza sativa Japonica 粳稻）——`
        + `本次结果覆盖的是 ${echoed} 的范围，不是 ${requested} 字面对应的更大范围`,
    };
  }
  throw new UpstreamShapeError(
    `返回的 ncbiTaxonId=${echoed} 与请求物种 ${requested}（${entry.label}）不符——拒绝把其他物种的互作当成结果`,
    { url },
  );
}

/** `text/json` 也是上游实际返回的类型，不能只认 `application/json`。 */
function isJsonType(contentType: string | undefined): boolean {
  const media = (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();
  return media === 'application/json' || media === 'text/json';
}

/**
 * STRING 的"没有"**按端点各自成立，不许互相借用**（STR-B 阻塞项）。
 *
 * 实测锚点（其余 fixture 均为真实抓取，见各文件 `capture` 块）：
 * - `get_string_ids`：不认识的标识符 → **200 + `[]`**（2 B），**没有 Error 码**；
 *   物种不存在 → 400 + `Error:"unknown organism"`。
 * - `interaction_partners`：不认识的标识符 → **404 + `Error:"not found"`**（591 B）；
 *   可解析但无伙伴/被阈值滤空 → **200 + `[]`**（2 B）；物种不存在 → 400 + 同上码。
 *
 * 因此 `404 + "not found"` **只在 partners 侧成立**；`"nothing found"` 属于本仓不接的
 * `interactions` 端点，在伙伴端点从未观察到，**不得映射成"查无"**，只能按未识别错误处理。
 */
export type StringEndpoint = 'get_string_ids' | 'interaction_partners';

export type EmptyKind =
  | 'empty-not-resolved'      // get_string_ids 的 200 + []
  | 'empty-no-partner'        // interaction_partners 的 200 + []
  | 'error-not-found'         // 仅 partners：404 + Error:"not found"
  | 'error-unknown-organism'
  | 'error-unknown';

export function classifyEmptyOrError(
  status: number, body: unknown, rawText: string, endpoint: StringEndpoint,
): EmptyKind {
  const first = Array.isArray(body) && body.length === 1 ? body[0] : undefined;
  const errCode = first && typeof first === 'object' && !Array.isArray(first)
    ? (first as Obj).Error
    : undefined;

  if (status === 200) {
    if (!Array.isArray(body)) return 'error-unknown';
    if (body.length === 0) {
      return endpoint === 'get_string_ids' ? 'empty-not-resolved' : 'empty-no-partner';
    }
    return 'error-unknown';
  }
  if (status === 400 && errCode === 'unknown organism') return 'error-unknown-organism';
  // 只认**本端点已实测**的码；别端点的码一律按未识别处理，不跨端点借含义。
  if (endpoint === 'interaction_partners' && status === 404 && errCode === 'not found') {
    return 'error-not-found';
  }
  // 404 + 正文是 HTML 转发桩：实测该响应**不带 content-type**，isJsonType 无从判断，只能看正文
  // （camelCase 方法名得到 109 B 的 "you are being forwarded"）。
  if (status === 404 && /forwarded|<!DOCTYPE|<html/i.test(rawText)) return 'error-unknown';
  return 'error-unknown';
}

/** 清洗 ErrorMessage 里的 HTML / 实体；不把标签带进模型上下文。 */
export function cleanErrorMessage(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flat = value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return undefined;
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** 仅取短码 Error，绝不回显 ErrorMessage 原文（与 10-30 止血口径一致）。 */
function errorCodeOf(body: unknown): string | undefined {
  const first = Array.isArray(body) && body.length === 1 ? body[0] : undefined;
  if (!first || typeof first !== 'object' || Array.isArray(first)) return undefined;
  const code = (first as Obj).Error;
  return typeof code === 'string' ? code.slice(0, 60) : undefined;
}

interface Prepared { url: string; sourceName: string; request: string }

/** 取一次 JSON；**任何非 200 都按本端点的错误形态分类**，不跨端点借用含义。 */
async function fetchString(
  ctx: Parameters<NonNullable<ToolDefinition['run']>>[1],
  url: string, endpointLabel: string, endpoint: StringEndpoint,
): Promise<{ res: HttpResult; prepared: Prepared; body: unknown }> {
  const prepared = prepareRequest({ url, sourceName: manifest.displayName });
  let res: HttpResult;
  try {
    res = await fetchPrepared(ctx, prepared);
  } catch (error) {
    if (error instanceof UpstreamError) {
      const status = error.meta.status ?? 0;
      const raw = error.meta.rawBody ?? error.meta.bodySnippet ?? '';
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      const kind = classifyEmptyOrError(status, parsed, raw, endpoint);
      const code = errorCodeOf(parsed);
      if (kind === 'error-unknown-organism') {
        throw new UpstreamError(
          `上游不认识该物种（taxon 不存在）；这不是"该物种没有互作数据"。`
          + `可做的：把 species 改成 3702（拟南芥）/ 39947 / 4530 之一后重试`
          + `${code ? `（上游码：${code}）` : ''}`,
          { url: prepared.url, request: prepared.request, status, attempts: error.meta.attempts },
        );
      }
      if (kind === 'error-not-found') {
        // STR-A：这里**不再**让用户"先调 resolve_ids"——partners 自己会解析基因名，
        // 它都解析不出来时 resolve 同样解析不出来，指过去解决不了任何问题。
        throw new UpstreamError(
          `该标识符 STRING 不认识：上游对本端点返回 404${code ? `（上游码：${code}）` : ''}。`
          + '若你已用 string_resolve_ids 试过也解析不出来，说明编号形式本身有问题，'
          + '请核对编号（拟南芥 AT1G65480 / UniProt Q9SXZ2 / STRING 3702.Q9SXZ2）。'
          + '**这不是"该基因没有互作"。**',
          { url: prepared.url, request: prepared.request, status, attempts: error.meta.attempts },
        );
      }
      // 未知 404（含 HTML 转发桩）/ 其他状态：照实报，不透传上游原文。
      throw new UpstreamError(
        `${endpointLabel}返回 HTTP ${status}，形态未识别（不按上游原文透出）；`
        + '注意 STRING 方法名必须用下划线形式，camelCase 会得到 HTML 转发桩',
        { url: prepared.url, request: prepared.request, status, attempts: error.meta.attempts,
          contentType: error.meta.contentType },
      );
    }
    throw error;
  }
  return { res, prepared, body: res.data };
}

function assertJsonShape(res: HttpResult, url: string): void {
  if (!isJsonType(res.contentType)) {
    throw new UpstreamShapeError(
      `响应类型 ${res.contentType ?? '(未知)'} 不是 JSON——可能是 HTML 转发桩或代理页`,
      { url },
    );
  }
}

// ── 工具 1：ID 解析 ──────────────────────────────────────────────────────

export const resolveIds: ToolDefinition = {
  name: 'string_resolve_ids',
  description:
    '把基因名/编号解析成 STRING 的 stringId（形如 3702.Q9SXZ2），用于确认“STRING 认不认这个基因/这个物种”。'
    + '**这是可选工具，不是查互作的前置步骤**：上游 interaction_partners 本身就能解析基因名'
    + '（实测直接传 AT1G65480 返回 10 条），所以不调本工具也能查到互作。'
    + '需要它的两个场景：① 想知道某个编号会被解析成哪个 stringId；'
    + '② 查互作拿到空结果、想确认是“编号解析不出来”还是“确实没有互作”。'
    + '只支持已实测物种（拟南芥 3702、水稻 39947/4530）；小麦/玉米的基因级解析能力未验证。'
    + '不做批量转换（一次一个标识符），不返回互作关系。',
  parameters: {
    type: 'object',
    properties: {
      species: { type: 'integer', description: 'NCBI taxon ID：3702=拟南芥，39947 或 4530=水稻 Japonica（**必填**：实测不传时上游会跨物种乱解析，如 FT 被解析成小鼠 10090）' },
      identifier: { type: 'string', description: '基因名或编号，例如 AT1G65480、Q9SXZ2；一次一个' },
    },
    required: ['species', 'identifier'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const unknown = Object.keys(args).filter((k) => !['species', 'identifier'].includes(k));
    if (unknown.length) throw new InvalidArgumentError(`未知参数：${unknown.join(', ')}`);
    const taxon = requireTaxon(args);
    const identifier = args.identifier;
    if (typeof identifier !== 'string' || !identifier.trim() || identifier.trim().length > 120) {
      throw new InvalidArgumentError('identifier 必须是非空字符串（≤120 字符）');
    }
    const id = identifier.trim();
    /**
     * 这里**不再带 `limit=3`**（原先的魔数已删除）。
     *
     * 理由是实测的：`get_string_ids` 的 `limit` 在本端点未见任何效果——
     * 同一 `AT1G65480` 传 1 / 3 / 20 / 100，响应都是 743 B / 1 条，逐字节相同；
     * 换行分隔 2–3 个标识符时传 `limit=1` 也仍逐条各返回。既然它既不截断也不影响输出，
     * 带一个解释不了的魔数只会让下一个维护者以为"这里做了候选数保护"。
     * 不传 `limit` 实测同样是 200 / 743 B，行为一致。
     *
     * 本工具一次只解析**一个**标识符（批量属另一意图，未接），这是有意的范围限制。
     */
    const url = `${manifest.apiBase}/json/get_string_ids?identifiers=${encodeURIComponent(id)}&species=${taxon}`;
    const { res, prepared } = await fetchString(ctx, url, 'STRING ID 解析', 'get_string_ids');
    assertJsonShape(res, prepared.url);

    const list = Array.isArray(res.data) ? res.data : null;
    if (list === null) throw new UpstreamShapeError('get_string_ids 响应不是数组，结构漂移', { url: prepared.url });

    if (list.length === 0) {
      /**
       * 空必须带**用户可调整的条件 + 其当前值**（负责人 2026-10-31 判据：
       * "有条件"不等于"条件有用"——条件必须是用户能改的，否则与写"没有"无异）。
       *
       * 注意"两种可能"只**如实并列**，不假装能区分：本端点 200+[] 确实分不开。
       * 但可以给出真正能区分它们的下一步——`interaction_partners` 对本端点分不开的
       * 这两种情形给出**不同状态码**（不认识 → 404，认识但无伙伴 → 200+[]），
       * 这是实测所得（fixtures: partners-badstringid / partners-empty-valid）。
       */
      return finishResult({
        body: `**在 species=${taxon}、identifier=「${id}」的条件下**，STRING 未解析出任何标识符（上游 200 + 空数组，2 字节）。\n`
          + '⚠️ 本端点的空数组有两种可能，**本身无法区分**：①该标识符 STRING 不认识；②该物种下确实没有对应记录。\n'
          + '**这不等于“这个基因不存在”。**\n'
          + `可做的两件事：① identifier 当前为「${id}」，可换成 UniProt 编号（如 Q9SXZ2）、`
          + 'Ensembl 基因 ID 或基因符号，重新调用 string_resolve_ids；'
          + `② species 当前为 ${taxon}，可改为 3702（拟南芥）/ 39947 / 4530（后两者为粳稻），重新调用 string_resolve_ids。\n`
          + '另：若你想知道这个编号到底认不认识，直接拿它调用 string_interaction_partners——'
          + '那个端点对"不认识"返回 404、对"认识但无伙伴"返回 200+空数组，能把这处歧义分开。',
        res, prepared, sourceId: manifest.id,
        raw: { species: taxon, identifier: id, resolved: 0, records: [],
          emptyCondition: buildEmptyCondition([
            { condition: 'identifier', current: id,
              adjustable: ['UniProt 编号（如 Q9SXZ2）', 'Ensembl 基因 ID', '基因符号'],
              action: `把 identifier 从「${id}」换成上述任一形式，重新调用 string_resolve_ids` },
            { condition: 'species', current: taxon, adjustable: [3702, 39947, 4530],
              action: `把 species 从 ${taxon} 改为 3702（拟南芥）、39947 或 4530（后两者为粳稻），重新调用 string_resolve_ids` },
          ]) },
        extra: VERSION,
      });
    }

    const records = list.map((item) => {
      const r = obj(item, prepared.url, 'ID 解析记录');
      const echoedTaxon = position(r.ncbiTaxonId, prepared.url, 'ncbiTaxonId');
      return {
        stringId: text(r.stringId, prepared.url, 'stringId', 60),
        ncbiTaxonId: echoedTaxon,
        taxonName: optText(r.taxonName, 60),
        preferredName: optText(r.preferredName, 60),
        annotation: optText(r.annotation, 100),
        queryItem: optText(r.queryItem, 60),
      };
    });

    /**
     * **身份核验：返回记录必须绑定回我们请求的那个标识符**（审查 REV-STR-01 抓到的真缺陷）。
     *
     * 原先只核了物种回显、**没核 queryItem**，于是"上游返回了别的基因的解析结果"会被当成有效结果接受。
     * 实测确认上游会**逐字回显**请求值（大小写敏感）：
     *   AT1G65480 / Q9SXZ2 / 3702.Q9SXZ2 / Os01g0100100 → queryItem 与请求字面完全相同，queryIndex=0
     * 所以可以精确断言，而不是靠"长度一致"之类的软判据。
     */
    const mismatch = records.filter((r) => r.queryItem !== id);
    if (mismatch.length) {
      throw new UpstreamShapeError(
        `上游返回的解析记录与请求标识符对不上：请求「${id}」，`
        + `返回的 queryItem 为 ${mismatch.map((r) => `「${r.queryItem ?? '(缺失)'}」`).join('、')}。`
        + '拒绝把别的标识符的解析结果当成结果（不回退、不取第一条了事）',
        { url: prepared.url },
      );
    }

    // 回读核对：不在白名单别名集合内即拒答（负责人三条判定）
    const notes: string[] = [];
    for (const r of records) {
      const { aliasNote } = checkTaxonEcho(taxon, r.ncbiTaxonId, prepared.url);
      if (aliasNote && !notes.includes(aliasNote)) notes.push(aliasNote);
    }

    const body = [
      `「${id}」在物种 ${taxon} 下解析出 ${records.length} 个 STRING 标识符：`,
      ...(notes.length ? ['', ...notes.map((n) => `⚠️ ${n}`)] : []),
      '',
      renderTable(['stringId', 'preferredName', 'taxonName', 'annotation'],
        records.map((r) => [r.stringId, r.preferredName ?? '-', r.taxonName ?? '-', r.annotation ?? '-']),
        { maxRows: 3, maxCell: 40 }),
      '',
      '下一步：把 stringId 传给 string_interaction_partners 查互作伙伴。',
    ].join('\n');
    if (utf8Bytes(body) > MAX_BODY_BYTES) throw new InvalidArgumentError('ID 解析正文超过 1408 字节，拒绝交给统一截断');

    return finishResult({
      body, res, prepared, sourceId: manifest.id, extra: VERSION,
      raw: { species: taxon, identifier: id, resolved: records.length,
        alias_notes: notes, records },
    });
  },
};

// ── 工具 2：互作伙伴 ────────────────────────────────────────────────────

/** STRING ID 形态：`<taxon>.<id>`。未解析的标识符（如 AT1G65480）不匹配。 */
const STRING_ID_PATTERN = /^\d{1,8}\.[A-Za-z0-9_-]{2,40}$/;

export const interactionPartners: ToolDefinition = {
  name: 'string_interaction_partners',
  description:
    '查一个**已解析的 STRING ID**（形如 3702.Q9SXZ2）的互作伙伴，给出综合置信度 score 与主要证据通道。'
    + '当用户问“这个基因和谁互作”“有哪些实验/共表达证据”时用。'
    + '**上游会自行解析基因名**：实测直接传 AT1G65480 也能返回 10 条互作，所以“必须先解析”不是接口要求。'
    + '本仓仍要求传已解析的 stringId（如 3702.Q9SXZ2），**这是本仓策略、不是接口限制**：'
    + '一是让尾注能留下“解析到了哪个 ID”的证据，二是让空结果可解释。'
    + '传入 AT1G65480 这类原始编号会被本地拒绝（零请求），并给出去换成 ID 的具体做法；'
    + '**不会返回空列表冒充“没有互作”**。'
    + '身份核验方式：本地核对 `string_id` 的 taxon 前缀与 `species` 一致；'
    + '形状合法但实际不存在的 ID 由上游 404 明确否定（不是空数组）。'
    + '只支持已实测物种（3702 拟南芥、39947/4530 水稻 Japonica）；小麦/玉米基因级互作能力未验证。'
    + '不返回网络图（体积不可控），不做富集分析，不返回逐条证据的全文。',
  parameters: {
    type: 'object',
    properties: {
      species: { type: 'integer', description: 'NCBI taxon ID：3702=拟南芥，39947 或 4530=水稻 Japonica（**必填**：实测不传时上游会跨物种乱解析，如 FT 被解析成小鼠 10090；这是本仓策略）' },
      string_id: { type: 'string', description: 'STRING ID，形如 3702.Q9SXZ2。**上游其实也能直接解析基因名**（如 AT1G65480），本仓要求传已解析 ID 是为了让尾注留下“解析到了哪个 ID”的证据；需要把基因名换成 ID 时用 string_resolve_ids' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '上游返回条数上限（1–100，默认 20）。**1–100 是本仓策略、不是上游限制**（上游为软上限，超传不报错）；本仓仍按输出预算裁剪' },
      required_score: { type: 'integer', minimum: 0, maximum: 1000, default: 400, description: '最低综合置信度（上游刻度 0–1000，默认 400）。**必须可调**：正文会写"在 required_score ≥ N 下未发现互作"，阈值不可调时这句话无法放宽' },
    },
    required: ['species', 'string_id'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const unknown = Object.keys(args).filter(
      (k) => !['species', 'string_id', 'limit', 'required_score'].includes(k));
    if (unknown.length) throw new InvalidArgumentError(`未知参数：${unknown.join(', ')}`);
    const taxon = requireTaxon(args);
    const stringId = args.string_id;
    if (typeof stringId !== 'string' || !STRING_ID_PATTERN.test(stringId.trim())) {
      /**
       * 按 v3 §8.1 更正：**不再让用户"先调 resolve_ids"当作解释**——上游自己会解析基因名，
       * 若它都解析不出来，resolve_ids 也一样解析不出来，指过去解决不了任何问题。
       * 正确做法：说明本仓要求 ID 形式，并给出用户真正能做的事（换成解析后的 ID 或核对编号）。
       */
      throw new InvalidArgumentError(
        `string_id 不是 STRING 标识符形式（应形如 3702.Q9SXZ2），收到「${typeof stringId === 'string' ? stringId.slice(0, 40) : String(stringId)}」。`
        + '本仓要求传已解析 ID（上游本身也能解析基因名，但那样尾注无法留下解析证据）。'
        + '可做的两件事：① 用 string_resolve_ids 把基因名换成 stringId，再用返回的 3702.xxx 调用本工具；'
        + '② 若你给的就是 STRING ID，请核对是否包含 `<taxon>.` 前缀（如 3702.Q9SXZ2）。'
        + '**本工具不会返回空列表冒充“没有互作”**',
      );
    }
    const id = stringId.trim();
    // 只接受已解析 id 的物种前缀与 species 一致（含 4530→39947 的实测回显），避免串物种。
    const idTaxon = Number(id.split('.', 1)[0]);
    const expectEcho = SPECIES[taxon as TaxonId].expectedEcho;
    if (idTaxon !== taxon && idTaxon !== expectEcho) {
      throw new InvalidArgumentError(
        `string_id 的物种前缀（${idTaxon}）与 species（${taxon}）不一致；`
        + `该物种上游回显应为 ${expectEcho}。请用同一物种解析出的 stringId，避免跨物种混查`,
      );
    }

    const limit = args.limit === undefined ? 20 : args.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new InvalidArgumentError('limit 须为 1–100 的整数（本仓策略上限，非上游限制）');
    }
    // required_score 默认 400：暴露它是为了让"空"能说清条件并可放宽。
    const requiredScore = args.required_score === undefined ? 400 : args.required_score;
    if (typeof requiredScore !== 'number' || !Number.isSafeInteger(requiredScore)
      || requiredScore < 0 || requiredScore > 1000) {
      throw new InvalidArgumentError('required_score 须为 0–1000 的整数（上游刻度）');
    }

    const params = new URLSearchParams({ identifiers: id, species: String(taxon), limit: String(limit) });
    params.set('required_score', String(requiredScore));
    const url = `${manifest.apiBase}/json/interaction_partners?${params.toString()}`;
    const { res, prepared } = await fetchString(ctx, url, 'STRING 互作查询', 'interaction_partners');
    assertJsonShape(res, prepared.url);

    const list = Array.isArray(res.data) ? res.data : null;
    if (list === null) throw new UpstreamShapeError('interaction_partners 响应不是数组，结构漂移', { url: prepared.url });

    if (list.length === 0) {
      /**
       * **空必须带条件限定**（负责人 2026-10-31 定为全源通用纪律）：
       * "无伙伴"与"被阈值滤空"在上游完全同形（都是 2 B `[]`），再找样本也分不开，
       * 因为上游不给这个信息。所以不许说"该基因没有互作"，只能说
       * "在 required_score ≥ N 下未发现互作"，并给出可执行动作（降低阈值）。
       */
      return finishResult({
        body: `**在 species=${taxon}、required_score ≥ ${requiredScore}（上游刻度 0–1000）的条件下**，`
          + `「${id}」未返回任何互作伙伴（上游 200 + 空数组，2 字节）。\n`
          + '⚠️ 上游对"没有伙伴"与"全部被该阈值滤掉"返回**完全相同**的空数组，本工具无法区分。\n'
          + `**这不等于“该基因没有互作”。** 如需放宽，可把 required_score 调低（当前 ${requiredScore}，最低 0）后重查。`,
        res, prepared, sourceId: manifest.id,
        raw: { species: taxon, string_id: id, total: 0, shown: 0, partners: [],
          emptyCondition: buildEmptyCondition([
            { condition: 'required_score', current: requiredScore,
              adjustable: ['0–1000（上游刻度，越低越宽松）'],
              action: `把 required_score 从当前 ${requiredScore} 调低（例如 400 或 0）后重新调用 string_interaction_partners` },
            { condition: 'species', current: taxon, adjustable: [3702, 39947, 4530],
              action: `把 species 从 ${taxon} 改为 3702（拟南芥）、39947 或 4530（后两者为粳稻）后重新调用 string_interaction_partners` },
          ]) },
        extra: VERSION,
      });
    }

    const partners = list.map((item) => {
      const r = obj(item, prepared.url, '互作记录');
      const echoedTaxon = position(r.ncbiTaxonId, prepared.url, 'ncbiTaxonId');
      /**
       * `score` 三态处理（负责人 2026-11-01 裁定）：
       * - 缺席（null/undefined/空串）→ 显式 `undefined`，渲染成"未提供"，**不补 0**；
       * - 坏值（'abc'、NaN、数组、布尔）→ 抛错，那是漂移；
       * - 有值但越界（1.5 / -0.2）→ 抛错，同样是漂移。
       *
       * 缺席是可容忍的事实，漂移是必须报的故障——两者不许合并。
       */
      const scoreProbe = probeNumber(r.score);
      if (scoreProbe.kind === 'invalid') {
        throw new UpstreamShapeError('score 不是合法数值（结构漂移）', { url: prepared.url });
      }
      const score = scoreProbe.kind === 'value' ? scoreProbe.value : undefined;
      if (score !== undefined && (score < 0 || score > 1)) {
        throw new UpstreamShapeError('score 不在 0–1 范围内，刻度漂移', { url: prepared.url });
      }
      // 只保留主要证据通道：score + 最高的两个分通道（8 个全量不透出）
      const channels: Array<[string, number]> = [];
      for (const key of ['nscore', 'fscore', 'pscore', 'ascore', 'escore', 'dscore', 'tscore']) {
        const probe = probeNumber(r[key]);
        if (probe.kind === 'invalid') {
          throw new UpstreamShapeError(`${key} 不是合法数值（结构漂移）`, { url: prepared.url });
        }
        // 缺席或 0 都不进"主要证据"（0 表示该通道无支持，不必占用名额）
        if (probe.kind === 'value' && probe.value > 0) channels.push([key.replace('score', ''), probe.value]);
      }
      channels.sort((a, b) => b[1] - a[1]);
      return {
        selfId: text(r.stringId_A, prepared.url, 'stringId_A', 60),
        partnerId: text(r.stringId_B, prepared.url, 'stringId_B', 60),
        partnerName: optText(r.preferredName_B, 60),
        selfName: optText(r.preferredName_A, 60),
        ncbiTaxonId: echoedTaxon,
        score,
        topChannels: channels.slice(0, 2),
        channelCount: channels.length,
      };
    });

    /**
     * **身份核验：每条互作记录的 A 侧必须就是我们请求的那个 stringId**（审查 REV-STR-01 抓到的真缺陷）。
     *
     * 原先完全没有读 `stringId_A`，等于"上游给谁的数据都照收"。实测上游会逐字回显：
     *   identifiers=3702.Q9SXZ2 → stringId_A 全部为 3702.Q9SXZ2
     *   identifiers=3702.Q84JK2 → stringId_A 全部为 3702.Q84JK2
     *   identifiers=39947.A0A0P0UX28&species=4530 → stringId_A 为 39947.A0A0P0UX28（原样）
     * 故此处做精确匹配；不一致直接抛，不静默丢弃、也不只取第一条。
     */
    const wrongSelf = partners.filter((p) => p.selfId !== id);
    if (wrongSelf.length) {
      throw new UpstreamShapeError(
        `互作记录的 A 侧与请求的 string_id 不一致：请求「${id}」，`
        + `返回的 stringId_A 为 ${[...new Set(wrongSelf.map((p) => `「${p.selfId}」`))].join('、')}`
        + `（${wrongSelf.length}/${partners.length} 条不符）。拒绝把别的基因的互作当成结果`,
        { url: prepared.url },
      );
    }

    const notes: string[] = [];
    for (const p of partners) {
      const { aliasNote } = checkTaxonEcho(taxon, p.ncbiTaxonId, prepared.url);
      if (aliasNote && !notes.includes(aliasNote)) notes.push(aliasNote);
    }

    /**
     * 缺失值一律显示"未提供"，**不许用 `?? '-'` / `?? 0` 兜成具体值**（负责人 2026-11-01 裁定）。
     *
     * `'-'` 看似中性，但它和"上游给了空"、"字段不存在"混在一列里也说不清；
     * 这里用显式文字，读者一眼能区分"没有分数"与"分数是 0"。
     */
    const MISSING = '未提供';
    const renderScore = (v: number | undefined): string => (v === undefined ? MISSING : v.toFixed(3));

    const render = (shown: number): string => {
      const omitted = partners.length - shown;
      const missingCount = partners.slice(0, shown).filter((p) => p.score === undefined).length;
      const lines = [
        `${partners[0]!.selfName ?? id}（${id}，物种 ${taxon}）｜本次取回 ${partners.length} 条互作伙伴；正文展示 ${shown} 条`
        + (omitted > 0
          ? `；另有 ${omitted} 条未展示（当前 limit=${limit}，可减小 limit 或提高 required_score=${requiredScore} 后重查）`
          : ''),
        ...(notes.length ? ['', ...notes.map((n) => `⚠️ ${n}`)] : []),
        ...(missingCount > 0
          ? ['', `⚠️ 有 ${missingCount} 条记录的 score 字段上游未提供，表中显示为“${MISSING}”；`
            + `**这不等于 0 分**，也不代表没有互作`]
          : []),
        '',
        renderTable(['伙伴', 'STRING ID', 'score', '主要证据'],
          partners.slice(0, shown).map((p) => [
            p.partnerName ?? '-', p.partnerId, renderScore(p.score),
            p.topChannels.length ? p.topChannels.map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' ') : '-',
          ]),
          { maxRows: shown, maxCell: 40 }),
        '',
        '注：score 是 0–1 的综合置信度（非百分比）；“主要证据”只列最强的两个通道，完整 8 通道未透出。',
      ];
      return lines.join('\n');
    };
    let shown = Math.min(partners.length, 20);
    while (shown > 0 && utf8Bytes(render(shown)) > MAX_BODY_BYTES) shown -= 1;
    const body = render(shown);
    if (utf8Bytes(body) > MAX_BODY_BYTES) throw new InvalidArgumentError('互作正文超过 1408 字节，拒绝交给统一截断');

    return finishResult({
      body, res, prepared, sourceId: manifest.id, extra: VERSION,
      raw: { species: taxon, string_id: id, total: partners.length, shown,
        omitted: partners.length - shown, alias_notes: notes,
        partners: partners.slice(0, shown) },
    });
  },
};

export const tools: ToolDefinition[] = [resolveIds, interactionPartners];

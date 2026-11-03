import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { renderTable, utf8Bytes } from '../../core/format.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest } from '../../core/request.js';
import type { HttpResult, JsonSchema, ToolContext, ToolDefinition, ToolResult } from '../../core/types.js';
import { manifest } from './manifest.js';

type Obj = Record<string, unknown>;

/**
 * UniProt accession 的**严格**形态。
 * 为什么不能只写 `^[A-Za-z0-9]{6,10}$`：实测发现**拟南芥基因名 `AT1G65480` 正好 9 位**，
 * 会被这种宽松正则放行，然后拿基因名当 accession 去查——上游返回 400 格式错，
 * 用户看到的却像"这个基因查不到"。**本地能挡的就不该让上游挡。**
 *
 * 已核对：合法 accession（`P46290` 6 位、`Q9SXZ2` 6 位、`A0A0P0UX28` 10 位、`A0A0A0A0A0` 10 位）
 * 全部通过；`AT1G65480` / `TraesCS5A02G391700` / `Os01g0100100` 这类基因名全部被挡。
 */
const ACCESSION_PATTERN = /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/;

/** 统一的一处判断，避免两个工具各写一套。 */
function requireAccession(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidArgumentError('accession 必须是非空字符串');
  const acc = value.trim().toUpperCase();
  if (!ACCESSION_PATTERN.test(acc)) {
    throw new InvalidArgumentError(
      `accession 不是 UniProt accession 形态（收到「${value.slice(0, 30)}」）。`
      + '形如 P46290（6 位）或 A0A0P0UX28（10 位）。'
      + '**基因名不是 accession**——`AT1G65480`、`TraesCS5A02G391700` 这类请用 uniprot_search_proteins 的 gene 参数',
    );
  }
  return acc;
}

/**
 * UniProt 适配。
 *
 * 核心约束（全部来自本机实测，见 `记录/20261031-调研-UniProt契约前置.md`）：
 * 1. **`fields` 必带**：不写它 2 条结果 44,257 B（15.9 倍），`size=2` 物种查询 78,534 B。
 *    本仓请求恒定带 `fields`，**不作为用户参数暴露**——它没有研究意图上的选择价值，
 *    暴露出去只会让人传错。
 * 2. **`entryType` 必须标**：同基因多条目（reviewed / unreviewed）是常态，
 *    不标用户会拿到同一蛋白两个版本却不知道为什么。
 * 3. **`length` 是氨基酸数**，不是碱基数。正文写「氨基酸」，绝不写 bp。
 * 4. **分页是 cursor 不是 offset**；本仓不暴露翻页，只给"缩小查询"。
 */

/** 本仓恒发的字段集（实测值，全部有正例）。 */
const FIELDS = 'accession,gene_names,protein_name,length,organism_name,reviewed' as const;

/** 白名单物种：只列实测过条目数的四个。 */
const SPECIES: Readonly<Record<number, string>> = Object.freeze({
  3702: '拟南芥 Arabidopsis thaliana',
  4565: '小麦 Triticum aestivum',
  39947: '水稻 Oryza sativa',
  4577: '玉米 Zea mays',
});

const DEFAULT_SIZE = 20;
const MAX_SIZE = 100;

/**
 * `entryType` 归一化：上游给的是 `UniProtKB reviewed (Swiss-Prot)` / `UniProtKB unreviewed (TrEMBL)`。
 * 正文只写「已审 / 未审」，因为对用户来说关键就是这个区别。
 */
function entryTypeLabel(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '未提供';
  if (/reviewed \(Swiss-Prot\)/i.test(raw) && !/unreviewed/i.test(raw)) return '已审（Swiss-Prot）';
  if (/unreviewed/i.test(raw)) return '未审（TrEMBL）';
  return raw.trim().slice(0, 40);
}

function obj(value: unknown, url: string, what: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpstreamShapeError(`${what}不是对象`, { url });
  }
  return value as Obj;
}

function optStr(value: unknown, max = 120): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (!t) return undefined;
  const chars = [...t];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/**
 * 取数**三态**（与 STRING 逐字同源，负责人 2026-11-01 裁定）：
 * `absent` 上游没给 / `invalid` 给了坏值 / `value` 有效。
 *
 * **不许用 `Number()` 一把梭**：`Number(null) === 0` 且 `isFinite(0)` 为真，
 * 会把"没给"变成"零"——在本源里那就是"长度 0 氨基酸"，是硬错误。
 *
 * 本源的三处数值解析（`length`、`score` 类字段、`x-total-results`）**都走这一个函数**，
 * 只有计数头额外区分 `absent` 与 `empty`（见 `totalFrom`）。
 */
type NumProbe = { kind: 'value'; value: number } | { kind: 'absent' } | { kind: 'invalid' };

function probeNumber(value: unknown): NumProbe {
  // ① 先判"缺失/空串/纯空白" → absent，**不进 Number()**
  if (value === null || value === undefined) return { kind: 'absent' };
  if (typeof value === 'string' && value.trim() === '') return { kind: 'absent' };
  // ③ 只有真正是数字（含 0 与 '0'）才走数值
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'value', value } : { kind: 'invalid' };
  if (typeof value === 'string') {
    const n = Number(value.trim());
    // ② 非数字 → invalid（"给错了"，不是"没给"）
    return Number.isFinite(n) ? { kind: 'value', value: n } : { kind: 'invalid' };
  }
  // 布尔、数组、对象等：给了东西但不是数 → 坏值，不是缺席
  return { kind: 'invalid' };
}

/** 响应头取值（headers 大小写不保证）。 */
function header(res: HttpResult, name: string): string | undefined {
  const h = (res as { headers?: Record<string, string> }).headers;
  if (!h) return undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

/**
 * `x-total-results`：**在 `probeNumber` 之上加一档 `empty`**。
 *
 * 为什么计数头要比普通字段多一档：它区分的是"上游有没有表态"，
 *   - **absent**（头不存在）      → 上游没表态
 *   - **empty**（`""` / 全空白）  → 上游给了头却没给数，**也是没表态**，但成因不同
 *   - **`"0"`**                  → 上游明确说 0 条
 *   - **invalid**（`"abc"`/`"-1"`/`"1.5"`）→ 结构漂移，抛错
 *
 * 计数头额外要求**纯数字**：普通字段用 `Number('1.5')` 能得到 1.5，
 * 但"命中条数"是小数就说明契约变了，不能当成有效值。
 *
 * 原实现 `Number(raw.trim())` 会让 `""` 与全空白变成 **0** 且 `isSafeInteger(0)` 为真，
 * 于是"上游给了空头"被当成"上游说命中 0 条"——**又一次 `Number('') === 0`**。
 */
function totalFrom(res: HttpResult):
  | { kind: 'value'; value: number }
  | { kind: 'absent' }
  | { kind: 'empty' }
  | { kind: 'invalid' } {
  const raw = header(res, 'x-total-results');
  if (raw === undefined) return { kind: 'absent' };
  const text = raw.trim();
  // 空值单独一档：不许落到"值 0"（probeNumber 会把它判成 absent，这里要区分成因）
  if (text === '') return { kind: 'empty' };
  // 计数头只接受纯数字：'-1'、'1.5'、'1e3' 都不算
  if (!/^\d+$/.test(text)) return { kind: 'invalid' };
  /**
   * 这里**不能只靠 `probeNumber`**：它用 `Number.isFinite` 判有效，
   * 而 `Number('999999999999999999999')` = `1e+21` 仍是有限数 → 会被当成合法的"命中 1e21 条"。
   * 计数必须落在安全整数内，所以额外加 `isSafeInteger`。
   *
   * （这正是负责人要求"三处同一路径"时暴露出来的差异：`score`/`length` 用 `isFinite` 够，
   * 计数用 `isFinite` 不够。同一套骨架 + 各处必要的额外约束，不是三套实现。）
   */
  const probe = probeNumber(text);
  if (probe.kind !== 'value') return { kind: 'invalid' };
  return Number.isSafeInteger(probe.value) ? probe : { kind: 'invalid' };
}

/** 把上游 `proteinDescription` 取成一句可读名。 */
function proteinName(item: Obj): string | undefined {
  const pd = item.proteinDescription;
  if (!pd || typeof pd !== 'object') return undefined;
  const rec = (pd as Obj).recommendedName;
  if (rec && typeof rec === 'object') {
    const full = (rec as Obj).fullName;
    if (full && typeof full === 'object') {
      const v = optStr((full as Obj).value);
      if (v) return v;
    }
  }
  const sub = (pd as Obj).submissionNames;
  if (Array.isArray(sub) && sub[0] && typeof sub[0] === 'object') {
    const full = (sub[0] as Obj).fullName;
    if (full && typeof full === 'object') return optStr((full as Obj).value);
  }
  return undefined;
}

/** 基因名：`genes[].geneName.value`；取第一个，另报总数。 */
function geneNames(item: Obj): { first?: string; count: number } {
  const genes = item.genes;
  if (!Array.isArray(genes) || genes.length === 0) return { count: 0 };
  const names: string[] = [];
  for (const g of genes) {
    if (!g || typeof g !== 'object') continue;
    const gn = (g as Obj).geneName;
    if (gn && typeof gn === 'object') {
      const v = optStr((gn as Obj).value, 40);
      if (v) names.push(v);
    }
  }
  return names.length ? { first: names[0], count: names.length } : { count: 0 };
}

function speciesLabel(item: Obj): { name?: string; taxonId?: number } {
  const org = item.organism;
  if (!org || typeof org !== 'object') return {};
  const name = optStr((org as Obj).scientificName, 60);
  const t = probeNumber((org as Obj).taxonId);
  return { name, taxonId: t.kind === 'value' ? t.value : undefined };
}

/**
 * 端点类型。**"查无"这个语义只对 `entry-by-id` 成立**（审查 R11 P1）。
 *
 * 为什么要显式区分：
 *   - `entry-by-id`（`/uniprotkb/{accession}`）：404 才可能是"这个 accession 没有条目"；
 *   - `search`（`/uniprotkb/search`）：404/400 一律是**上游不认这个请求**，
 *     不是"这个物种没有这个蛋白"。把前者说成后者，用户会以为数据不存在，
 *     进而换源、换参数、得出错误结论。
 */
type UniProtEndpoint = 'entry-by-id' | 'search';

/** 从响应体里取**错误消息字段**（顶层 `messages` / `error`），不拿整份 body 做 includes。 */
/**
 * 从响应体里取**错误消息字段**（顶层 `messages` / `error`），不拿整份 body 做 includes。
 *
 * 另见 `isResourceNotFoundMessage`：判"查无"还要**整条消息精确相等**，
 * 不是"包含该短语"——后者会被 `Error: Resource not found` / `Sorry, Resource not found in database`
 * 这类带前后缀的消息骗过（审查 R11 残余 C）。
 */
function errorMessagesOf(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const out: string[] = [];
  const messages = (body as Obj).messages;
  if (Array.isArray(messages)) {
    for (const m of messages) if (typeof m === 'string') out.push(m);
  } else if (typeof messages === 'string') {
    out.push(messages);
  }
  const err = (body as Obj).error;
  if (typeof err === 'string') out.push(err);
  return out;
}

/**
 * 判"这条消息就是上游的『查无』信号"。
 *
 * **必须整条精确相等**（忽略首尾空白与大小写），不许做成"包含"：
 *   ✓ `"Resource not found"`                      → 是
 *   ✗ `"Error: Resource not found"`               → 否（带前缀，可能是别的东西）
 *   ✗ `"Resource not found for Q99999"`           → 否（带后缀，可能是别的语义）
 *   ✗ `"Sorry, Resource not found in database"`   → 否（这是一整句自然语言）
 *
 * 依据：实测的上游查无原体就是 `{"url":…,"messages":["Resource not found"]}`（88 B），
 * 消息体**恰好是这五个词**。放宽成"包含"等于给任意含该短语的错误开后门，
 * 而"查无"是一个**会对用户下结论**的判定，不能靠模糊匹配。
 */
export function isResourceNotFoundMessage(msg: string): boolean {
  return msg.trim().toLowerCase() === 'resource not found';
}

/**
 * **400 分类：按 `messages` 字段结构分档，不拿整份 body 做 includes**（审查 R11 残余 P2）。
 *
 * 为什么必须分档：本仓给 `search` 固定传 `fields`，所以"上游拒绝 fields"是**我们自己的问题**，
 * 不能报成"用户的 query 语法错"。原实现只认 accession，其余一律说成 query 语法，
 * 正是把内部契约问题误导成用户问题。
 *
 * 三档均有本批实测原体（见 `fixtures/`），未知一律 `unknown`，**不许兜底成 query-syntax**：
 *   - `Invalid fields parameter value …`                → `fields-param`      ③
 *   - `The 'accession' value has invalid format…`       → `accession-format`  ②
 *   - `query parameter has an invalid syntax`           → `query-syntax`      ①
 *
 * 判据只读 `messages` / `error` 条目；`url` 回显里即使含这些词也不影响判定。
 */
export function classify400(raw: string):
  'fields-param' | 'accession-format' | 'query-syntax' | 'unknown' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unknown';
  }
  const messages = errorMessagesOf(parsed).map((m) => m.trim());
  if (messages.length === 0) return 'unknown';
  // fields 必须先判：它和 accession 都可能出现在同一份 body 的 url 回显里，
  // 只认"消息条目本身以 Invalid fields parameter 开头"这一种形态。
  if (messages.some((m) => /^invalid fields parameter\b/i.test(m))) return 'fields-param';
  if (messages.some((m) => /^the 'accession' value has invalid format\b/i.test(m))) return 'accession-format';
  if (messages.some((m) => /^query parameter has an invalid syntax$/i.test(m))) return 'query-syntax';
  return 'unknown';
}

/**
 * **自检：让事实（URL）约束声明（`endpoint`）**（负责人 2026-11-01）。
 *
 * 起因：`endpoint` 是可以乱传的字符串。哪天有人写
 *   `fetchUniProt(ctx, '…/uniprotkb/search?…', label, 'entry-by-id')`
 * 代码就会把"检索出错"说成"这个 accession 不存在"——**判据换了个位置，门槛却没拦住**。
 *
 * 所以不靠调用点自觉，在这里核对：
 *   entry-by-id → path 必须是 `/uniprotkb/<单个 accession>`，且**不含** `/search`
 *   search      → path 必须含 `/search`
 * 对不上直接抛错——**这是代码 bug，不是上游问题**，所以用普通 Error 而非 UpstreamError，
 * 免得被当成"上游返回了异常"而写进用户可见文案。
 */
/**
 * **导出供测试直接锁住判别逻辑**（不是对外契约——`ToolDefinition` 才是）。
 * 理由：这个自检的错误分支在正常调用路径上永远走不到，
 * 不导出就只能靠"变异后看别的用例红不红"，而那种间接证据说不清是哪个分支错了。
 */
export function assertEndpointMatchesUrl(url: string, endpoint: UniProtEndpoint): void {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    throw new Error(`内部不变量破坏：fetchUniProt 收到非法 URL「${url.slice(0, 60)}」`);
  }
  const isSearchPath = /\/uniprotkb\/search\b/.test(path);
  if (endpoint === 'search' && !isSearchPath) {
    throw new Error(
      `内部不变量破坏：endpoint='search' 但 URL 路径是「${path}」——不含 /uniprotkb/search。`
      + '这会让"检索出错"被误报成"条目不存在"，必须先修调用点',
    );
  }
  if (endpoint === 'entry-by-id') {
    if (isSearchPath) {
      throw new Error(
        `内部不变量破坏：endpoint='entry-by-id' 但 URL 路径是「${path}」——这是检索入口，不是单条查询。`
        + '这会把"检索出错"误报成"该 accession 不存在"，必须先修调用点',
      );
    }
    // 单条形态：/uniprotkb/<accession>（6–10 位字母数字）
    if (!/^\/uniprotkb\/[A-Za-z0-9]{6,10}$/.test(path)) {
      throw new Error(
        `内部不变量破坏：endpoint='entry-by-id' 但 URL 路径是「${path}」——`
        + '不是 /uniprotkb/<accession> 形态，必须先修调用点',
      );
    }
  }
}

/** 统一取一次 JSON；非 200 按"已实测的错误形态"分流，不把上游原文透给模型。 */
async function fetchUniProt(
  ctx: ToolContext, url: string, label: string, endpoint: UniProtEndpoint,
): Promise<{ res: HttpResult; prepared: ReturnType<typeof prepareRequest> }> {
  assertEndpointMatchesUrl(url, endpoint);
  const prepared = prepareRequest({ url, sourceName: manifest.displayName });
  let res: HttpResult;
  try {
    res = await fetchPrepared(ctx, prepared);
  } catch (error) {
    if (error instanceof UpstreamError) {
      const status = error.meta.status ?? 0;
      const raw = error.meta.rawBody ?? error.meta.bodySnippet ?? '';
      /**
       * 400 有**三种**实测形态（本批三份原体齐备），必须分开，**不能只按状态码判**：
       * ① `search-400.json`           103 B `["query parameter has an invalid syntax"]`     → 检索语法错
       * ② `entry-400-accformat.json`  157 B `["The 'accession' value has invalid format…"]` → accession 格式错
       * ③ `search-400-badfield.json`  108 B `["Invalid fields parameter value 'notafield'"]`→ **fields 参数错**
       *
       * **审查 R11 残余（P2）**：原实现用整份原文子串判 `accession`，命中不了就**一律**断言
       * "query 语法不合法"。于是第③类（本仓自己固定传的 `fields`）被说成用户的检索条件写错了，
       * 用户会去改 AND/OR，而问题在上游字段契约——**把内部问题误导成用户问题**。
       *
       * 现在按 **`messages` 字段结构**分四档，**未知档不许再落到 query 语法**。
       */
      if (status === 400) {
        const kind = classify400(raw);
        const detail = kind === 'accession-format'
          ? `${label}：上游认为 accession **格式不合法**（HTTP 400）。可做的：核对是否为 6–10 位字母数字（如 Q9SXZ2、P46290）；`
            + '注意 accession 不是基因名，基因名请用 uniprot_search_proteins 的 gene 参数'
          : kind === 'fields-param'
            ? `${label}：上游认为 **fields 参数**不合法（HTTP 400）——`
              + '这是**本仓固定传的字段清单**被上游拒绝，不是你查询条件写错了。这不是"没有数据"，也不是"该基因不存在"。'
              + '可做的：① 原样重试一次；② 若稳定复现，说明上游字段契约已变，需维护者更新本仓的 fields 清单'
            : kind === 'query-syntax'
              ? `${label}：上游认为 query **语法不合法**（HTTP 400）。可做的：① 检查是否有多余的 AND/OR；`
                + '② 用最简单的 `gene:<符号> AND organism_id:<taxon>` 形式；③ 换用基因符号或 accession 重试'
              : `${label}返回 HTTP 400，但错误消息**不属于本仓已实测的三类**（accession 格式 / fields 参数 / query 语法）。`
                + '**不能判定为"你的 query 写错了"**——更可能是上游请求契约变了，属需要人工核查的情形（上游原文不透出）。'
                + '可做的：原样重试一次；若稳定复现，报维护者补实测原体';
        throw new UpstreamError(detail, {
          url: prepared.url, request: prepared.request, status, attempts: error.meta.attempts,
        });
      }
      /**
       * 404 有**三种**形态，必须按**端点类型 + 错误消息字段**区分（审查 R11 P1）。
       *
       * 实测：
       *   - 单条不存在：`{"url","messages":["Resource not found"]}` 88 B  → **查无**（仅限 entry-by-id）
       *   - 路径不存在：nginx HTML / 或任何非 Resource not found 的 JSON → **上游路径或参数问题**
       *
       * **两层判据，缺一不可**：
       *   ① 端点类型：只有 `entry-by-id` 的 404 才可能是"查无"；`search` 的 404/400 一律是上游不认请求
       *   ② 判据字段：读响应体的 `messages` / `error` 字段，**不拿整份 body 做 includes**
       *      ——否则 `url` 或 `query` 回显里恰好含这几个词，也会被误判成查无
       */
      if (status === 404 && endpoint === 'entry-by-id') {
        const isJson = /^\s*\{/.test(raw);
        let parsed: unknown;
        try { parsed = isJson ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
        // 只看**错误消息字段**，且要求**整条精确相等**（不是包含——见 isResourceNotFoundMessage 注释）
        const saysNotFound = errorMessagesOf(parsed).some(isResourceNotFoundMessage);
        if (isJson && saysNotFound) {
          throw new UpstreamError(
            `${label}：上游明确回 **Resource not found**（HTTP 404）——**这个 accession 没有对应条目**。\n`
            + '这不等于"源不可用"。可做的：① 核对 accession 拼写；② 若你想按基因名查，'
            + '请用 uniprot_search_proteins 的 gene 参数（accession 与基因名不是一回事）',
            { url: prepared.url, request: prepared.request, status, attempts: error.meta.attempts },
          );
        }
        // 404 但错误字段没说 Resource not found：属未识别的上游拒绝，**不许说成查无**
        throw new UpstreamError(
          `${label}返回 HTTP 404，但上游的错误消息字段里**没有** "Resource not found"——`
          + '因此不能判定为"该条目不存在"。这更可能是**上游路径/参数契约变了**，'
          + '属需要人工核查的情形（上游原文不透出）',
          { url: prepared.url, request: prepared.request, status, attempts: error.meta.attempts,
            contentType: error.meta.contentType },
        );
      }
      /**
       * **检索端点**的 404/400 一律是"上游不认这个请求"，绝不改写成"查无结果"。
       * 用户若被告知"没查到"，会去换源、换参数，最后得出"这个物种没数据"的错误结论。
       */
      if (status === 404 || status === 400) {
        throw new UpstreamError(
          `${label}返回 HTTP ${status}：**这是检索入口，上游不认这次请求**，`
          + '不是"没有匹配的记录"。这不等于该基因/物种没有条目。'
          + '可做的：① 检查 query 语法（形如 `gene:<符号> AND organism_id:<taxon>`）；'
          + '② 检查 organism_id 是否在 3702/4565/39947/4577 内；③ 原样重试一次',
          { url: prepared.url, request: prepared.request, status, attempts: error.meta.attempts },
        );
      }
      // 403：nginx 拒绝（实测根路径 403）——按上游不可用报，不当查无
      if (status === 403) {
        throw new UpstreamError(
          `${label}返回 HTTP 403（nginx）：这是**上游拒绝访问**，不是"没有这条记录"。`
          + '注意 `rest.uniprot.org/` 根路径实测 403，不能拿它判源是否可用',
          { url: prepared.url, request: prepared.request, status, attempts: error.meta.attempts },
        );
      }
      throw new UpstreamError(`${label}未返回可用的 HTTP 200：不能当作查无结果`, {
        url: prepared.url, request: prepared.request, status, attempts: error.meta.attempts,
      });
    }
    throw error;
  }
  if (res.status !== 200) {
    throw new UpstreamError(`${label}返回 HTTP ${res.status}，不能当作查无结果`, {
      url: prepared.url, request: prepared.request, status: res.status,
    });
  }
  return { res, prepared };
}

const numArg = (description: string, min: number, max: number, def: number): JsonSchema =>
  ({ type: 'integer', minimum: min, maximum: max, default: def, description });

/** 只允许已声明参数（多传即拒，零请求）。 */
function onlyKnown(args: Obj, keys: string[]): void {
  const unknown = Object.keys(args).filter((k) => !keys.includes(k));
  if (unknown.length) throw new InvalidArgumentError(`未知参数：${unknown.join(', ')}`);
}

function requireTaxon(value: unknown): number {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{1,8}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(n) || !Object.hasOwn(SPECIES, n)) {
    throw new InvalidArgumentError(
      `organism_id 不在已实测白名单内：${typeof value === 'string' ? value : String(value)}；`
      + '本工具只开放 3702（拟南芥）、4565（小麦）、39947（水稻）、4577（玉米）。'
      + '其余物种未实测条目数，本仓不宣称覆盖',
    );
  }
  return n;
}

// ── 工具 1：检索 ────────────────────────────────────────────────────────

export const searchProteins: ToolDefinition = {
  name: 'uniprot_search_proteins',
  description:
    '按条件检索 UniProt 蛋白条目，返回 accession、基因名、蛋白名、**氨基酸长度**与是否已审（reviewed）。'
    + '当用户问“某个基因在 UniProt 是哪个条目”“这个物种有多少已审蛋白”“FT 的蛋白叫什么”时用。'
    + '**必须给 organism_id**（3702 拟南芥 / 4565 小麦 / 39947 水稻 / 4577 玉米，只开放这四个已实测物种）。'
    + '`gene` 给基因符号（如 FT、VRN1），或改用 `accession` 精确查。'
    + '同一基因常返回多条：`entryType` 会标明已审/未审，**不替用户挑一条**。'
    + '不返回序列本体、不做序列比对、不做 ID 批量映射（`idmapping` 只接受 POST，本批接不了）。'
    + '不分页：命中很多时请缩小查询条件（如加 reviewed、改物种、换更精确的基因名）。',
  parameters: {
    type: 'object',
    properties: {
      organism_id: {
        type: 'integer',
        description: 'NCBI taxon：3702=拟南芥，4565=小麦，39947=水稻，4577=玉米（必填，只开放这四个已实测物种）',
      },
      gene: { type: 'string', description: '基因符号或基因名，例如 FT、VRN1；与 accession 二选一' },
      accession: { type: 'string', description: 'UniProt accession，例如 Q9SXZ2；与 gene 二选一，给了就精确匹配' },
      reviewed_only: { type: 'boolean', default: false, description: '只看已审（Swiss-Prot）条目；默认 false 含未审' },
      size: numArg('本次最多返回几条（1–100，默认 20）。**这是本仓策略上限，不是上游限制**（上游 size 上限实测 500）', 1, MAX_SIZE, DEFAULT_SIZE),
    },
    required: ['organism_id'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    onlyKnown(args, ['organism_id', 'gene', 'accession', 'reviewed_only', 'size']);
    const taxon = requireTaxon(args.organism_id);

    const gene = args.gene;
    const accession = args.accession;
    if (gene !== undefined && accession !== undefined) {
      throw new InvalidArgumentError('gene 与 accession 只能给一个（两个都给会让上游条件互相压制）');
    }
    if (gene === undefined && accession === undefined) {
      throw new InvalidArgumentError('gene 与 accession 至少给一个；只给物种会返回全库，体积不可控');
    }
    let term: string;
    if (accession !== undefined) {
      // 用统一严格校验：宽松正则挡不住 AT1G65480 这类 9 位基因名
      term = `accession:${requireAccession(accession)}`;
    } else {
      if (typeof gene !== 'string' || !gene.trim() || gene.trim().length > 60) {
        throw new InvalidArgumentError('gene 须是非空字符串（≤60 字符），例如 FT、VRN1');
      }
      term = `gene:${gene.trim()}`;
    }

    const reviewedOnly = args.reviewed_only === undefined ? false : args.reviewed_only;
    if (typeof reviewedOnly !== 'boolean') throw new InvalidArgumentError('reviewed_only 须为布尔值');

    const size = args.size === undefined ? DEFAULT_SIZE : args.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_SIZE) {
      throw new InvalidArgumentError(`size 须为 1–${MAX_SIZE} 的整数（本仓策略上限，非上游限制）`);
    }

    let query = `${term} AND organism_id:${taxon}`;
    if (reviewedOnly) query += ' AND reviewed:true';

    const params = new URLSearchParams({ query, format: 'json', size: String(size), fields: FIELDS });
    const url = `${manifest.apiBase}/uniprotkb/search?${params.toString()}`;
    const { res, prepared } = await fetchUniProt(ctx, url, 'UniProt 检索', 'search');

    const data = obj(res.data, prepared.url, 'UniProt 检索响应');
    const results = data.results;
    if (!Array.isArray(results)) {
      throw new UpstreamShapeError('响应缺 results 数组，结构漂移', { url: prepared.url });
    }
    const total = totalFrom(res);
    const version = header(res, 'x-uniprot-release') ?? '未知';

    /**
     * **`invalid` 计数头必须在这里就拒，不能只放在空结果分支**（审查 R11 残余 P2）。
     *
     * 原实现的 `invalid` 检查嵌在 `results.length === 0` 里面，于是**非空结果**带坏头时
     * 一路走到渲染，`total.kind` 既不是 `value` 就落到 `'上游未给总数（x-total-results 缺失）'`
     * ——把"上游给了坏值"说成"上游没给"。这是**源异常分类失真**：
     * 前者是结构漂移（要修），后者是上游漏发（只能如实说不知道），处置完全不同。
     *
     * 所以判据放在**空/非空分流之前**，任何分支都先过这一关。
     */
    if (total.kind === 'invalid') {
      throw new UpstreamShapeError(
        'x-total-results 不是非负整数（结构漂移）——'
        + '**这不是"上游没给计数"，是上游给了不合法的值**。'
        + '不能用它算命中数，也不能把它当成"缺失"继续输出',
        { url: prepared.url },
      );
    }

    /**
     * **计数自洽检查：返回条数不能超过计数头声称的总数**（审查 R11 残余 A）。
     *
     * 实测缺口：`x-total-results: 0` 却返回 2 条时，原实现输出
     * 「上游命中 0 条；本次取回 2 条」——**一句自相矛盾的结论**。
     * 这类冲突是上游异常的信号，不能静默照抄，也不能挑一个当真值。
     *
     * 判据用 `>` 而不是 `!==`：`limitsize` 小于总数是正常的（`total=100, 本页 20`）。
     */
    if (total.kind === 'value' && results.length > total.value) {
      throw new UpstreamShapeError(
        `上游自相矛盾：计数头 x-total-results=${total.value}，但本次实际返回 ${results.length} 条。`
        + '既不采用计数头、也不采用实际条数，因为无法判断哪个可信。'
        + '可做的：① 原样重试一次；② 缩小查询条件后再看；'
        + '③ 若稳定复现，说明该查询在上游侧有问题',
        { url: prepared.url },
      );
    }

    /**
     * 空结果：**`x-total-results: 0` 是明确计数头**，所以能确定说"命中 0 条"，
     * 不必像 STRING 那样并列两种可能（这是本源的结构优势，不是我们更聪明）。
     * 但仍必须带**用户能改的条件 + 当前值 + 具体动作**。
     */
    if (results.length === 0) {
      // `invalid` 已在空/非空分流**之前**统一拒绝（见上方判据），这里不再重复判断。
      /**
       * `absent`（头不存在）与 `empty`（头存在但值为空）**都必须走这条"原因不明"分支**——
       * 两者都不能断言"命中 0 条"，否则就是把"上游没给数"说成"上游说 0 条"。
       * 但措辞要分开：读的人能据此判断是上游漏发头、还是发了空头。
       */
      if (total.kind === 'absent' || total.kind === 'empty') {
        const why = total.kind === 'absent'
          ? '**未提供 x-total-results 计数头**'
          : '**x-total-results 头存在但值为空**（上游给了头却没给数）';
        return finishResult({
          body: `**在 query=\`${query}\`、size=${size} 的条件下**，上游返回空 results，且${why}。\n`
            + '⚠️ 因此无法区分"确实没有匹配"与"上游本次没给数据"。**这不等于"该基因没有 UniProt 条目"。**\n'
            + '**这不等于命中 0 条**——"命中 0"需要上游明确给出 `x-total-results: 0`。\n'
            + `可做的：① 把 reviewed_only 从 ${reviewedOnly} 改为 false（看未审条目）；`
            + `② 把 organism_id 从 ${taxon} 换成 3702/4565/39947/4577 之一；`
            + '③ 换更短的基因符号或改用 accession 精确查，重新调用 uniprot_search_proteins。',
          res, prepared, sourceId: manifest.id, extra: version,
          raw: { query, size, totalResults: null, countHeader: total.kind, results: [] },
        });
      }
      /**
       * 计数头**有值**：`0` 才能说"命中 0 条"；`> 0` 却返回 0 条，是**上游自相矛盾**（审查 R11 P2）。
       *
       * 原来的写法把这两种都压成"命中 0 条"——**用一个确定答案盖住一次上游异常**。
       * 计数头说有 5 条、本次返回 0 条，这对不上；正确的做法是**两端都显示并标冲突**，
       * 让用户知道"这不是没有数据，是这次响应不对"。
       */
      if (total.value > 0) {
        throw new UpstreamShapeError(
          `上游自相矛盾：计数头 x-total-results=${total.value}，但本次返回的 results 为空。`
          + '**这不能当成"命中 0 条"**——可能是上游本页数据缺失或服务异常。'
          + '可做的：① 原样重试一次；② 缩小查询条件（如加 reviewed:true）后再看；'
          + '③ 若稳定复现，说明该查询在上游侧有问题，不是"这个基因没有条目"',
          { url: prepared.url },
        );
      }
      return finishResult({
        body: `**命中 0 条**：query=\`${query}\`、size=${size}（x-total-results=0，上游明确给出的计数头）。\n`
          + '这不等于"这个基因不存在于该物种"，只表示**在这组条件下没有条目**。\n'
          + `可做的：① 把 reviewed_only 从 ${reviewedOnly} 改为 false（看未审 TrEMBL 条目）；`
          + `② 把 organism_id 从 ${taxon} 换成 3702（拟南芥）/ 4565（小麦）/ 39947（水稻）/ 4577（玉米）；`
          + '③ 换更短的基因符号，或改用 accession 精确查，重新调用 uniprot_search_proteins。',
        res, prepared, sourceId: manifest.id, extra: version,
        raw: { query, size, totalResults: 0, countHeader: total.kind, results: [] },
      });
    }

    const records = results.map((item) => {
      const r = obj(item, prepared.url, 'UniProt 条目');
      const len = probeNumber((r.sequence as Obj | undefined)?.length
        ?? (r as Obj).length);
      if (len.kind === 'invalid') {
        throw new UpstreamShapeError('length 不是合法数值（结构漂移）', { url: prepared.url });
      }
      const sp = speciesLabel(r);
      const gn = geneNames(r);
      return {
        accession: optStr(r.primaryAccession, 20) ?? '(缺失)',
        entryType: entryTypeLabel(r.entryType),
        gene: gn.first,
        geneCount: gn.count,
        proteinName: proteinName(r),
        // **氨基酸数**，不是碱基数
        lengthAa: len.kind === 'value' ? len.value : undefined,
        species: sp.name,
        taxonId: sp.taxonId,
      };
    });

    const render = (shown: number): string => {
      const omitted = records.length - shown;
      const missingLen = records.slice(0, shown).filter((r) => r.lengthAa === undefined).length;
      /**
       * `absent`（头不存在）与 `empty`（头存在但值为空）措辞必须分开：
       * 前者是上游漏发头，后者是上游发了头却没给数——**成因不同，处置不同**。
       * `invalid` 已在分流前拒绝，走不到这里。
       */
      const totalTxt = total.kind === 'value'
        ? `上游命中 ${total.value} 条`
        : total.kind === 'empty'
          ? '上游未给总数（x-total-results 头存在但值为空）'
          : '上游未给总数（x-total-results 缺失）';
      return [
        `${totalTxt}；本次取回 ${records.length} 条，正文展示 ${shown} 条`
        + (omitted > 0 ? `；另有 ${omitted} 条未展示（当前 size=${size}，可减小条件缩小范围）` : ''),
        ...(missingLen > 0 ? ['', `⚠️ 有 ${missingLen} 条上游未给长度，表中显示“未提供”；**这不等于长度为 0**`] : []),
        '',
        renderTable(['accession', 'entryType', '基因', '蛋白名', '长度(氨基酸)', '物种'],
          records.slice(0, shown).map((r) => [
            r.accession, r.entryType, r.gene ?? '-', r.proteinName ?? '-',
            r.lengthAa === undefined ? '未提供' : String(r.lengthAa), r.species ?? '-',
          ]),
          { maxRows: shown, maxCell: 40 }),
        '',
        '注：**长度单位是氨基酸数**，不是碱基数。同一基因可能同时有“已审”与“未审”两个条目，按 entryType 区分。',
      ].join('\n');
    };

    let shown = records.length;
    while (shown > 0 && utf8Bytes(render(shown)) > MAX_BODY_BYTES) shown -= 1;
    const body = render(shown);
    if (utf8Bytes(body) > MAX_BODY_BYTES) {
      throw new InvalidArgumentError('检索正文超过 1408 字节，拒绝交给统一截断');
    }

    return finishResult({
      body, res, prepared, sourceId: manifest.id, extra: version,
      raw: {
        query, size, totalResults: total.kind === 'value' ? total.value : null,
        // 计数头状态：`value|absent|empty|invalid`——让调用方/测试能按**枚举**判定，
        // 不必去正文里找某句话（反向断言容易误伤自己，见 test 注释）
        countHeader: total.kind,
        returned: records.length, shown, omitted: records.length - shown,
        records: records.slice(0, shown),
      },
    });
  },
};

// ── 工具 2：单条 ────────────────────────────────────────────────────────

export const getEntry: ToolDefinition = {
  name: 'uniprot_get_entry',
  description:
    '按精确 UniProt accession 取单条蛋白条目的核心信息：条目类型、蛋白名、基因名、**氨基酸长度**、物种、'
    + '以及关键词与是否存在序列。当用户已有一个 accession（如 Q9SXZ2）想知道“这条到底是什么”时用。'
    + '**不返回序列本体**（体积不可控，需序列请回 UniProt 或走专门的序列源）。'
    + 'accession 必须精确（6–10 位字母数字）；不认识的 accession 上游返回 404，**那是“没有此条目”而不是“源坏了”**。',
  parameters: {
    type: 'object',
    properties: {
      accession: { type: 'string', description: '精确 UniProt accession，例如 Q9SXZ2、P46290（6–10 位字母数字）' },
    },
    required: ['accession'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    onlyKnown(args, ['accession']);
    const acc = requireAccession(args.accession);
    const url = `${manifest.apiBase}/uniprotkb/${encodeURIComponent(acc)}?format=json`;
    const { res, prepared } = await fetchUniProt(ctx, url, 'UniProt 单条查询', 'entry-by-id');
    const version = header(res, 'x-uniprot-release') ?? '未知';

    const item = obj(res.data, prepared.url, 'UniProt 条目');
    /**
     * **身份绑定（审查 REV-UNIPROT 第③条）**：返回的 `primaryAccession` 必须等于请求的 accession。
     *
     * 这与 STRING 的"错基因被接受"**完全同源**：接口返回的是合法数据，只是属于别的对象，
     * 用户看不出任何异常。所以"按标识符查"的端点**一律要回读并绑定**，这不是每个源单独发现的坑，
     * 是默认要求。
     *
     * 注意 `secondaryAccessions` 里出现别的 ID 不算不符——那是同一条目的历史别名；
     * 判据只看 `primaryAccession`。
     */
    const echoedAcc = optStr(item.primaryAccession, 20);
    if (!echoedAcc) {
      throw new UpstreamShapeError(
        '单条响应缺少 primaryAccession，无法确认返回的是否为所请求的条目——上游契约可能已变',
        { url: prepared.url },
      );
    }
    if (echoedAcc.toUpperCase() !== acc) {
      throw new UpstreamShapeError(
        `返回的 accession（${echoedAcc}）与请求的（${acc}）不一致——身份不符，`
        + '拒绝把别的条目当成本次结果',
        { url: prepared.url },
      );
    }
    const sp = speciesLabel(item);
    const gn = geneNames(item);
    const len = probeNumber((item.sequence as Obj | undefined)?.length);
    if (len.kind === 'invalid') {
      throw new UpstreamShapeError('sequence.length 不是合法数值（结构漂移）', { url: prepared.url });
    }
    const keywords = Array.isArray(item.keywords)
      ? item.keywords
        .map((k) => (k && typeof k === 'object' ? optStr((k as Obj).name, 30) : undefined))
        .filter((x): x is string => Boolean(x))
      : [];
    const seqObj = item.sequence as Obj | undefined;
    const hasSequence = typeof seqObj === 'object' && seqObj !== null
      && typeof (seqObj as Obj).value === 'string' && ((seqObj as Obj).value as string).length > 0;

    const body = [
      `${optStr(item.primaryAccession, 20) ?? acc}｜${entryTypeLabel(item.entryType)}`
      + `｜${proteinName(item) ?? '未提供蛋白名'}`,
      '',
      renderTable(['字段', '值'], [
        ['accession', optStr(item.primaryAccession, 20) ?? acc],
        ['条目类型', entryTypeLabel(item.entryType)],
        ['基因', gn.first ?? '未提供'],
        ['蛋白名', proteinName(item) ?? '未提供'],
        ['长度(氨基酸)', len.kind === 'value' ? String(len.value) : '未提供'],
        ['物种', sp.name ?? '未提供'],
        ['taxonId', sp.taxonId === undefined ? '未提供' : String(sp.taxonId)],
        ['关键词', keywords.length ? keywords.slice(0, 3).join('、') + (keywords.length > 3 ? ` 等 ${keywords.length} 个` : '') : '未提供'],
        ['含序列', hasSequence ? '是（本工具不返回序列本体）' : '否'],
      ], { maxRows: 12, maxCell: 60 }),
      '',
      '注：**长度单位是氨基酸数**，不是碱基数。序列本体不在此输出，需序列请回 UniProt 或走专门的序列源。',
    ].join('\n');

    if (utf8Bytes(body) > MAX_BODY_BYTES) {
      throw new InvalidArgumentError('单条正文超过 1408 字节，拒绝交给统一截断');
    }

    return finishResult({
      body, res, prepared, sourceId: manifest.id, extra: version,
      raw: {
        accession: optStr(item.primaryAccession, 20) ?? acc,
        entryType: entryTypeLabel(item.entryType),
        gene: gn.first, proteinName: proteinName(item),
        lengthAa: len.kind === 'value' ? len.value : undefined,
        species: sp.name, taxonId: sp.taxonId,
        keywords: keywords.slice(0, 10), hasSequence,
      },
    });
  },
};

export const tools: ToolDefinition[] = [searchProteins, getEntry];

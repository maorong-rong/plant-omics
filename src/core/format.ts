/**
 * 把结构化结果排成模型读得下去的文本。上游多大都不许原样泼出去。
 *
 * 两个约束在这里落地：
 *   1. **最终文本按 UTF-8 字节计预算**（不是字符数）。中文一个字 3 字节，
 *      按 `text.length` 算会把 4 KB 预算实际撑到 12 KB——审查 A4 就是这么超的。
 *   2. **截断不许砍掉出处尾注**。尾注是科研溯源的核心，正文可以短，出处不能丢。
 */

/** 单次工具输出的默认上限（UTF-8 字节，含出处尾注）。 */
export const DEFAULT_MAX_BYTES = 4 * 1024;

export interface TableOptions {
  /** 单元格最长字符数，超出用 … 截断 */
  maxCell?: number;
  /** 最多渲染多少行 */
  maxRows?: number;
}

function cell(value: unknown, maxCell: number): string {
  if (value === null || value === undefined || value === '') return '-';
  if (Array.isArray(value) && value.length === 0) return '-';
  const text = Array.isArray(value) ? value.join('; ') : String(value);
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  return flat.length <= maxCell ? flat : `${flat.slice(0, maxCell)}…`;
}

/** 空数组、空串、null 都不算"有值"，详情页里不要留一行空标签。 */
function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** 渲染 markdown 表格；超出行数时在表下注明「还有多少没显示」。 */
export function renderTable(
  headers: string[],
  rows: unknown[][],
  options: TableOptions = {},
): string {
  const maxCell = options.maxCell ?? 60;
  const maxRows = options.maxRows ?? 20;
  const shown = rows.slice(0, maxRows);

  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...shown.map((row) => `| ${headers.map((_, i) => cell(row[i], maxCell)).join(' | ')} |`),
  ];

  if (rows.length > shown.length) {
    lines.push('');
    lines.push(`（表中仅列前 ${shown.length} 条，共 ${rows.length} 条；需要更多请缩小查询范围）`);
  }
  return lines.join('\n');
}

/** 键值清单，用于单条记录的详情页。 */
export function renderFields(pairs: Array<[string, unknown]>, maxCell = 400): string {
  return pairs
    .filter(([, value]) => hasValue(value))
    .map(([key, value]) => `- ${key}：${cell(value, maxCell)}`)
    .join('\n');
}

/** UTF-8 字节数。不用 Buffer，避免把 Node 专有 API 泄进核心层。 */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 按 UTF-8 字节截断，**不切断多字节字符**。
 * 逐码点累加，超过预算即停——比 `slice(0, n)` 安全（后者会把 emoji/中文切成半个）。
 */
export function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 };
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };

  let used = 0;
  let cut = 0;
  for (const char of text) {
    const size = utf8Bytes(char);
    if (used + size > maxBytes) break;
    used += size;
    cut += char.length;
  }
  return { text: text.slice(0, cut), truncated: true };
}

/**
 * 统一出处尾注。科研场景下「这个数字从哪来」和数字本身一样重要。
 *
 * 必须带**完整查询**（含参数）：只有 pathname 时，`searchid=A` 与 `searchid=B`
 * 的出处一模一样，等于没有出处（审查 R06 / A7）。
 */
export function provenance(input: {
  sourceName: string;
  /** 例如 `GET /api/genes/known/search?searchid=VRN1` */
  request: string;
  status: number;
  durationMs: number;
  /** 查询时刻（ISO 8601，本地时区） */
  at?: string;
  /** 数据版本等补充说明；未知就不写，不许猜 */
  extra?: string;
}): string {
  const when = input.at ? `｜${input.at}` : '';
  const extra = input.extra ? `\n版本/口径：${input.extra}` : '';
  // 查询串本身可能很长（id-conversion 一次 200 个 ID ≈ 5 KB）。
  // 出处要可复现，但不许吃掉正文预算——超长时截断并标注总长度。
  const shown =
    input.request.length <= MAX_REQUEST_CHARS
      ? input.request
      : `${input.request.slice(0, MAX_REQUEST_CHARS)}…（共 ${input.request.length} 字符）`;
  return `\n——\n源：${input.sourceName}｜${shown}｜HTTP ${input.status}｜${input.durationMs} ms${when}${extra}`;
}

/** 出处里最多展示多少字符的请求串。 */
const MAX_REQUEST_CHARS = 300;

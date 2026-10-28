/**
 * 边界校验：进来的参数、出去的结构，都在这里把住。
 *
 * 两条来自对抗性审查（2026-10-28）的具体教训：
 *
 *   1. **R03 / A3**：`data.records ?? []` 把「上游改字段了」悄悄变成「查无结果」。
 *      用户看到"没有匹配"，会以为数据库里真没有这条记录——这比报错难查十倍。
 *      所以：**关键容器字段缺失或类型不对，一律抛 UpstreamShapeError**，不许落到空数组。
 *
 *   2. **R08 / A8**：`String(raw)` 会把对象参数变成 `"[object Object]"` 然后照样发请求。
 *      所以：**入参先做类型校验**，不合法就在本地拒掉，一个请求都不发。
 */

import { InvalidArgumentError, UpstreamShapeError } from './errors.js';

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value === 'object' ? '对象' : typeof value;
}

// ── 入参 ────────────────────────────────────────────────────────────────

/** 必填字符串。只接受 string / number / boolean，其余（对象、数组）直接拒。 */
export function requireStringArg(args: Record<string, unknown>, key: string, maxLength = 2_000): string {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === '') {
    throw new InvalidArgumentError(`缺少必填参数 ${key}`);
  }
  if (typeof raw === 'object') {
    throw new InvalidArgumentError(`参数 ${key} 必须是字符串，收到${typeName(raw)}`);
  }
  const text = String(raw).trim();
  if (text.length === 0) throw new InvalidArgumentError(`参数 ${key} 不能为空字符串`);
  if (text.length > maxLength) {
    throw new InvalidArgumentError(`参数 ${key} 过长（${text.length} 字符，上限 ${maxLength}）`);
  }
  return text;
}

/** 可选字符串。同样拒绝对象/数组，避免 `[object Object]` 混进查询。 */
export function optionalStringArg(args: Record<string, unknown>, key: string, maxLength = 2_000): string | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'object') {
    throw new InvalidArgumentError(`参数 ${key} 必须是字符串，收到${typeName(raw)}`);
  }
  const text = String(raw).trim();
  if (text.length === 0) return undefined;
  if (text.length > maxLength) {
    throw new InvalidArgumentError(`参数 ${key} 过长（${text.length} 字符，上限 ${maxLength}）`);
  }
  return text;
}

/** 可选整数，带夹取。非数字直接拒，不静默取默认值。 */
export function optionalIntArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'object') {
    throw new InvalidArgumentError(`参数 ${key} 必须是数字，收到${typeName(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new InvalidArgumentError(`参数 ${key} 必须是数字，收到「${String(raw)}」`);
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** 把「逗号/分号/空白分隔的 ID 串」拆成数组，并限制条数。 */
export function splitIds(value: string, maxCount: number, key: string): string[] {
  const ids = value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new InvalidArgumentError(`参数 ${key} 解析后为空`);
  if (ids.length > maxCount) {
    throw new InvalidArgumentError(`参数 ${key} 一次最多 ${maxCount} 个，收到 ${ids.length} 个；请分批查询`);
  }
  return ids;
}

// ── 上游结构 ────────────────────────────────────────────────────────────

function asObject(data: unknown, url: string, what: string): Record<string, unknown> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new UpstreamShapeError(
      `${what} 响应的 data 不是对象（实际 ${typeName(data)}）——上游契约可能已变`,
      { url },
    );
  }
  return data as Record<string, unknown>;
}

/**
 * 取一个**必有的数组字段**。
 *
 * 关键区别：字段存在但是 `[]` ⇒ 合法空结果，正常返回；
 * 字段缺失或者不是数组 ⇒ 抛 UpstreamShapeError，**绝不退化成空数组**。
 */
export function requireArrayField(
  data: unknown,
  key: string,
  url: string,
  what: string,
): unknown[] {
  const obj = asObject(data, url, what);
  if (!(key in obj)) {
    throw new UpstreamShapeError(
      `${what} 响应里没有 \`${key}\` 字段——上游契约可能已变（这可能不是"没有结果"）`,
      { url, bodySnippet: `keys=${Object.keys(obj).slice(0, 12).join(',')}` },
    );
  }
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw new UpstreamShapeError(
      `${what} 响应里 \`${key}\` 不是数组（实际 ${typeName(value)}）——上游契约可能已变`,
      { url },
    );
  }
  return value;
}

/** 取一个可选数组字段：**字段不存在时返回 undefined**（由调用方决定怎么处理），类型错就抛。 */
export function optionalArrayField(
  data: unknown,
  key: string,
  url: string,
  what: string,
): unknown[] | undefined {
  const obj = asObject(data, url, what);
  if (!(key in obj)) return undefined;
  const value = obj[key];
  if (value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new UpstreamShapeError(
      `${what} 响应里 \`${key}\` 不是数组（实际 ${typeName(value)}）——上游契约可能已变`,
      { url },
    );
  }
  return value;
}

/** 把 unknown 数组里的对象挑出来（上游偶尔混进 null）。 */
export function objectsOf(rows: unknown[]): Array<Record<string, unknown>> {
  return rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row));
}

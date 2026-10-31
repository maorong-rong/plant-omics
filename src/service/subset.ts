/**
 * 按请求选源：请求头 `x-plantomics-sources: icg,scod`。
 *
 * 用词要准：服务是**无状态**的（每个 POST 独立新建 server + transport），没有会话，
 * 所以这是"按**请求**选源"，不是"按连接"、更不是权限隔离——同一客户端下一条请求不带这个头，
 * 照样拿到服务端全集。它解决的是**上下文预算**（只把用得上的工具装进模型上下文），不是访问控制。
 *
 * 为什么是**请求头**，不是 URL 路径或 query：
 * 1. 不改路由与既有地址——`/mcp` 仍是唯一入口，已配好的插件、curl、市场示例都不用改；
 * 2. 与鉴权同层，语义就是"这条连接要装哪些源"，不往路径里塞业务参数；
 * 3. 出错能直接回 400 + 具体原因，而路径版本要在 router 里多一层解析、还要处理逗号的百分号编码，
 *    对只想改一个 URL 的客户端不友好。
 *
 * **两级约束**：服务端（环境变量 `PLANTOMICS_SOURCES`）定的是本服务**能**给什么，
 * 请求头只能在其中**选**，不能借它扩张。所以：
 * - 未带请求头 / 头为空 → 原样使用服务端注册表（行为与加这个功能之前完全一致）；
 * - 头里出现注册表根本没有的 id → 抛错（拼错一个字母不许静默得到零工具）；
 * - 头里出现"有、但本服务未启用"的 id → 也抛错，并说明本服务启用了哪些。
 *
 * `hub_*` 元工具跟着子集注册表走（`createRegistry` 内部装配），所以子集里也有检索入口。
 */

import type { ToolRegistry } from '../core/registry.js';
import { PlantOmicsError } from '../core/errors.js';
import { createRegistry, knownSourceIds, parseSourceList } from '../sources/index.js';

/** 请求头名（小写；Node 的 headers 已转小写）。 */
export const SOURCE_SUBSET_HEADER = 'x-plantomics-sources';

export interface SubsetResolution {
  /** 本次请求该用的注册表；未指定子集时就是传进来的 base。 */
  readonly registry: ToolRegistry;
  /** 请求头点名的源 id（未指定时为 undefined，便于测试与日志区分"没选"与"选了全部"）。 */
  readonly requested?: string[];
}

/**
 * 解析请求头并产出本次请求的注册表。
 *
 * @throws PlantOmicsError 未知 id，或 id 存在但不在本服务启用范围内
 */
export function resolveSubset(
  base: ToolRegistry,
  headerValue: string | string[] | undefined,
): SubsetResolution {
  const text = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
  const requested = parseSourceList(text);
  if (!requested) return { registry: base };

  const all = new Set(knownSourceIds());
  const unknown = requested.filter((id) => !all.has(id));
  if (unknown.length > 0) {
    throw new PlantOmicsError(`未知的源 id：${unknown.join(', ')}。已登记的源：${knownSourceIds().join(', ')}`);
  }

  const available = new Set(base.listSources().map((bundle) => bundle.manifest.id));
  const unavailable = requested.filter((id) => !available.has(id));
  if (unavailable.length > 0) {
    const enabled = [...available].join(', ') || '(无)';
    throw new PlantOmicsError(
      `源 ${unavailable.join(', ')} 未在本服务启用。本服务启用的源：${enabled}`,
    );
  }

  return { registry: createRegistry({ enabled: requested }), requested };
}

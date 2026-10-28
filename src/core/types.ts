/**
 * 核心契约 —— 整个仓库只有这一份「什么是源 / 什么是工具」的定义。
 *
 * 设计原则（见 docs/架构.md §2）：
 *   1. 工具的入参 schema 是**纯 JSON Schema**，不是 zod、也不是某个框架的对象。
 *      因为两个出口要共用同一份定义：MCP 的 tools/list 直接吃 JSON Schema，
 *      dsh 的 ToolDefinition.parameters 也是 JSON Schema。写两遍必然漂移。
 *   2. 工具返回**已经排好版给人看的文本**，不把原始 JSON 直接丢给模型。
 *      上游返回 600 KB 是常事（见 expression_projects 的教训），
 *      输出设计本身就是工具设计的一部分。
 */

/**
 * 源的可编程接入等级 —— 来源于《MaizeGDB API 可用性核查》的结论：
 * 「文档说它有 API」和「我能脚本化地调到它」是两件事。
 *
 * - T1 有文档化的 JSON 接口（OpenAPI / REST 文档 / 官方示例）
 * - T2 无文档，但参数化 URL 稳定（老派 PHP/Perl 站点的常态）
 * - T3 只有网页 / 要过 Cloudflare / 要登录 —— **不写代码**，只登记
 */
export type AccessTier = 'T1' | 'T2' | 'T3';

/** 最近一次本机实测结果，由 `npm run probe` 产生，写进 docs/源登记表.md。 */
export interface ProbeRecord {
  /** YYYY-MM-DD */
  date: string;
  ok: boolean;
  status?: number;
  ms?: number;
  note?: string;
}

/** 一个数据源自报的元信息。没有这个东西的源不许进 src/sources/。 */
export interface SourceManifest {
  /** 小写短名，同时是工具名前缀，如 `wheatomics` */
  id: string;
  displayName: string;
  homepage: string;
  /** 不带尾斜杠，如 `https://wheatomics.sdau.edu.cn/api` */
  apiBase: string;
  tier: AccessTier;
  /** 人类可读的接口文档地址（T1 必填，T2 填最接近的说明页） */
  docs?: string;
  auth: 'none' | 'api-key' | 'login';
  /** 主要覆盖的物种，用拉丁名 */
  species: string[];
  /** 本机实测的可达性。中国站点经常「浏览器能开、脚本调不动」，必须显式记录 */
  network: 'direct' | 'proxy-required' | 'unknown';
  /**
   * probe 脚本用来判活的请求（相对 apiBase）。
   * `expect` 决定判活标准：T1 源必须是能解析的 JSON 且业务信封非失败；
   * T2 源可能返回 HTML，用 `any`（只看状态码），解析正确性交给离线 fixture 测试。
   */
  probe: { path: string; expectStatus?: number; expect?: 'json' | 'any' };
  lastProbe?: ProbeRecord;
  /** 这个源容易踩的坑，一句话一条，会在工具描述里透出 */
  caveats?: string[];
  /**
   * 该源对外承诺的数据版本口径（组装版本 / 注释版本 / 版本未知）。
   * 写不准就写"未知"，**不许按 ID 外观猜**。
   */
  versionNote?: string;
}

/** 只覆盖本仓库实际用到的 JSON Schema 子集。够用即可，不追求完备。 */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean>;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean | JsonSchema;
}

export interface HttpOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 失败重试次数（仅对网络错误 / 5xx / 429 生效，4xx 不重试） */
  retries?: number;
  headers?: Record<string, string>;
}

export interface HttpResult<T = unknown> {
  data: T;
  url: string;
  status: number;
  durationMs: number;
  attempts: number;
}

export type Fetcher = <T = unknown>(url: string, opts?: HttpOptions) => Promise<HttpResult<T>>;

/** 工具运行时环境。测试里把 `http` 换成 fixture 回放即可，不需要联网。 */
export interface ToolContext {
  http: Fetcher;
  signal?: AbortSignal;
}

export interface ToolResultMeta {
  sourceId: string;
  /** 完整请求（含查询参数），用于复现 */
  request: string;
  /** 完整 URL */
  url: string;
  status: number;
  durationMs: number;
  /** 查询时刻，ISO 8601 */
  at: string;
}

export interface ToolResult {
  /** 给模型看的成品文本（已排版，含出处尾注） */
  text: string;
  /** 可选的原始结构，便于程序化消费与调试；不进模型上下文 */
  raw?: unknown;
  meta: ToolResultMeta;
}

export interface ToolDefinition {
  /** 全局唯一。命名 `<sourceId>_<动词短语>`，例如 `wheatomics_search_known_genes` */
  name: string;
  /** 说清「什么时候该用它」，而不是「它内部做了什么」 */
  description: string;
  parameters: JsonSchema;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface SourceBundle {
  manifest: SourceManifest;
  tools: ToolDefinition[];
}

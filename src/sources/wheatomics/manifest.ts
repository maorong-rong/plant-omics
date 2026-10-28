import type { SourceManifest } from '../../core/types.js';

/**
 * WheatOmics（山东农业大学，小麦多组学平台）
 *
 * 选择它做**样板源**的理由（2026-10-27 本机实测）：
 *   - 有完整的 OpenAPI 3.1（`/api/openapi.json`，93 个端点，全中文文档）→ 标准 T1；
 *   - 无鉴权、本机直连 200，不经代理 → 适合当第一个能跑通的例子；
 *   - 覆盖基因 / 表达 / 文献 / ID 转换，正好是聚合类工具最常被问到的四件事。
 */
export const manifest: SourceManifest = {
  id: 'wheatomics',
  displayName: 'WheatOmics 小麦多组学平台',
  homepage: 'https://wheatomics.sdau.edu.cn/',
  apiBase: 'https://wheatomics.sdau.edu.cn/api',
  tier: 'T1',
  docs: 'https://wheatomics.sdau.edu.cn/api/docs',
  auth: 'none',
  species: ['Triticum aestivum', 'Triticum turgidum', 'Aegilops tauschii'],
  network: 'direct',
  probe: { path: '/expression/projects', expectStatus: 200, expect: 'json' },
  lastProbe: {
    date: '2026-10-27',
    ok: true,
    status: 200,
    ms: 450,
    note:
      '当日 22:00 六个端点全部 200 并抓到 fixture；22:12 起 /api/* 全部 503'
      + '（静态首页仍 200，503 由 Apache 反向代理返回）；22:18 复查已恢复 200',
  },
  /**
   * 版本口径**如实标未知**。
   *
   * 对抗性审查 R06 指出：本仓内部对同一批 ID 的说法不一致——
   * 一处写"表达量基于 IWGSC v2.1（02G）"，另一处写"统一转 IWGSC v1.1（02G）"，
   * 而 fixture 里 `genome` 字段是 `Chinese_Spring1.0`、JBrowse 轨道写 `IWGSCv1.1_HC_LC`。
   * 组装版本、注释版本、站点内部映射表是三件事，**不能按 ID 外观互相推断**。
   * 本仓没有独立核验能力，所以只陈述上游返回了什么。
   */
  versionNote:
    '上游 genome 字段返回 Chinese_Spring1.0；02G/01G/03G 前缀映射由上游端点自行解释，'
    + '本仓未独立核验其对应的组装/注释版本号，引用前请回上游确认',
  caveats: [
    '平台自带 MCP server（GET /api/mcp/sse）—— 本插件不是它的替代品，价值在于把小麦和别的国内库并成同一套工具',
    '上游各端点对 01G/02G/03G 的"v1/v2/v3"叫法不一致；本仓按前缀识别，不替你判定注释版本',
    '表达值单位随项目而定且上游未逐点标注，跨项目不可直接比较大小',
    '返回信封统一为 {success, message, timestamp, data}；success=false 时 data 不可用',
    '基因详情里的 molecular_weight 单位未在文档中标注（245 aa 的蛋白返回 27838.39，量级像 Da）；引用前请回上游确认',
  ],
};

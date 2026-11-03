import type { SourceManifest } from '../../core/types.js';

/**
 * STRING（ELIXIR / 瑞士生物信息研究所）蛋白互作库。
 *
 * 定级 T1：官方 REST 文档页 `https://string-db.org/help/api/` 200 / 131,921 B；
 * 版本 `GET /api/json/version` = 12.5。
 */
export const manifest: SourceManifest = {
  id: 'string',
  displayName: 'STRING 蛋白互作数据库',
  homepage: 'https://string-db.org/',
  apiBase: 'https://string-db.org/api',
  tier: 'T1',
  docs: 'https://string-db.org/help/api/',
  auth: 'none',
  // 只列已实测的物种：3702 拟南芥、39947 水稻（Japonica）。4565/4577 未列入白名单见下述 caveats。
  species: ['Arabidopsis thaliana', 'Oryza sativa Japonica Group'],
  network: 'direct',
  probe: { path: '/json/version', expectStatus: 200, expect: 'json' },
  lastProbe: {
    date: '2026-11-01',
    ok: true,
    status: 200,
    ms: 790,
    note: 'get_string_ids 正例 743 B、空 2 B；interaction_partners 正例 2,486 B、404 Error 592 B、400 Error 206 B。'
      + 'STR-01 复测（本机 curl 8.21.0 单次 GET）：partners 合法 ID 阈值滤空 200/2 B、partners 无效 ID 404/591 B、'
      + 'resolve 无效 ID 200/2 B、resolve 未知物种 400/206 B、resolve 39947 正例 200/210 B、partners 39947 正例 200/834 B、'
      + 'camelCase 404/109 B 无 content-type 的 HTML 转发桩。均为本机直连实测。',
  },
  versionNote:
    '上游自报版本 12.5（GET /api/json/version）；本仓未核验各物种数据随版本更新的具体日期，不按 ID 外观推断版本',
  caveats: [
    '**上游会自行解析基因名**：直接传 `AT1G65480` 实测返回 200 / 10 条互作。本仓仍要求传已解析的 `stringId`，'
      + '是为了让尾注留下"解析到了哪个 ID"、让空结果可解释——**这是本仓策略，不是接口限制**',
    '**三种"没有"按端点各自成立，不许互相借用**：`get_string_ids` 不认识标识符 → `200 + []`（2 B，无 Error 码）；'
      + '`interaction_partners` 不认识标识符 → `404 + Error:"not found"`（591 B）；两者物种不存在 → `400 + Error:"unknown organism"`。'
      + '`"nothing found"` 属本仓**不接**的 `interactions` 端点，在伙伴端点从未观察到，不映射成"查无"',
    '**`200 + []` 的含义按端点分开**：resolve 侧 = "没解析出来"，partners 侧 = "解析成功但无伙伴或被 `required_score` 滤空"。'
      + '任一单端点内部都无法自证，本仓拒绝把这种空当作"没有互作"',
    '**`species` 必填是本仓策略，理由已实测**：上游该参数非必填，但不传时**会跨物种乱解析**——'
      + '`get_string_ids?identifiers=FT`（不传 species）实测返回 `10090.ENSMUSP00000112375` **小鼠**，'
      + '而同一 `FT` 传 `species=3702` 返回拟南芥 `3702.Q9SXZ2`。故本仓要求必填并回读 `ncbiTaxonId` 核对，'
      + '不依赖上游自行选物种',
    '**物种回显是明确映射表，不是"任意不一致先提示后放行"**：`3702→3702`、`39947→39947`（均有直接正例）、`4530→39947`（一次实测，原样发出、如实转述回显）。'
      + '除此之外任何不一致一律拒答。**不认定 4530 与 39947 等价，也不允许反推**',
    '**`get_string_ids` 的 `limit` 未观察到任何效果，本仓已不发送该参数**：单标识符 `limit=1/3/20/100` 响应字节完全相同'
      + '（如 `AT1G65480` 四次均 743 B / 1 条）；换行分隔 2–3 个标识符传 `limit=1` 仍逐条各返回 1 条。'
      + '原实现固定发 `limit=3`，实测既不截断也不影响输出，属解释不了的魔数，已删除；不传该参数实测同为 200 / 743 B',
    '**小麦 4565 / 玉米 4577 的基因级互作能力未验证**：本仓尚未取得这两个物种的有效 STRING 标识符样例'
      + '（实测只试过 1 个基因编号，返回 200+[]）；这不等于该物种无数据',
    '**`limit` 1–100 与 `required_score` 默认 400 都是本仓策略**：上游 `limit` 是软上限（传 1000 回 290 条不报错），'
      + '收窄只为控上下文预算，不是上游限制',
    '不接 network（add_nodes=100 实测 878,896 B / 3,336 条，且 limit 被忽略、无分页）；不接 enrichment（需基因集，属另一意图）',
  ],
};

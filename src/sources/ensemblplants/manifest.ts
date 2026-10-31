import type { SourceManifest } from '../../core/types.js';

/**
 * Ensembl Plants（EMBL-EBI）。
 *
 * 定级 T1 的限定：官方 REST 文档页 200，但 `swagger.json` 实测返回 500 HTML，
 * **未取得机器可读规范**——不据此断言上游没有 OpenAPI。
 * 因此本地字段校验必须更严，fixture 回归是唯一的漂移探测器。
 */
export const manifest: SourceManifest = {
  id: 'ensemblplants',
  displayName: 'Ensembl Plants（EMBL-EBI）',
  homepage: 'https://plants.ensembl.org/',
  apiBase: 'https://rest.ensembl.org',
  tier: 'T1',
  docs: 'https://rest.ensembl.org/documentation',
  auth: 'none',
  // 只列已在 lookup 上取得 200 正例且响应侧 species 可核验的物种（2026-10-30 四物种实测）。
  species: ['Arabidopsis thaliana', 'Oryza sativa', 'Triticum aestivum', 'Zea mays'],
  network: 'direct',
  probe: { path: '/lookup/id/AT1G65480?content-type=application/json', expectStatus: 200, expect: 'json' },
  lastProbe: {
    date: '2026-10-30',
    ok: true,
    status: 200,
    ms: 781,
    note:
      'lookup 正例 441 B、查无 400（61/36 B）均在本机直连实测；'
      + '同 host 的 /sequence 曾一次 503 HTML、重试即 200；本机 Node 默认 10 s 连接超时会导致 CONNECT_TIMEOUT，属本机网络，不是端点故障',
  },
  versionNote:
    '组装版本取响应 assembly_name（实测：拟南芥 TAIR10、水稻 IRGSP-1.0、小麦 IWGSC、玉米 Zm-B73-REFERENCE-NAM-5.0，release 116）；'
    + '本仓未核验其与 Ensembl release 号的完整对应关系，不按 ID 外观推断版本',
  caveats: [
    '这是 ensembl.org 的共享 REST，同一 host 也服务脊椎动物（实测 homo_sapiens 的 TP53 返回 200）；本工具按物种白名单与响应侧 species 双重拦截',
    '基因 ID 分代次：玉米当前组装为 NAM-5.0（Zm00001eb…）；已实测旧编号 Zm00001d027624（B73 v4）本次查无，且返回与“基因不存在”相同。本仓不据此判定整类旧编号不可查',
    '已知缺口：批量 POST /lookup/id 本批未接（需公共层支持非 GET），只能逐条查询',
    '查无是 HTTP 400 而非 404，且参数错误同样是 400；本仓按端点+请求身份+完整原体三重锚定分流，未知形态一律报错不归空',
    '区间（overlap/region）与同源（homology）未接：50 kb 变异区间实测 1.9 MB，1 Mb 起 8 MB/27.6 s',
    '本机到该站点链路抖动明显：31 次尝试仅 6 次成功，25 次为连接超时；超时不等于物种或端点不支持',
  ],
};

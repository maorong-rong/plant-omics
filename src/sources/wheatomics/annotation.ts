import { InvalidArgumentError, UpstreamShapeError } from '../../core/errors.js';
import { renderTable, utf8Bytes } from '../../core/format.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest } from '../../core/request.js';
import { requireStringArg } from '../../core/shape.js';
import type { ToolDefinition } from '../../core/types.js';
import { manifest } from './manifest.js';

/** 仅接实测 Pfam 默认表；不猜 table 参数或分页能力。 */
export const geneAnnotation: ToolDefinition = {
  name: 'wheatomics_gene_annotation',
  description: '按 Pfam 结构域编号查询 WheatOmics 小麦基因注释（例如 PF00319）。只查默认注释表，不是按基因 ID 查详情，也不覆盖区间注释或全植物。坐标单位为 Mb。本地裁剪并报告总数和展示数，不是上游分页。',
  parameters: {
    type: 'object',
    properties: {
      pfam_id: { type: 'string', description: 'Pfam 编号，例如 PF00319' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: '本地最多展示条数（1–20，默认5）；字节预算可能进一步减少，不发给上游' },
    },
    required: ['pfam_id'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    for (const key of Object.keys(args)) {
      if (!['pfam_id', 'limit'].includes(key)) throw new InvalidArgumentError('Pfam 查询只接受 pfam_id 和 limit');
    }
    const id = requireStringArg(args, 'pfam_id', 20);
    if (!/^PF\d{5,6}$/.test(id)) throw new InvalidArgumentError('pfam_id 须为 PF 加5–6位数字，例如 PF00319');
    const limit = args.limit === undefined ? 5 : args.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new InvalidArgumentError('limit 须为1–20的整数');
    }
    const url = new URL(`${manifest.apiBase}/genes/functions/pfam`);
    url.searchParams.set('ID', id);
    const prepared = prepareRequest({ url: url.href, sourceName: manifest.displayName, presentation: { limit } });
    const res = await fetchPrepared(ctx, prepared);
    const shape = (): never => { throw new UpstreamShapeError('Pfam 响应结构、身份或计数与约定不符', { url: prepared.url }); };
    const object = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return shape();
      return value as Record<string, unknown>;
    };
    const envelope = object(res.data);
    if (envelope.success !== true) return shape();
    const data = object(envelope.data);
    if (data.domain !== id || data.table !== 'Genefunc_CS_IWGSC03G_table'
      || !Number.isSafeInteger(data.count) || (data.count as number) < 0 || !Array.isArray(data.records)) return shape();
    const records = data.records.map(object);
    if (data.count !== records.length) return shape();
    const projected = records.map((r) => {
      if (typeof r.gene_primary !== 'string' || !/^Traes[A-Za-z0-9.]{1,30}$/.test(r.gene_primary)
        || typeof r.chromosome !== 'string' || !/^chr[0-9A-Za-z]{1,10}$/.test(r.chromosome)
        || typeof r.start_mb !== 'number' || !Number.isFinite(r.start_mb) || r.start_mb < 0
        || typeof r.end_mb !== 'number' || !Number.isFinite(r.end_mb) || r.end_mb < r.start_mb
        || typeof r.domain !== 'string' || !r.domain.split(';').some((part) => part.trim().startsWith(`${id}:`))) return shape();
      // 不输出 description 等自由文本；raw 与正文使用相同的有界白名单。
      return { gene_primary: r.gene_primary, chromosome: r.chromosome, start_mb: r.start_mb, end_mb: r.end_mb, pfam_id: id };
    });
    const total = projected.length;
    const render = (shown: number) => [
      `Pfam ${id}：共 ${total} 条，展示 ${shown} 条，另有 ${total - shown} 条未展示。`,
      '坐标单位：Mb；默认表 Genefunc_CS_IWGSC03G_table；本地裁剪，不是分页。',
      total === 0 ? '上游明确返回 count=0、records=[]；本次无匹配，不代表没有该结构域。' : renderTable(
        ['基因', '染色体', '起点 Mb', '终点 Mb', 'Pfam'],
        projected.slice(0, shown).map((r) => [r.gene_primary, r.chromosome, r.start_mb, r.end_mb, r.pfam_id]),
        { maxRows: shown, maxCell: 40 },
      ),
    ].join('\n');
    let shown = Math.min(limit, total);
    while (shown > 0 && utf8Bytes(render(shown)) > MAX_BODY_BYTES) shown -= 1;
    const body = render(shown);
    if (utf8Bytes(body) > MAX_BODY_BYTES) return shape();
    return finishResult({ body, res, prepared, sourceId: manifest.id,
      raw: { table: data.table, domain: id, count: total, shown, omitted: total - shown, records: projected.slice(0, shown) },
      extra: `${manifest.versionNote}；注释表由上游返回，不推断组装或注释版本` });
  },
};

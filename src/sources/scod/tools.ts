import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { renderTable, utf8Bytes } from '../../core/format.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest, withRequestEvidence } from '../../core/request.js';
import type { HttpResult, JsonSchema, ToolContext, ToolDefinition, ToolResult } from '../../core/types.js';
import { manifest } from './manifest.js';

type Obj = Record<string, unknown>;
const version = manifest.versionNote;
const warning = '区间要覆盖整个基因，只给一个位点不能查覆盖该点的基因；0条不等于“这个位置没有基因”。';
const integerSchema = (description: string, minimum: number, maximum: number, defaultValue?: number): JsonSchema => ({
  type: 'integer', minimum, maximum, description, ...(defaultValue === undefined ? {} : { default: defaultValue }),
});
function fail(url: string, message: string): never { throw new UpstreamShapeError(message, { url }); }
function object(value: unknown, url: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(url, 'SCOD关键对象缺失或类型漂移');
  return value as Obj;
}
function count(value: unknown, url: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail(url, 'SCOD计数缺失或不是非负安全整数');
  return value;
}
function integerArg(args: Obj, key: string, minimum: number, maximum: number, fallback?: number): number {
  const value = args[key] === undefined ? fallback : args[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new InvalidArgumentError(`SCOD参数${key}须为${minimum}–${maximum}的整数（尚未联网）`);
  }
  return value;
}
function only(args: Obj, keys: string[]) {
  if (Object.keys(args).some(k => !keys.includes(k))) throw new InvalidArgumentError('SCOD收到未开放的参数（尚未联网）');
}
function safeText(value: unknown, max: number, url: string): string {
  if (typeof value !== 'string' || !value.trim()) return fail(url, 'SCOD目录必需文本缺失或类型漂移');
  // 目录只读取名称/物种，不读取submitter、publication、链接或嵌套原体。
  if (/[\x00-\x1f\x7f@]|(?:https?:\/\/)|(?:\d[ -]?){10,}/i.test(value)) return '（字段已隐私省略）';
  const chars = [...value.trim()];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}
function idNumber(value: unknown, url: string): number {
  const n = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return fail(url, 'SCOD genomeId不是合法目录键');
  return n;
}
function position(value: unknown, url: string): number {
  // 实测为数字字符串；不能让Number(null/空串)变成坐标0。
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return fail(url, 'SCOD坐标不是约定的数字字符串');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fail(url, 'SCOD坐标超出安全整数范围');
  return n;
}
async function query(ctx: ToolContext, path: string, params: Record<string, string | number>, render: (res: HttpResult, url: string) => { body: string; raw: unknown }): Promise<ToolResult> {
  return withRequestEvidence(ctx, async scoped => {
    const url = new URL(`${manifest.apiBase}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const prepared = prepareRequest({ url: url.href, sourceName: manifest.displayName });
    let res: HttpResult;
    try { res = await fetchPrepared(scoped, prepared); }
    catch (error) {
      // 不把上游message、错误正文、服务器路径或任意异常栈带给用户。
      if (error instanceof UpstreamError) throw new UpstreamError(scoped.signal?.aborted ? 'SCOD调用已取消' : 'SCOD上游请求失败，不能当作查无结果', {
        url: prepared.url, request: prepared.request, status: error.meta.status, attempts: error.meta.attempts,
      });
      throw new UpstreamError('SCOD请求失败，未得到可验证响应', { url: prepared.url, request: prepared.request });
    }
    if (res.status !== 200) throw new UpstreamError('SCOD未返回HTTP200，不能当作查无结果', { url: url.href, status: res.status, request: prepared.request });
    const { body, raw } = render(res, url.href);
    if (utf8Bytes(body) > MAX_BODY_BYTES) throw new InvalidArgumentError('SCOD完整本页超过1408 UTF-8字节；请减小length重试，未静默截断或丢弃页内记录');
    return finishResult({ body, raw, res, prepared, sourceId: manifest.id, extra: version });
  });
}

export const genomeList: ToolDefinition = {
  name: 'scod_genome_list',
  description: '列出SCOD甘蔗基因组目录，取得后续区间查询必需的genome_id。不是全植物目录，不开放尚未验证的term搜索；目录存在不等于每个材料的区间查询都已验证。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(args, ctx) {
    only(args, []);
    return query(ctx, '/genome/list', { term: '' }, (res, url) => {
      if (!Array.isArray(res.data) || res.data.length === 0 || res.data.length > 100) return fail(url, 'SCOD基因组目录不是已验证的非空裸数组，或超过本地100条目录上限');
      const seen = new Set<number>();
      const records = res.data.map(item => {
        const r = object(item, url);
        const id = idNumber(r.genomeId, url);
        if (seen.has(id)) return fail(url, 'SCOD基因组目录出现重复ID');
        seen.add(id);
        return { genome_id: id, name: safeText(r.name, 60, url), species: safeText(r.species, 60, url) };
      });
      const render = (shown: number) => [
        `SCOD基因组目录：共${records.length}条，展示${shown}条，另有${records.length - shown}条未展示。`,
        '名称可能节选；版本未知；区间查询实测仅genome_id=1、Chr1A。',
        renderTable(['genome_id', '名称', '物种'], records.slice(0, shown).map(r => [r.genome_id, r.name, r.species]), { maxRows: shown, maxCell: 40 }),
      ].join('\n');
      let shown = records.length;
      while (shown > 0 && utf8Bytes(render(shown)) > MAX_BODY_BYTES) shown -= 1;
      return { body: render(shown), raw: { total: records.length, shown, omitted: records.length - shown, records } };
    });
  },
};

export const geneRegion: ToolDefinition = {
  name: 'scod_gene_region',
  description: '在SCOD按基因组、染色体与区间筛选甘蔗基因：返回整条基因完全落在pos_start–pos_end内的记录，跨边界基因不返回，不是任意重叠查询。区间要覆盖整个基因；只给一个位点不能查覆盖该点的基因；0条不等于这个位置没有基因。正例仅genome_id=1、Chr1A；不外推其他植物。用start/length服务端分页，本地严格length≤50；坐标基数命名未核验。',
  parameters: {
    type: 'object',
    properties: {
      genome_id: integerSchema('先从scod_genome_list获得的genome_id', 1, Number.MAX_SAFE_INTEGER),
      chrom: { type: 'string', description: '上游染色体名，大小写保留；实测Chr1A，不是chr1A或带基因组后缀长名' },
      pos_start: integerSchema('区间下界，按上游原值传递，不转换坐标基数', 1, Number.MAX_SAFE_INTEGER),
      pos_end: integerSchema('区间上界，必须≥pos_start；整条基因被包含才返回', 1, Number.MAX_SAFE_INTEGER),
      start: integerSchema('服务端分页偏移，0起，不是基因组坐标', 0, Number.MAX_SAFE_INTEGER, 0),
      length: integerSchema('服务端页大小，默认5，本地安全上限50；完整页超正文预算时请减小此值，不自动丢行', 1, 50, 5),
    },
    required: ['genome_id', 'chrom', 'pos_start', 'pos_end'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    only(args, ['genome_id', 'chrom', 'pos_start', 'pos_end', 'start', 'length']);
    const genome = integerArg(args, 'genome_id', 1, Number.MAX_SAFE_INTEGER);
    const lower = integerArg(args, 'pos_start', 1, Number.MAX_SAFE_INTEGER);
    const upper = integerArg(args, 'pos_end', 1, Number.MAX_SAFE_INTEGER);
    const start = integerArg(args, 'start', 0, Number.MAX_SAFE_INTEGER, 0);
    const length = integerArg(args, 'length', 1, 50, 5);
    const chrom = args.chrom;
    if (typeof chrom !== 'string' || !/^Chr[A-Za-z0-9_.-]{1,30}$/.test(chrom)) throw new InvalidArgumentError('SCOD chrom须为区分大小写的上游名称，例如Chr1A（尚未联网）');
    if (upper < lower) throw new InvalidArgumentError('SCOD pos_end必须≥pos_start，不自动扩窗（尚未联网）');
    return query(ctx, '/gene/gene_list', { genomeId: genome, chrom, posStart: lower, posEnd: upper, start, length, draw: 1 }, (res, url) => {
      const data = object(res.data, url);
      if (data.error !== undefined && data.error !== null && data.error !== '') throw new UpstreamError('SCOD报告业务错误，不是查无结果', { url, status: res.status });
      const total = count(data.recordsTotal, url);
      const filtered = count(data.recordsFiltered, url);
      if (!Array.isArray(data.data) || filtered > total || (data.draw !== undefined && data.draw !== 1)) return fail(url, 'SCOD分页容器或draw/计数不符');
      const expected = Math.min(length, Math.max(0, filtered - start));
      if (data.data.length !== expected) return fail(url, 'SCOD本页条数与筛选计数/分页参数矛盾，不能降级查无');
      const seen = new Set<string>();
      const records = data.data.map(item => {
        const r = object(item, url);
        if (idNumber(r.genomeId, url) !== genome || r.chrom !== chrom) return fail(url, 'SCOD返回了其他基因组或染色体的记录');
        if (typeof r.geneId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(r.geneId) || seen.has(r.geneId)) return fail(url, 'SCOD基因ID缺失、类型漂移或重复');
        seen.add(r.geneId);
        const posStart = position(r.posStart, url);
        const posEnd = position(r.posEnd, url);
        if (posStart > posEnd || posStart < lower || posEnd > upper) return fail(url, 'SCOD返回记录并未完全包含于所请求区间，拒绝展示');
        return { gene_id: r.geneId, genome_id: genome, chrom, pos_start: posStart, pos_end: posEnd };
      });
      const next = records.length > 0 && start + records.length < filtered ? start + records.length : undefined;
      const body = [
        `SCOD：上游recordsTotal=${total}，recordsFiltered=${filtered}；本页返回并展示${records.length}条（start=${start}，length=${length}）。`,
        warning,
        records.length ? renderTable(['基因', '起点', '终点'], records.map(r => [r.gene_id, r.pos_start, r.pos_end]), { maxRows: length, maxCell: 64 })
          : filtered === 0 ? '上游明确返回筛选计数0和空数组；仅表示本次整体包含条件无匹配。' : '分页已越过末尾，不是该区间没有匹配基因。',
        next === undefined ? '无下一页。' : `下一页start=${next}，length=${length}；保持基因组、染色体和区间参数不变。`,
      ].join('\n');
      return { body, raw: { genome_id: genome, chrom, pos_start: lower, pos_end: upper, start, length,
        records_total: total, records_filtered: filtered, returned: records.length, shown: records.length, next_start: next, records } };
    });
  },
};

export const tools: ToolDefinition[] = [genomeList, geneRegion];

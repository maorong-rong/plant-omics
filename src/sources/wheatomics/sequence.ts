import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { utf8Bytes } from '../../core/format.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest } from '../../core/request.js';
import type { HttpResult, ToolDefinition } from '../../core/types.js';
import { manifest } from './manifest.js';

function integer(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key] === undefined ? fallback : args[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new InvalidArgumentError(`${key}须为1–${max}的整数`);
  }
  return value;
}

/** 不拼接多个FASTA记录；只对同ID且头行、序列均完全相同的重复件去重。 */
function parseSingleFasta(value: unknown, id: string, kind: string, url: string) {
  const fail = (): never => { throw new UpstreamShapeError('所选FASTA缺失、格式/身份不符，或包含不同记录；拒绝拼接序列', { url }); };
  if (typeof value !== 'string' || !value.trim()) return fail();
  const lines = value.trim().split(/\r?\n/);
  const records: Array<{ header: string; id: string; sequence: string }> = [];
  for (const line of lines) {
    if (line.startsWith('>')) {
      const headerId = line.slice(1).split(/\s/, 1)[0]!;
      if (headerId !== id && headerId !== `${id}.1`) return fail();
      records.push({ header: line, id: headerId, sequence: '' });
    } else {
      const current = records[records.length - 1];
      const alphabet = kind === 'gene' ? /^[ACGTRYSWKMBDHVN]+$/i : /^[ACDEFGHIKLMNPQRSTVWYBXZJUO*]+$/i;
      if (!current || !alphabet.test(line)) return fail();
      current.sequence += line;
    }
  }
  const first = records[0];
  if (!first || !first.sequence || records.some(r => r.id !== first.id || r.header !== first.header || r.sequence !== first.sequence)) return fail();
  return { recordId: first.id, sequence: first.sequence, upstreamRecords: records.length };
}

export const geneSequence: ToolDefinition = {
  name: 'wheatomics_sequence',
  description: '按小麦基因ID从WheatOmics获取基因或蛋白序列的一个本地分块。不接区间查询、不覆盖全植物；同ID完全相同的FASTA去重，不同记录报错不拼接。offset是所选去重序列的本地1起位置，不是基因组坐标；gene单位碱基、protein单位氨基酸残基。仅已验证的by-gene JSON 404判本次未找到。',
  parameters: {
    type: 'object',
    properties: {
      gene_id: { type: 'string', description: '小麦基因ID，例如TraesCS5A02G391700；可带转录本后缀.1' },
      sequence_type: { type: 'string', enum: ['gene', 'protein'], default: 'gene', description: 'gene=基因序列（碱基）；protein=蛋白（氨基酸残基），默认gene' },
      offset: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1, description: '所选去重后单条序列的本地1起位置，不是基因组坐标' },
      length: { type: 'integer', minimum: 1, maximum: 1000, default: 1000, description: '本地最多返回长度，1–1000，默认1000；不发给上游，不是上游分页' },
    },
    required: ['gene_id'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    for (const key of Object.keys(args)) {
      if (!['gene_id', 'sequence_type', 'offset', 'length'].includes(key)) throw new InvalidArgumentError('序列工具仅接受gene_id、sequence_type、offset、length，不开放区间');
    }
    const id = args.gene_id;
    if (typeof id !== 'string' || !/^Traes[A-Za-z0-9]{1,40}(?:\.\d{1,3})?$/.test(id)) {
      throw new InvalidArgumentError('gene_id须为小麦基因ID，例如TraesCS5A02G391700');
    }
    const kind = args.sequence_type === undefined ? 'gene' : args.sequence_type;
    if (kind !== 'gene' && kind !== 'protein') throw new InvalidArgumentError('sequence_type仅接受gene或protein');
    const offset = integer(args, 'offset', 1, Number.MAX_SAFE_INTEGER);
    const length = integer(args, 'length', 1000, 1000);
    const url = new URL(`${manifest.apiBase}/sequence/by-gene`);
    url.searchParams.set('gene_id', id);
    const prepared = prepareRequest({ url: url.href, sourceName: manifest.displayName, presentation: { sequence_type: kind, offset, length } });
    const started = Date.now();
    let res: HttpResult;
    try {
      res = await fetchPrepared(ctx, prepared);
    } catch (error) {
      // 只对本次精确by-gene URL + JSON 404 + 实测detail结构判查无；HTML404、改版404和其他端点绝不吞。
      if (!(error instanceof UpstreamError) || error.meta.url !== url.href || error.meta.status !== 404) throw error;
      let missing = false;
      const mediaType = (error.meta.contentType ?? '').split(';', 1)[0]!.trim();
      // 完整媒体类型匹配，不把application/jsonp或前后缀漂移当JSON。
      if (/^application\/(?:json|[!#$%&'*+.^_`|~0-9a-z-]+\+json)$/i.test(mediaType)) {
        try {
          const payload = JSON.parse(error.meta.bodySnippet ?? '');
          missing = payload?.detail === `No sequence found for ${id} (tried: ${id}, ${id}.1).`;
        } catch { /* 未匹配已验证查无结构，不降级成功。 */ }
      }
      if (!missing) throw new UpstreamError('序列端点返回404，但未匹配已验证的查无结构，不能判断记录是否存在', {
        url: prepared.url, request: prepared.request, status: 404, attempts: error.meta.attempts,
      });
      return finishResult({ body: `本次按基因查询未找到序列（已验证的by-gene JSON 404）；不代表基因不存在。`,
        res: { url: prepared.url, status: 404, data: null, durationMs: Date.now() - started, attempts: error.meta.attempts ?? 1 },
        prepared, sourceId: manifest.id, raw: { gene_id: id, sequence_type: kind, found: false },
        extra: `${manifest.versionNote}；404耗时为本地观测本次调用总耗时` });
    }
    if (res.status !== 200 || !res.data || typeof res.data !== 'object' || Array.isArray(res.data)) {
      throw new UpstreamShapeError('序列响应不是约定的200 JSON对象', { url: prepared.url });
    }
    const data = res.data as Record<string, unknown>;
    if (data.gene_id !== id) throw new UpstreamShapeError('序列响应gene_id与请求不符', { url: prepared.url });
    const parsed = parseSingleFasta(data[`${kind}_sequence`], id, kind, prepared.url);
    const total = parsed.sequence.length;
    const unit = kind === 'gene' ? '碱基' : parsed.sequence.includes('*') ? '序列符号（含*终止标记）' : '残基';
    const chunk = parsed.sequence.slice(offset - 1, offset - 1 + length);
    const end = chunk.length ? offset + chunk.length - 1 : undefined;
    const next = end !== undefined && end < total ? end + 1 : undefined;
    const body = [
      `${id} ${kind}｜共${total}${unit}；本地1起位置，非基因组坐标。`,
      `上游${parsed.upstreamRecords > 1 ? '重复' : ''}返回${parsed.upstreamRecords}条${parsed.upstreamRecords > 1 ? '，同ID同内容，已去重' : ''}；使用单条${parsed.recordId}。`,
      chunk.length ? `第${offset}–${end}位（${chunk.length}${unit}；本地分块，非完整FASTA）：\n${chunk}` : `offset=${offset}已越过末尾；不是查无序列。`,
      next ? `下一块offset=${next}，length=${length}。` : '已到末尾，无下一块。',
    ].join('\n');
    // 在公共收尾前断言，确保分块绝不会被统一截断成半块。
    if (utf8Bytes(body) > MAX_BODY_BYTES) throw new InvalidArgumentError('序列分块正文超过1408 UTF-8字节，请减小length后重试（未返回截断序列）');
    return finishResult({ body, res, prepared, sourceId: manifest.id, extra: manifest.versionNote,
      raw: { gene_id: id, sequence_type: kind, record_id: parsed.recordId, upstream_records: parsed.upstreamRecords,
        duplicates_removed: parsed.upstreamRecords - 1, total_length: total, unit, offset, shown_length: chunk.length,
        end, next_offset: next, sequence: chunk } });
  },
};

import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { renderFields, renderTable, utf8Bytes } from '../../core/format.js';
import { validateArgs } from '../../core/invoke.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest, withRequestEvidence } from '../../core/request.js';
import { requireArrayField } from '../../core/shape.js';
import type { HttpResult, JsonSchema, ToolContext, ToolDefinition } from '../../core/types.js';
import { manifest } from './manifest.js';

type Obj = Record<string, unknown>;
const string = (description: string): JsonSchema => ({ type: 'string', description });
const integer = (minimum: number, maximum: number, value: number): JsonSchema => ({ type: 'integer', minimum, maximum, default: value });
const geneId = string('精确基因/转录本ID，非模糊检索；最多256个Unicode码点');
const species = string('catalog/状态目录中的原始species字符串；最多512码点，不自造枚举');

function object(value: unknown, url: string, label: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpstreamShapeError(`${label}不是对象，无法判为无结果`, { url });
  }
  return value as Obj;
}
function field<T extends 'string' | 'number' | 'boolean'>(data: Obj, key: string, type: T, url: string): T extends 'string' ? string : T extends 'number' ? number : boolean {
  const value = data[key];
  if (typeof value !== type || (type === 'number' && !Number.isFinite(value)) || (type === 'string' && !(value as string).trim())) {
    throw new UpstreamShapeError(`响应字段 ${key} 缺失或不是有效${type}`, { url });
  }
  return value as never;
}
function count(data: Obj, key: string, url: string): number {
  const value = field(data, key, 'number', url);
  if (!Number.isSafeInteger(value) || value < 0) throw new UpstreamShapeError(`${key}不是非负整数`, { url });
  return value;
}
function rows(data: Obj, key: string, url: string): Obj[] {
  return requireArrayField(data, key, url, key).map((item) => object(item, url, `${key}成员`));
}

/** Schema type/range checks also apply to direct adapter calls, not just MCP/DSH. */
function checked(def: ToolDefinition): ToolDefinition {
  const run = def.run;
  def.run = async (args, ctx) => {
    validateArgs(def, args);
    for (const [key, value] of Object.entries(args)) {
      const schema = def.parameters.properties?.[key];
      if (!schema) continue;
      const valid = schema.type === 'integer'
        ? typeof value === 'number' && Number.isInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity)
        : typeof value === schema.type;
      if (!valid) throw new InvalidArgumentError(`参数 ${key} 类型/范围无效，应为${schema.type}`);
      if (typeof value === 'string') {
        if (!value.trim()) throw new InvalidArgumentError(`参数 ${key} 不能为空白`);
        const cap = key === 'module' ? 128 : ['species', 'version'].includes(key) ? 512 : 256;
        if ([...value].length > cap) throw new InvalidArgumentError(`参数 ${key} 超过本仓${cap}个Unicode码点上限`);
      }
    }
    return withRequestEvidence(ctx, (scoped) => run(args, scoped));
  };
  return def;
}
function endpoint(path: string, query: Obj): string {
  const url = new URL(`${manifest.apiBase}${path}`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
  return url.href;
}

async function request(ctx: ToolContext, path: string, query: Obj, presentation?: Obj) {
  const prepared = prepareRequest({ url: endpoint(path, query), sourceName: manifest.displayName, presentation });
  const res = await fetchPrepared(ctx, prepared);
  // Real fetcher throws non-2xx; retain the same semantics for injected fetchers.
  if (res.status < 200 || res.status >= 300) {
    const html = res.contentType?.toLowerCase().includes('text/html');
    const message = res.status === 404 && html
      ? '未找到或路径不支持（上游HTML兜底），无法据此判断基因是否存在'
      : `上游HTTP ${res.status}，不是成功结果`;
    throw new UpstreamError(message, { url: prepared.url, request: prepared.request, status: res.status, contentType: res.contentType });
  }
  if (res.contentType && !/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(res.contentType)) {
    throw new UpstreamError('上游响应格式错误：成功响应不是JSON', { url: prepared.url, request: prepared.request, status: res.status, contentType: res.contentType });
  }
  return { prepared, res, data: object(res.data, prepared.url, '上游响应') };
}

/** Count shown rows after byte-fitting, never claim rows that the final body will cut off. */
function tableBody(header: (shown: number) => string, columns: string[], values: unknown[][], url: string): string {
  let body = header(0);
  if (utf8Bytes(body) > MAX_BODY_BYTES) throw new UpstreamShapeError('响应摘要元数据超过正文预算，无法完整报告计数', { url });
  for (let shown = 1; shown <= values.length; shown++) {
    const candidate = `${header(shown)}\n${renderTable(columns, values.slice(0, shown), { maxRows: shown, maxCell: 48 })}`;
    if (utf8Bytes(candidate) > MAX_BODY_BYTES) break;
    body = candidate;
  }
  return body;
}
function finish(body: string, res: HttpResult, raw: unknown, prepared: ReturnType<typeof prepareRequest>, extra: string) {
  return finishResult({ body, res, raw, prepared, sourceId: manifest.id, extra });
}
function annotation(data: Obj, key: string, url: string): string {
  const values = requireArrayField(data, key, url, '基因注释');
  const labels = values.slice(0, 2).map((v) => {
    if (typeof v === 'string') return v;
    const obj = object(v, url, key);
    return ['id', 'name', 'description', 'label', 'term'].map((k) => obj[k]).filter((x) => typeof x === 'string').join(' / ') || '结构化条目（详见上游）';
  });
  return `${values.length}项${labels.length ? `；${labels.join('; ')}` : '（响应未提供）'}`;
}

const catalog = checked({
  name: 'strawberry_catalog',
  description: '发现Strawberry Data Hub草莓及相关病原的模块、装配和限流目录。module仅本地子串过滤（最多128码点）；目录存在不代表本仓已实现对应数据查询，模块物种覆盖不推断；generatedAt是目录生成时间而非数据版本。',
  parameters: { type: 'object', properties: { module: string('可选模块id/名称子串，本地过滤，最多128码点') }, additionalProperties: false },
  async run(args, ctx) {
    const module = args.module as string | undefined;
    const { prepared, res, data } = await request(ctx, '/catalog', {}, { module: module ?? null });
    const modules = rows(data, 'modules', prepared.url);
    const assemblies = object(data.assemblies, prepared.url, 'assemblies');
    const items = rows(assemblies, 'items', prepared.url);
    const limits = object(data.limits, prepared.url, 'limits');
    const example = items[0];
    const assemblyExample = example ? `${field(example, 'species', 'string', prepared.url)} / ${field(example, 'version', 'string', prepared.url)}` : '无目录项';
    const generatedAt = field(data, 'generatedAt', 'string', prepared.url);
    const apiVersion = field(data, 'apiVersion', 'string', prepared.url);
    const matched = modules.filter((m) => {
      const id = field(m, 'id', 'string', prepared.url);
      const name = field(m, 'name', 'string', prepared.url);
      return !module || `${id} ${name}`.toLowerCase().includes(module.toLowerCase());
    });
    const body = tableBody((shown) => `目录模块${modules.length}个；匹配${matched.length}个；实际展示${shown}个。\n装配目录返回${items.length}项；状态${field(assemblies, 'status', 'string', prepared.url)}（非物种穷尽清单）。\n装配示例（非穷尽）：${assemblyExample}。\n限流：${count(limits, 'requestsPerMinute', prepared.url)}请求/分钟；导出${count(limits, 'exportsPerMinute', prepared.url)}/分钟（本工具不导出）。\n目录发现不代表已接入对应查询；模块物种范围未声明则未知。`,
      ['模块', '名称'], matched.map((m) => [m.id, m.name]), prepared.url);
    return finish(body, res, data, prepared, `apiVersion=${apiVersion}；目录生成时间=${generatedAt}（不是数据版本）；装配版本见目录原字符串`);
  },
});

const geneLookup = checked({
  name: 'strawberry_gene_lookup',
  description: '精确查询草莓及相关病原的基因注释、响应自身物种与装配版本及蛋白长度，不做模糊搜索。species/version请用catalog或状态目录的原字符串；ID最多256码点，species/version各512。includeSequence默认false；只展示最多120 aa的非完整蛋白前缀，不能用于完整序列分析或下载。',
  parameters: { type: 'object', properties: { geneId, species, version: string('目录中的原始version；最多512码点'), includeSequence: { type: 'boolean', default: false } }, required: ['geneId'], additionalProperties: false },
  async run(args, ctx) {
    const includeSequence = (args.includeSequence as boolean | undefined) ?? false;
    const { prepared, res, data } = await request(ctx, '/genes/search', { geneId: args.geneId, species: args.species, version: args.version }, { includeSequence });
    const id = field(data, 'id', 'string', prepared.url);
    const organism = field(data, 'species', 'string', prepared.url);
    const version = field(data, 'version', 'string', prepared.url);
    const assemblies = rows(data, 'assemblies', prepared.url);
    for (const assembly of assemblies) {
      field(assembly, 'species', 'string', prepared.url);
      field(assembly, 'version', 'string', prepared.url);
    }
    if (data.proteinSequence !== null && typeof data.proteinSequence !== 'string') throw new UpstreamShapeError('proteinSequence缺失或类型错误', { url: prepared.url });
    const protein = typeof data.proteinSequence === 'string' ? data.proteinSequence : undefined;
    const seq = protein?.slice(0, 120);
    const sequence = includeSequence && seq ? `\n非完整序列：展示${seq.length}/${protein!.length} aa；不可用于完整序列分析。\n${seq}` : '';
    const lead = `基因 ${id}${sequence}\n`;
    if (includeSequence && utf8Bytes(lead) > MAX_BODY_BYTES) throw new UpstreamShapeError('基因ID/序列前缀摘要超过正文预算，无法完整展示声明的序列长度', { url: prepared.url });
    const body = `${lead}${renderFields([
      ['物种', organism], ['响应版本', version], ['响应候选装配数', assemblies.length],
      ['蛋白长度', protein === undefined ? '未知（响应null）' : `${protein.length} aa`],
      ['KEGG', annotation(data, 'kegg', prepared.url)], ['基因家族', annotation(data, 'geneFamilies', prepared.url)],
      ['GO', annotation(data, 'geneOntology', prepared.url)], ['代谢注释', annotation(data, 'metabolism', prepared.url)],
    ])}`;
    return finish(body, res, data, prepared, `species=${organism}；version=${version}；装配/注释版本仅按响应转述，不由ID推断`);
  },
});

const expression = checked({
  name: 'strawberry_expression',
  description: '查询已证实的草莓表达数据集中的单基因组织表达，按上游组织mean降序展示top（1–30，默认8）。geneId/dataset最多256码点。不推广到相关病原；保留响应dataset、profileType和原单位batch-corrected TPM，不跨数据集比较。组织均值为上游字段，不自行重算样本。',
  parameters: { type: 'object', properties: { geneId, dataset: string('状态目录dataset原字符串，最多256码点'), top: integer(1, 30, 8) }, required: ['geneId'], additionalProperties: false },
  async run(args, ctx) {
    const top = (args.top as number | undefined) ?? 8;
    const { prepared, res, data } = await request(ctx, '/transcriptome/search', { geneId: args.geneId, dataset: args.dataset }, { top });
    const dataset = field(data, 'dataset', 'string', prepared.url);
    const profileType = field(data, 'profileType', 'string', prepared.url);
    const unit = field(data, 'unit', 'string', prepared.url);
    const id = field(data, 'geneId', 'string', prepared.url);
    const tissues = rows(data, 'tissues', prepared.url);
    requireArrayField(data, 'samples', prepared.url, '表达样本');
    if (!tissues.length) throw new UpstreamShapeError('尚未实测此表达空组织形态，不能仅凭[]判为合法无表达', { url: prepared.url });
    for (const t of tissues) {
      field(t, 'label', 'string', prepared.url);
      field(t, 'mean', 'number', prepared.url);
      count(t, 'sampleCount', prepared.url);
      count(t, 'detectedSamples', prepared.url);
    }
    const detected = count(data, 'detectedSamples', prepared.url);
    const selected = [...tissues].sort((a, b) => (b.mean as number) - (a.mean as number)).slice(0, top);
    const body = tableBody((shown) => `基因${id}；组织${tissues.length}个；实际展示${shown}个（按上游mean降序）。\n检测样本数${detected}（detectedSamples，不是总样本数）；单位${unit}。\nmean/sampleCount均为上游组织聚合字段，不自行重算；不同数据集不可直接比较。`,
      ['组织', 'mean', 'sampleCount', 'detectedSamples'], selected.map((t) => [t.label, Number((t.mean as number).toPrecision(6)), t.sampleCount, t.detectedSamples]), prepared.url);
    return finish(body, res, data, prepared, `dataset=${dataset}；profileType=${profileType}；unit=${unit}；数据/装配版本未单独声明则未知`);
  },
});

const synteny = checked({
  name: 'strawberry_synteny',
  description: '查询已证实草莓装配间的基因共线区块；geneId/sourceAssembly/targetAssembly必填，各最多256码点，装配ID来自状态目录而不是物种名。maxBlocks为本地展示上限1–10默认5。保留分析ID、源/目标装配、总块数和上游截断标记；不宣称病原全覆盖，共线不等于一对一正交或功能等价。',
  parameters: { type: 'object', properties: { geneId, sourceAssembly: string('源装配精确ID，最多256码点'), targetAssembly: string('目标装配精确ID，最多256码点'), maxBlocks: integer(1, 10, 5) }, required: ['geneId', 'sourceAssembly', 'targetAssembly'], additionalProperties: false },
  async run(args, ctx) {
    const maxBlocks = (args.maxBlocks as number | undefined) ?? 5;
    const { prepared, res, data } = await request(ctx, '/synteny/search', { geneId: args.geneId, sourceAssembly: args.sourceAssembly, targetAssembly: args.targetAssembly }, { maxBlocks });
    const analysis = field(data, 'analysisId', 'string', prepared.url);
    const source = object(data.sourceAssembly, prepared.url, 'sourceAssembly');
    const target = object(data.targetAssembly, prepared.url, 'targetAssembly');
    const sourceId = field(source, 'id', 'string', prepared.url);
    const targetId = field(target, 'id', 'string', prepared.url);
    const sourceVersion = field(source, 'version', 'string', prepared.url);
    const targetVersion = field(target, 'version', 'string', prepared.url);
    object(data.queryGene, prepared.url, 'queryGene');
    field(data, 'anchored', 'boolean', prepared.url);
    const truncated = field(data, 'truncated', 'boolean', prepared.url);
    const total = count(data, 'totalBlockCount', prepared.url);
    const blocks = rows(data, 'blocks', prepared.url);
    if (!blocks.length || total < blocks.length || (!truncated && total !== blocks.length)) throw new UpstreamShapeError('共线块为空或计数不一致，未验证此空形态的业务含义', { url: prepared.url });
    for (const block of blocks) {
      field(block, 'sourceSeq', 'string', prepared.url);
      field(block, 'targetSeq', 'string', prepared.url);
      count(block, 'anchorCount', prepared.url);
      field(object(block.matchedTargetGene, prepared.url, 'matchedTargetGene'), 'displayId', 'string', prepared.url);
    }
    const body = tableBody((shown) => `共线分析${analysis}\n响应装配${sourceId} → ${targetId}。\n总块数${total}；上游返回${blocks.length}；实际展示${shown}；上游truncated=${truncated}。\n共线不等于一对一正交或功能等价；覆盖不推广至病原全部装配。`,
      ['源染色体', '目标染色体', '匹配目标基因', '锚点'], blocks.slice(0, maxBlocks).map((b) => [b.sourceSeq, b.targetSeq, (b.matchedTargetGene as Obj).displayId, b.anchorCount]), prepared.url);
    return finish(body, res, data, prepared, `analysisId=${analysis}；sourceAssembly=${sourceId}；sourceVersion=${sourceVersion}；targetAssembly=${targetId}；targetVersion=${targetVersion}`);
  },
});

const tfMembers = checked({
  name: 'strawberry_tf_members',
  description: '查已证实的Fragaria转录因子成员，不推广至相关病原。family/species/assembly/type至少一个非空筛选；单值筛选，family/assembly/type最多256码点，species512。page为1–100000默认1，pageSize为1–100默认20；本地最多20条且按字节再裁行，分别报告上游total/本页返回/实际展示。拒绝summary模式；release仅取本次响应，缺失则未知。',
  parameters: { type: 'object', properties: { family: string('TF家族，单值，最多256码点'), species, assembly: string('TF目录精确assembly ID，单值，最多256码点'), type: string('TF目录type原字符串，最多256码点'), page: integer(1, 100000, 1), pageSize: integer(1, 100, 20) }, additionalProperties: false },
  async run(args, ctx) {
    if (!['family', 'species', 'assembly', 'type'].some((key) => args[key] !== undefined)) throw new InvalidArgumentError('TF成员查询至少需要family/species/assembly/type中的一个非空筛选，尚未联网');
    const page = (args.page as number | undefined) ?? 1;
    const pageSize = (args.pageSize as number | undefined) ?? 20;
    const { prepared, res, data } = await request(ctx, '/tf/search', { family: args.family, species: args.species, assembly: args.assembly, type: args.type, page, pageSize }, { maxShown: 20 });
    if (data.mode !== 'matches') throw new UpstreamShapeError('有筛选的TF查询未返回matches模式（意外summary），不能解释为成员0条', { url: prepared.url });
    const total = count(data, 'total', prepared.url);
    const matches = rows(data, 'matches', prepared.url);
    const returnedPage = count(data, 'page', prepared.url);
    const returnedSize = count(data, 'pageSize', prepared.url);
    const totalPages = count(data, 'totalPages', prepared.url);
    if (returnedPage !== page || returnedSize !== pageSize || matches.length > returnedSize || total < matches.length || (total === 0 && matches.length !== 0)) throw new UpstreamShapeError('TF分页或计数不一致', { url: prepared.url });
    for (const m of matches) {
      for (const key of ['geneId', 'family', 'scientificName', 'assemblyId']) field(m, key, 'string', prepared.url);
    }
    let release = '未知（本次响应未声明）';
    if (data.summary !== null && data.summary !== undefined) {
      const summary = object(data.summary, prepared.url, 'summary');
      if (summary.release !== undefined && summary.release !== null) release = field(object(summary.release, prepared.url, 'release'), 'id', 'string', prepared.url);
    }
    const body = tableBody((shown) => `TF成员：上游total=${total}；本页返回${matches.length}；实际展示${shown}。\n响应页${returnedPage}；pageSize=${returnedSize}；totalPages=${totalPages}。${total === 0 ? '已验证合法空结果（matches模式且total=0）。' : matches.length === 0 ? '本页为空，不代表全库零成员。' : ''}\n覆盖Fragaria TF模块，不推广至相关病原。`,
      ['geneId', 'family', '物种', 'assemblyId'], matches.slice(0, 20).map((m) => [m.geneId, m.family, m.scientificName, m.assemblyId]), prepared.url);
    return finish(body, res, data, prepared, `TF release=${release}；成员装配以响应assemblyId为准，不按ID推断`);
  },
});

export const tools: ToolDefinition[] = [catalog, geneLookup, expression, synteny, tfMembers];

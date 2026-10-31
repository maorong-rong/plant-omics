import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { renderFields, renderTable, utf8Bytes } from '../../core/format.js';
import { validateArgs } from '../../core/invoke.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest, withRequestEvidence } from '../../core/request.js';
import type { HttpResult, JsonSchema, ToolContext, ToolDefinition } from '../../core/types.js';
import { manifest } from './manifest.js';

type Obj = Record<string, unknown>;

/** 自由文本里出现邮箱就连同所在字段一起省略（v7 §六：只做键名拦截与邮箱扫描两道）。 */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const MAX_ID_CODE_POINTS = 128;
const DESCRIPTION_LIMIT = 300;
/** 正文预算：给隐私省略提示留余量，避免 finishResult 再按字节截断。 */
const BODY_BUDGET = MAX_BODY_BYTES - 128;

const string = (description: string): JsonSchema => ({ type: 'string', description });
const entityOf = (values: readonly string[], description: string): JsonSchema => ({
  type: 'string',
  enum: [...values],
  description,
});

function object(value: unknown, url: string, what: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpstreamShapeError(`${what}不是对象，无法判为无结果`, { url });
  }
  return value as Obj;
}

/** 身份键必须存在：缺键是结构漂移，不许折成查无。 */
function requiredKey(data: Obj, key: string, url: string): void {
  if (!(key in data)) {
    throw new UpstreamShapeError(`响应缺少身份字段 ${key}，无法判断是查无还是结构漂移`, { url });
  }
}

function nonEmptyString(value: unknown, url: string, what: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new UpstreamShapeError(`${what}缺失或不是非空字符串`, { url });
  }
  return value.trim();
}

/** 可选字符串：null/缺失 → undefined；类型不对 → 结构漂移。 */
function optString(data: Obj, key: string, url: string): string | undefined {
  const value = data[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new UpstreamShapeError(`字段 ${key} 类型不是字符串`, { url });
  const text = value.trim();
  return text ? text : undefined;
}

/** GWH 把计数写成字符串 "0"，也接受数字；其他类型算漂移。只用于展示，不参与查无判定。 */
function optCount(data: Obj, key: string, url: string): number | undefined {
  const value = data[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{1,12}$/.test(value.trim())) return Number(value.trim());
  throw new UpstreamShapeError(`字段 ${key} 既不是数字也不是数字字符串`, { url });
}

function optIdLike(data: Obj, key: string, url: string): string | undefined {
  const value = data[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new UpstreamShapeError(`字段 ${key} 既不是字符串也不是数字`, { url });
}

function safe(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return EMAIL_PATTERN.test(text) ? undefined : text;
}

/** 错误文本里回显上游取值前先过隐私扫描，并截短。 */
function safeEcho(value: unknown): string {
  const text = String(value);
  if (EMAIL_PATTERN.test(text)) return '（上游取值含联系方式，已省略）';
  return [...text].slice(0, 64).join('');
}

/** 正文整行隐私扫描：命中邮箱的行整行省略并计数。 */
function scrubBody(body: string): string {
  const kept: string[] = [];
  let omitted = 0;
  for (const line of body.split('\n')) {
    if (EMAIL_PATTERN.test(line)) {
      omitted += 1;
      continue;
    }
    kept.push(line);
  }
  if (omitted === 0) return body;
  return `${kept.join('\n')}\n（另有 ${omitted} 行含联系方式文本，已整行省略）`;
}

/** raw 投影统一扫描：命中邮箱的字符串值置为 null，形状不变。 */
function scrubRaw(value: unknown): unknown {
  if (typeof value === 'string') return EMAIL_PATTERN.test(value) ? null : value;
  if (Array.isArray(value)) return value.map((item) => scrubRaw(item));
  if (value && typeof value === 'object') {
    const out: Obj = {};
    for (const [key, item] of Object.entries(value as Obj)) out[key] = scrubRaw(item);
    return out;
  }
  return value;
}

function idArg(args: Record<string, unknown>): string {
  const raw = args.id;
  if (typeof raw !== 'string') throw new InvalidArgumentError('参数 id 必须是字符串');
  // 不 trim、不改写：只检查原始串，拼 URL 时按原始串编码一次。
  if (raw.trim() === '') throw new InvalidArgumentError('参数 id 不能为空（尚未联网）');
  if (raw !== raw.trim()) {
    throw new InvalidArgumentError('参数 id 首尾含空白；本仓不改写输入，请去掉空白后重试（尚未联网）');
  }
  if ([...raw].length > MAX_ID_CODE_POINTS) {
    throw new InvalidArgumentError(`参数 id 超过本仓 ${MAX_ID_CODE_POINTS} 个 Unicode 码点上限（尚未联网）`);
  }
  if (/[\u0000-\u001F\u007F]/.test(raw)) {
    throw new InvalidArgumentError('参数 id 含控制字符，拒绝拼进 URL（尚未联网）');
  }
  return raw;
}

function entityArg(args: Record<string, unknown>, values: readonly string[]): string {
  const raw = args.entity;
  if (typeof raw !== 'string' || !values.includes(raw)) {
    throw new InvalidArgumentError(`参数 entity 必须是 ${values.join(' / ')} 之一`);
  }
  return raw;
}

/** 正文按 UTF-8 字节逐行填充；塞不下的行整行丢弃，不切半行。 */
function fitLines(lines: string[], url: string): string {
  let body = '';
  for (const line of lines) {
    const candidate = body ? `${body}\n${line}` : line;
    if (utf8Bytes(candidate) > BODY_BUDGET) break;
    body = candidate;
  }
  if (!body) throw new UpstreamShapeError('首个摘要行已超出正文预算，无法在不失真的前提下展示', { url });
  return body;
}

function checked(def: ToolDefinition): ToolDefinition {
  const run = def.run;
  def.run = async (args, ctx) => {
    validateArgs(def, args);
    return withRequestEvidence(ctx, (scoped) => run(args, scoped));
  };
  return def;
}

function endpoint(path: string): string {
  return `${manifest.apiBase}${path}`;
}

async function request(ctx: ToolContext, path: string) {
  const prepared = prepareRequest({ url: endpoint(path), sourceName: manifest.displayName });
  const res = await fetchPrepared(ctx, prepared);
  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(`上游 HTTP ${res.status}，不是成功结果`, {
      url: prepared.url,
      request: prepared.request,
      status: res.status,
      contentType: res.contentType,
    });
  }
  if (res.contentType && !/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(res.contentType)) {
    throw new UpstreamError('上游响应格式错误：成功响应不是 JSON', {
      url: prepared.url,
      request: prepared.request,
      status: res.status,
      contentType: res.contentType,
    });
  }
  return { prepared, res, data: object(res.data, prepared.url, '上游响应') };
}

function finish(body: string, res: HttpResult, raw: unknown, prepared: ReturnType<typeof prepareRequest>, extra: string) {
  // 统一出口：正文整行隐私扫描 + raw 投影字符串扫描，任何字段都走同一条路。
  return finishResult({ body: scrubBody(body), res, raw: scrubRaw(raw), prepared, sourceId: manifest.id, extra });
}

function notFound(what: string, hint: string, res: HttpResult, raw: unknown, prepared: ReturnType<typeof prepareRequest>, extra: string) {
  const body = `未找到：${what}\n上游用 HTTP 200 + 特定空结构表示查无（不是 404）；这不等于该 ID 从未存在。\n${hint}`;
  return finish(body, res, raw, prepared, extra);
}

function integrity(message: string, prepared: ReturnType<typeof prepareRequest>): never {
  throw new UpstreamShapeError(`响应与请求不一致：${message}`, {
    url: prepared.url,
    request: prepared.request,
  });
}

const assemblyLookup = checked({
  name: 'gwh_assembly_lookup',
  description:
    '按精确 ID 查 GWH 的基因组/组装详情：entity=genome 用于纯数字 genome_id（取物种、代表组装及下一步 accession），entity=assembly 用于 GWH 组装号（取组装级别、项目/样本 accession 与六类下载路径）。需要精确 ID，不按物种搜索；只给路径不下载文件；GCA_/GCF_ 不在范围；查无是 HTTP 200 空结构。',
  parameters: {
    type: 'object',
    properties: {
      entity: entityOf(['genome', 'assembly'], 'genome 用纯数字 genome_id；assembly 用 GWH* 组装号'),
      id: string('精确 ID：entity=genome 时是纯数字 genome_id；entity=assembly 时是 GWH 开头的组装号，最多128码点'),
    },
    required: ['entity', 'id'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const entity = entityArg(args, ['genome', 'assembly']);
    const id = idArg(args);

    if (entity === 'genome' && !/^\d{1,12}$/.test(id)) {
      throw new InvalidArgumentError('entity=genome 的 id 是纯数字 genome_id（例如 1）；组装 accession 请用 entity=assembly');
    }
    if (entity === 'assembly') {
      if (/^GC[AF]_/i.test(id)) {
        throw new InvalidArgumentError('GCA_/GCF_ 是 NCBI 组装号，GWH 只接受本库的 GWH accession（例如 GWHAAAA00000000）');
      }
      if (!/^GWH[A-Za-z0-9]+$/.test(id)) {
        throw new InvalidArgumentError('entity=assembly 的 id 必须是 GWH 开头的组装号；其他形态上游只返回全 null，无法与查无区分，因此本地拒绝');
      }
    }

    const path = entity === 'genome' ? `/genome/${encodeURIComponent(id)}` : `/assembly/${encodeURIComponent(id)}`;
    const { prepared, res, data } = await request(ctx, path);

    if (entity === 'genome') {
      requiredKey(data, 'id', prepared.url);
      requiredKey(data, 'organism', prepared.url);
      const idValue = data.id;
      const organismValue = data.organism;
      if (idValue === null && organismValue === null) {
        return notFound(
          `genome_id=${id} 未命中：上游对该 ID 返回空记录（id 与 organism 均为 null）；这不等于该基因组从未存在`,
          'genome_id 是纯数字；若要查组装，请从物种记录里的 representativeAssemblyAccession 取 GWH 组装号。',
          res,
          { id: null, organism: null },
          prepared,
          '上游 genome 端点无 release/版本字段时版本未知',
        );
      }
      if (idValue === null || organismValue === null) {
        throw new UpstreamShapeError('身份字段 id/organism 一半为 null，矛盾信封，既不判查无也不判正常', {
          url: prepared.url,
          request: prepared.request,
        });
      }
      if (String(idValue) !== id) integrity(`请求 genome_id=${id}，响应 id=${safeEcho(idValue)}`, prepared);
      const organismRaw = nonEmptyString(organismValue, prepared.url, 'organism');
      const organism = safe(organismRaw) ?? '（上游字段含联系方式，已省略）';

      const accession = optIdLike(data, 'representativeAssemblyAccession', prepared.url);
      const body = fitLines(
        [
          `基因组 ${id}：${organism}`,
          accession
            ? `下一步：用 entity=assembly + ${accession} 取组装级别与六类下载路径。`
            : '上游未给代表组装 accession，无法继续到组装层。',
          renderFields([
            ['分类类型', optString(data, 'organismType', prepared.url)],
            ['taxId', optIdLike(data, 'taxId', prepared.url)],
            ['代表组装 accession', accession],
            ['代表组装名称', optString(data, 'representativeAssemblyName', prepared.url)],
            ['代表组装级别', optString(data, 'representativeAssemblyLevel', prepared.url)],
            ['其他组装数（上游字段）', optCount(data, 'otherAssembliesCount', prepared.url)],
            ['发布日期', optString(data, 'releaseTime', prepared.url)],
          ]),
        ].filter(Boolean),
        prepared.url,
      );
      return finish(
        body,
        res,
        {
          id: String(idValue),
          organism: safe(organismRaw) ?? null,
          organismType: optString(data, 'organismType', prepared.url) ?? null,
          taxId: optIdLike(data, 'taxId', prepared.url) ?? null,
          representativeAssemblyAccession: accession ?? null,
          representativeAssemblyName: optString(data, 'representativeAssemblyName', prepared.url) ?? null,
          representativeAssemblyLevel: optString(data, 'representativeAssemblyLevel', prepared.url) ?? null,
          otherAssembliesCount: optCount(data, 'otherAssembliesCount', prepared.url) ?? null,
          releaseTime: optString(data, 'releaseTime', prepared.url) ?? null,
        },
        prepared,
        '版本/组装级别只按响应字段转述，不由 ID 外观推断',
      );
    }

    requiredKey(data, 'assemblyAccession', prepared.url);
    requiredKey(data, 'organism', prepared.url);
    const accessionValue = data.assemblyAccession;
    const organismValue = data.organism;
    if (accessionValue === null && organismValue === null) {
      return notFound(
        `组装 ${id} 未命中：上游对该组装号返回空记录（assemblyAccession 与 organism 均为 null）；这不等于该组装从未存在`,
        'GWH 只收本库 GWH 组装号；NCBI 的 GCA_/GCF_ 不在范围。',
        res,
        { assemblyAccession: null, organism: null },
        prepared,
        '上游 assembly 端点无 release/版本字段时版本未知',
      );
    }
    if (accessionValue === null || organismValue === null) {
      throw new UpstreamShapeError('身份字段 assemblyAccession/organism 一半为 null，矛盾信封', {
        url: prepared.url,
        request: prepared.request,
      });
    }
    if (String(accessionValue) !== id) integrity(`请求 assembly=${id}，响应 assemblyAccession=${safeEcho(accessionValue)}`, prepared);
    const organismRaw = nonEmptyString(organismValue, prepared.url, 'organism');
    const organism = safe(organismRaw) ?? '（上游字段含联系方式，已省略）';

    const paths: Array<[string, string]> = [
      ['DNA', 'ftpPathDna'],
      ['GFF', 'ftpPathGff'],
      ['RNA', 'ftpPathRna'],
      ['CDS', 'ftpPathCds'],
      ['Protein', 'ftpPathProtein'],
      ['Feature', 'ftpPathFeature'],
    ];
    const projection: Obj = {
      organism: safe(organismRaw) ?? null,
      taxId: optIdLike(data, 'taxId', prepared.url) ?? null,
      assemblyAccession: String(accessionValue),
      assemblyName: optString(data, 'assemblyName', prepared.url) ?? null,
      assemblyLevel: optString(data, 'assemblyLevel', prepared.url) ?? null,
      genomeRepresentation: optIdLike(data, 'genomeRepresentation', prepared.url) ?? null,
      bioprojectAccession: optIdLike(data, 'bioprojectAccession', prepared.url) ?? null,
      biosampleAccession: optIdLike(data, 'biosampleAccession', prepared.url) ?? null,
      releaseTime: optString(data, 'releaseTime', prepared.url) ?? null,
      publicationLink: optString(data, 'publicationLink', prepared.url) ?? null,
    };
    const pathLines: string[] = [];
    for (const [label, key] of paths) {
      const value = optString(data, key, prepared.url);
      projection[key] = value ?? null;
      if (value) pathLines.push(`- ${label}：${value}`);
    }

    const body = fitLines(
      [
        `组装 ${String(accessionValue)}：${organism}`,
        renderFields([
          ['taxId', projection.taxId],
          ['组装名称', projection.assemblyName],
          ['组装级别', projection.assemblyLevel],
          ['基因代表类型', projection.genomeRepresentation],
          ['BioProject', projection.bioprojectAccession],
          ['BioSample', projection.biosampleAccession],
          ['发布日期', projection.releaseTime],
        ]),
        '组装只给项目/样本 accession；上游不提供“由组装列出样本”，样本详情请用 entity=sample。',
        pathLines.length ? `下载路径（只给路径，不下载、不校验可下载性）：\n${pathLines.join('\n')}` : '上游未提供下载路径。',
        safe(optString(data, 'publicationLink', prepared.url))
          ? `文献链接：${safe(optString(data, 'publicationLink', prepared.url))}`
          : '文献题录：上游给的是含作者姓名的题录字符串，本仓未列入白名单，未展示（可用 publicationLink 取 DOI）。',
      ],
      prepared.url,
    );
    return finish(body, res, projection, prepared, '版本只按响应 releaseTime 转述，不由 accession 推断');
  },
});

const projectSampleLookup = checked({
  name: 'gwh_project_sample_lookup',
  description:
    '按精确 ID 查 GWH 的项目或样本元数据：entity=project 用于 PRJCA 项目（标题、描述、分类单元、数据类型、文献条数），entity=sample 用于 SAMC 样本（物种、样本类型、组织等属性）。需要精确 accession；项目与样本是平行入口，上游不返回项目下的样本列表，也不返回样本所属项目；项目/样本只收 PRJCA/SAMC，PRJNA/PRJDB/SAMN/SAMEA 不在范围。',
  parameters: {
    type: 'object',
    properties: {
      entity: entityOf(['project', 'sample'], 'project 用 PRJCA 项目号；sample 用 SAMC 样本号'),
      id: string('精确 accession：entity=project 时以 PRJCA 开头；entity=sample 时以 SAMC 开头，最多128码点'),
    },
    required: ['entity', 'id'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const entity = entityArg(args, ['project', 'sample']);
    const id = idArg(args);

    if (entity === 'project' && !/^PRJCA\d{1,12}$/.test(id)) {
      throw new InvalidArgumentError('entity=project 只接受 GWH 的 PRJCA 项目号；PRJNA/PRJDB 是 NCBI/EBI 编号，不在本工具范围');
    }
    if (entity === 'sample' && !/^SAMC\d{1,12}$/.test(id)) {
      throw new InvalidArgumentError('entity=sample 只接受 GWH 的 SAMC 样本号；SAMN/SAMEA 是 NCBI/EBI 编号，不在本工具范围（实测上游对 SAMN 只回 Nonentity）');
    }

    const path = entity === 'project' ? `/bioProject/${encodeURIComponent(id)}` : `/bioSample/${encodeURIComponent(id)}`;
    const { prepared, res, data } = await request(ctx, path);

    requiredKey(data, 'message', prepared.url);
    if (typeof data.message !== 'string') {
      throw new UpstreamShapeError('message 字段不是字符串，无法判断查无/正常', { url: prepared.url, request: prepared.request });
    }

    if (entity === 'project') {
      requiredKey(data, 'title', prepared.url);
      requiredKey(data, 'prjAccession', prepared.url);
      if (data.message === 'Nonentity') {
        if (data.title !== null) {
          throw new UpstreamShapeError('message=Nonentity 但 title 非空，矛盾信封', { url: prepared.url, request: prepared.request });
        }
        // 查无也要核验回显身份：否则一个错响应会被伪装成“当前查询的查无结果”。
        if (String(data.prjAccession) !== id) {
          integrity(`查无响应回显 prjAccession=${safeEcho(data.prjAccession)} 与请求 project=${id} 不一致`, prepared);
        }
        return notFound(
          `项目 ${id} 未命中：上游返回 message=Nonentity 且 title 为空；这不等于该项目从未存在`,
          'PRJCA 是 GWH 的项目号；项目与样本是平行入口，上游不提供“从项目列样本”。',
          res,
          { message: 'Nonentity', prjAccession: safeEcho(data.prjAccession), title: null },
          prepared,
          '项目版本只按响应 releaseTime 转述',
        );
      }
      if (data.message !== 'SUCCESS') {
        throw new UpstreamShapeError(`未预期的 message 取值（${data.message.length} 字符），无法判断查无/正常`, {
          url: prepared.url,
          request: prepared.request,
        });
      }
      if (data.title === null) {
        throw new UpstreamShapeError('message=SUCCESS 但 title 为 null，矛盾信封', { url: prepared.url, request: prepared.request });
      }
      const titleRaw = nonEmptyString(data.title, prepared.url, 'title');
      const title = safe(titleRaw) ?? '（标题含联系方式，已省略）';
      if (String(data.prjAccession) !== id) integrity(`请求 project=${id}，响应 prjAccession=${safeEcho(data.prjAccession)}`, prepared);

      const description = safe(optString(data, 'description', prepared.url));
      const truncated = description !== undefined && [...description].length > DESCRIPTION_LIMIT;
      const descText = description === undefined ? undefined : truncated ? `${[...description].slice(0, DESCRIPTION_LIMIT).join('')}…（已截断）` : description;

      const taxonLines: string[] = [];
      const taxonRows: Array<{ name: string; taxonId: string | null }> = [];
      const taxons = data.taxons;
      let taxonTotal = 0;
      if (taxons !== null && taxons !== undefined) {
        if (!Array.isArray(taxons)) throw new UpstreamShapeError('taxons 不是数组', { url: prepared.url, request: prepared.request });
        taxonTotal = taxons.length;
        for (const item of taxons.slice(0, 10)) {
          const taxon = object(item, prepared.url, 'taxons 成员');
          const name = optString(taxon, 'name', prepared.url) ?? optString(taxon, 'scientificName', prepared.url);
          const taxonId = optIdLike(taxon, 'taxonId', prepared.url);
          const safeName = safe(name);
          if (!safeName) continue;
          taxonRows.push({ name: safeName, taxonId: taxonId ?? null });
          taxonLines.push(`- ${safeName}${taxonId ? `（taxId ${taxonId}）` : ''}`);
        }
      }

      const dataTypes: string[] = [];
      const types = data.dataTypes;
      let dataTypeTotal = 0;
      if (types !== null && types !== undefined) {
        if (!Array.isArray(types)) throw new UpstreamShapeError('dataTypes 不是数组', { url: prepared.url, request: prepared.request });
        dataTypeTotal = types.length;
        for (const item of types.slice(0, 5)) {
          const type = object(item, prepared.url, 'dataTypes 成员');
          const name = safe(optString(type, 'dataTypeName', prepared.url));
          if (name) dataTypes.push(name);
        }
      }

      const publicationCount = data.listPublication === null || data.listPublication === undefined ? 0 : Array.isArray(data.listPublication) ? data.listPublication.length : -1;
      if (publicationCount < 0) throw new UpstreamShapeError('listPublication 不是数组', { url: prepared.url, request: prepared.request });
      const publicationLines: string[] = [];
      for (const item of (data.listPublication as unknown[] | null | undefined ?? []).slice(0, 2)) {
        const row = object(item, prepared.url, 'listPublication 成员');
        const articleTitle = safe(optString(row, 'articleTitle', prepared.url));
        const doi = safe(optString(row, 'doi', prepared.url));
        const journal = safe(optString(row, 'journalTitle', prepared.url));
        const year = optIdLike(row, 'year', prepared.url);
        const pubmedId = optIdLike(row, 'pubmedId', prepared.url);
        if (!articleTitle) continue;
        publicationLines.push(`- ${articleTitle}${journal ? `｜${journal}` : ''}${year ? ` ${year}` : ''}${doi ? `｜${doi}` : ''}${pubmedId ? `｜PMID ${pubmedId}` : ''}`);
      }

      const scope = data.sampleScope === null || data.sampleScope === undefined ? undefined : object(data.sampleScope, prepared.url, 'sampleScope');
      const scopeName = scope ? safe(optString(scope, 'sampleScopeName', prepared.url)) : undefined;

      const body = fitLines(
        [
          `项目 ${id}：${title}`,
          descText ? `描述：${descText}` : '',
          renderFields([
            ['范围类型', scopeName],
            ['数据类型', dataTypes.length ? `${dataTypes.join('、')}（本次返回 ${dataTypeTotal} 项，最多展示 5 项）` : undefined],
            ['分类单元', taxonTotal ? `本次返回 ${taxonTotal} 项，最多展示 10 项` : undefined],
            ['发布日期', optString(data, 'releaseTime', prepared.url)],
          ]),
          '上游不返回样本列表：要样本请拿 SAMC accession 用 entity=sample 查。',
          `文献：本次返回 ${publicationCount} 条，最多展示 2 条（不表示全库或该项目的总数）。`,
          publicationLines.length ? publicationLines.join('\n') : '（本次未展示文献条目）',
          taxonLines.length ? `分类单元：\n${taxonLines.join('\n')}` : '',
        ].filter(Boolean),
        prepared.url,
      );
      return finish(
        body,
        res,
        {
          prjAccession: safeEcho(data.prjAccession),
          title,
          description: descText ?? null,
          taxonRows,
          taxonReturned: taxonTotal,
          dataTypes,
          dataTypeReturned: dataTypeTotal,
          releaseTime: optString(data, 'releaseTime', prepared.url) ?? null,
          sampleScopeName: scopeName ?? null,
          publicationReturned: publicationCount,
        },
        prepared,
        '项目版本只按响应 releaseTime 转述；文献只报本次返回条数，不声称全量',
      );
    }

    requiredKey(data, 'accession', prepared.url);
    if (data.message === 'Nonentity') {
      if (data.accession !== null) {
        throw new UpstreamShapeError('message=Nonentity 但 accession 非空，矛盾信封', { url: prepared.url, request: prepared.request });
      }
      return notFound(
        `样本 ${id} 未命中：上游返回 message=Nonentity 且 accession 为 null；这不等于该样本从未存在`,
        'SAMC 是 GWH 的样本号；样本与项目是平行入口，上游不返回样本所属项目。',
        res,
        { message: 'Nonentity', accession: null },
        prepared,
        '样本版本未声明则未知',
      );
    }
    if (data.message !== 'SUCCESS') {
      throw new UpstreamShapeError(`未预期的 message 取值（${data.message.length} 字符），无法判断查无/正常`, {
        url: prepared.url,
        request: prepared.request,
      });
    }
    if (data.accession === null) {
      throw new UpstreamShapeError('message=SUCCESS 但 accession 为 null，矛盾信封', { url: prepared.url, request: prepared.request });
    }
    if (String(data.accession) !== id) integrity(`请求 sample=${id}，响应 accession=${safeEcho(data.accession)}`, prepared);

    const sampleType = data.sampletype === null || data.sampletype === undefined ? undefined : object(data.sampletype, prepared.url, 'sampletype');
    const sampleTypeName = sampleType ? safe(optString(sampleType, 'sampleTypeName', prepared.url)) : undefined;
    const taxon = data.taxon === null || data.taxon === undefined ? undefined : object(data.taxon, prepared.url, 'taxon');
    const taxonName = taxon ? safe(optString(taxon, 'name', prepared.url)) : undefined;
    const taxonId = taxon ? optIdLike(taxon, 'taxonId', prepared.url) : undefined;

    const attributeLines: string[] = [];
    const attributes = data.sampleAttribute === null || data.sampleAttribute === undefined ? undefined : object(data.sampleAttribute, prepared.url, 'sampleAttribute');
    const ATTRIBUTE_KEYS: Array<[string, string]> = [
      ['组织', 'tissue'],
      ['品种/材料', 'cultivar'],
      ['发育阶段', 'devStage'],
      ['采集日期', 'collectionDate'],
      ['地理来源', 'geographicLocation'],
      ['温度', 'temperature'],
      ['处理', 'treatment'],
    ];
    const attributesProjection: Obj = {};
    if (attributes) {
      for (const [label, key] of ATTRIBUTE_KEYS) {
        const value = safe(optString(attributes, key, prepared.url));
        attributesProjection[key] = value ?? null;
        if (value) attributeLines.push(`- ${label}：${[...value].slice(0, 120).join('')}`);
      }
    }

    const body = fitLines(
      [
        `样本 ${id}：${safe(optString(data, 'title', prepared.url)) ?? safe(optString(data, 'name', prepared.url)) ?? '（无标题）'}`,
        renderFields([
          ['样本名称', safe(optString(data, 'name', prepared.url))],
          ['样本类型', sampleTypeName],
          ['物种', taxonName],
          ['taxId', taxonId],
        ]),
        '上游不返回样本所属项目；提交者联系方式字段按白名单一律不输出。',
        attributeLines.length ? `样本属性（只列白名单字段，空值不展示）：\n${attributeLines.join('\n')}` : '样本属性：白名单字段均为空，未展示。',
      ],
      prepared.url,
    );
    return finish(
      body,
      res,
      {
        accession: String(data.accession),
        name: safe(optString(data, 'name', prepared.url)) ?? null,
        title: safe(optString(data, 'title', prepared.url)) ?? null,
        sampleTypeName: sampleTypeName ?? null,
        taxon: { name: taxonName ?? null, taxonId: taxonId ?? null },
        sampleAttribute: attributesProjection,
      },
      prepared,
      '样本版本未声明则未知；联系方式字段（submitter 等）不进输出、raw 与错误文本',
    );
  },
});

export const tools: ToolDefinition[] = [assemblyLookup, projectSampleLookup];

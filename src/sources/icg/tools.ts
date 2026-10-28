import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../../core/errors.js';
import { renderFields, renderTable, utf8Bytes } from '../../core/format.js';
import { validateArgs } from '../../core/invoke.js';
import { fetchPrepared, finishResult, MAX_BODY_BYTES, prepareRequest, withRequestEvidence } from '../../core/request.js';
import type { HttpResult, JsonSchema, ToolContext, ToolDefinition } from '../../core/types.js';
import { manifest } from './manifest.js';

type Obj = Record<string, unknown>;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const MAX_ID_CODE_POINTS = 128;
const MAX_PROJECT_ROWS = 10;
const MAX_GENE_ROWS = 10;
/** 正文预算：给隐私省略提示留余量，避免 finishResult 再按字节截断。 */
const BODY_BUDGET = MAX_BODY_BYTES - 128;

const string = (description: string): JsonSchema => ({ type: 'string', description });
const integer = (minimum: number, maximum: number, value: number): JsonSchema => ({
  type: 'integer',
  minimum,
  maximum,
  default: value,
});

function object(value: unknown, url: string, what: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpstreamShapeError(`${what}不是对象`, { url });
  }
  return value as Obj;
}

function requiredKey(data: Obj, key: string, url: string): void {
  if (!(key in data)) {
    throw new UpstreamShapeError(`响应缺少字段 ${key}，无法判断查无/正常`, { url });
  }
}

function nonEmptyString(value: unknown, url: string, what: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new UpstreamShapeError(`${what}缺失或不是非空字符串`, { url });
  }
  return value.trim();
}

function optString(data: Obj, key: string, url: string): string | undefined {
  const value = data[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new UpstreamShapeError(`字段 ${key} 类型不是字符串`, { url });
  const text = value.trim();
  return text ? text : undefined;
}

function optScalar(data: Obj, key: string, url: string): string | number | undefined {
  const value = data[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.trim() ? value.trim() : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new UpstreamShapeError(`字段 ${key} 既不是字符串也不是数字`, { url });
}

function requireArray(data: Obj, key: string, url: string, what: string): unknown[] {
  requiredKey(data, key, url);
  const value = data[key];
  if (value === null) return [];
  if (!Array.isArray(value)) throw new UpstreamShapeError(`${what}字段 ${key} 不是数组`, { url });
  return value;
}

function safe(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return EMAIL_PATTERN.test(text) ? undefined : text;
}

/** 错误文本里回显上游取值前先过隐私扫描，并截短，避免把联系方式带进错误信息。 */
function safeEcho(value: unknown): string {
  const text = String(value);
  if (EMAIL_PATTERN.test(text)) return '（上游取值含联系方式，已省略）';
  return [...text].slice(0, 64).join('');
}

/**
 * 正文整行隐私扫描：任何一行命中邮箱模式就整行省略（字段级省略在渲染层做不到 100%，
 * 行级省略是保守做法），并注明省略了几行。
 */
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

/** raw 投影统一扫描：命中邮箱的字符串值置为 null，形状不变、内容不泄漏。 */
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

function idArg(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidArgumentError('参数 id 必须是字符串');
  // 不 trim、不改写原始输入：只做检查，拼 URL 时按原始串编码一次。
  const text = raw;
  if (text.trim() === '') throw new InvalidArgumentError('参数 id 不能为空（尚未联网）');
  if (text !== text.trim()) {
    throw new InvalidArgumentError('参数 id 首尾含空白；本仓不改写输入，请去掉空白后重试（尚未联网）');
  }
  if ([...text].length > MAX_ID_CODE_POINTS) {
    throw new InvalidArgumentError(`参数 id 超过本仓 ${MAX_ID_CODE_POINTS} 个 Unicode 码点上限（尚未联网；完整请求字节预算另由共享预检把关）`);
  }
  if (/[\u0000-\u001F\u007F]/.test(text)) {
    throw new InvalidArgumentError('参数 id 含控制字符，拒绝拼进 URL（尚未联网）');
  }
  if (text === '.' || text === '..') {
    throw new InvalidArgumentError('参数 id 不能是 "." 或 ".."（路径规范化危险值，尚未联网）');
  }
  return text;
}

function entityArg(args: Record<string, unknown>): string {
  const raw = args.entity;
  if (raw !== 'species' && raw !== 'project' && raw !== 'gene' && raw !== 'publication') {
    throw new InvalidArgumentError('参数 entity 必须是 species / project / gene / publication 之一');
  }
  return raw;
}

/** 正文按 UTF-8 字节逐块填充；块（一条基因/一条研究）要么整块在内，要么整块丢弃。 */
function fitBlocks(header: string, blocks: string[], url: string): { body: string; dropped: number } {
  if (utf8Bytes(header) > BODY_BUDGET) {
    throw new UpstreamShapeError('摘要头部已超出正文预算', { url });
  }
  let body = header;
  let dropped = 0;
  for (const block of blocks) {
    const candidate = `${body}\n${block}`;
    if (utf8Bytes(candidate) > BODY_BUDGET) {
      dropped += 1;
      continue;
    }
    body = candidate;
  }
  return { body, dropped };
}

/** @@ 分隔的列表：拆开、去空、限制条数，并标记是否还有未展示项。 */
function splitAtAt(value: string, limit: number): { items: string[]; truncated: boolean } {
  const items = value
    .split('@@')
    .map((item) => item.trim())
    .filter(Boolean);
  return { items: items.slice(0, limit), truncated: items.length > limit };
}

function checked(def: ToolDefinition): ToolDefinition {
  const run = def.run;
  def.run = async (args, ctx) => {
    validateArgs(def, args);
    return withRequestEvidence(ctx, (scoped) => run(args, scoped));
  };
  return def;
}

async function request(ctx: ToolContext, url: string) {
  const prepared = prepareRequest({ url, sourceName: manifest.displayName });
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
  // 统一出口做两件事：正文整行隐私扫描 + raw 白名单投影的字符串扫描。
  // 这样任何一条输出路径（含以后新增字段）都不依赖各自记得调 safe()。
  return finishResult({ body: scrubBody(body), res, raw: scrubRaw(raw), prepared, sourceId: manifest.id, extra });
}

function integrity(message: string, prepared: ReturnType<typeof prepareRequest>): never {
  throw new UpstreamShapeError(`响应与请求不一致：${message}`, { url: prepared.url, request: prepared.request });
}

/** 引物：非空字符串整条返回；null/空/缺键给缺项说明；其他类型算漂移。 */
function primer(data: Obj, key: string, url: string, label: string): { text?: string; note?: string } {
  const value = data[key];
  if (value === undefined || value === null) return { note: `该记录未提供${label}（是否允许为空未核验）` };
  if (typeof value !== 'string') throw new UpstreamShapeError(`${label}字段 ${key} 类型不是字符串`, { url });
  const text = value.trim();
  if (!text) return { note: `该记录未提供${label}（空字符串；是否允许为空未核验）` };
  if (EMAIL_PATTERN.test(text)) return { note: `${label}含邮箱文本，按隐私规则省略` };
  return { text };
}

const lookup = checked({
  name: 'icg_lookup',
  description:
    '按精确 ID 查 ICG 内参基因数据库的四层实体：entity=species 取物种及其研究列表，entity=project 取某研究的内参基因、引物与验证范围，entity=gene 取单基因的引物，entity=publication 取文献及其研究列表（id 为 PubMed 数字 ID）。层级必须显式选择，不按横杠数量推断、不自动换 entity。引物是该研究验证过的组合，不是通用推荐；不按基因名或性状检索。',
  parameters: {
    type: 'object',
    properties: {
      entity: {
        type: 'string',
        enum: ['species', 'project', 'gene', 'publication'],
        description: 'species：物种 ICG00001；project：研究 ICG00001-1；gene：基因 ICG00001-1-EF1a；publication：PubMed ID（纯数字）',
      },
      id: string('精确 ID，最多128码点；publication 用纯数字 PubMed ID'),
    },
    required: ['entity', 'id'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const entity = entityArg(args);
    const id = idArg(args.id);

    if (entity === 'publication' && !/^[0-9]+$/.test(id)) {
      throw new InvalidArgumentError('entity=publication 的 id 是 PubMed 数字 ID（纯数字字符串）；ICG accession 请用 entity=species/project/gene');
    }

    const { prepared, res, data } = await request(
      ctx,
      `${manifest.apiBase}/api/json/${entity}/${encodeURIComponent(id)}`,
    );

    requiredKey(data, 'code', prepared.url);
    requiredKey(data, 'result', prepared.url);
    if (typeof data.code !== 'string') {
      throw new UpstreamShapeError('code 字段不是字符串（上游用字符串表示状态）', { url: prepared.url, request: prepared.request });
    }
    if (data.code === '300') {
      if (data.result !== null) {
        throw new UpstreamShapeError('code=300 但 result 非 null，矛盾信封，不判查无', { url: prepared.url, request: prepared.request });
      }
      const body = `未找到：${entity} ${id} 没有有效记录\n上游用 code="300" + result=null 表示查无（不是 404），这不等于该 ID 从未存在。\n若该 ID 来自其他层级，请改选 entity（species / project / gene / publication）。`;
      return finish(body, res, { code: '300', result: null }, prepared, '查无时不展示上游 message 文本');
    }
    if (data.code !== '200') {
      throw new UpstreamShapeError(`未预期的 code=${safeEcho(data.code)}（只接受 "200" 正常 / "300" 查无），不展示上游 message`, {
        url: prepared.url,
        request: prepared.request,
      });
    }
    if (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) {
      throw new UpstreamShapeError('code=200 但 result 不是对象', { url: prepared.url, request: prepared.request });
    }
    const result = data.result as Obj;

    const identityKey = entity === 'publication' ? 'pmid' : 'accession';
    if (!(identityKey in result)) {
      throw new UpstreamShapeError(`result 缺少身份字段 ${identityKey}，无法与请求对账`, {
        url: prepared.url,
        request: prepared.request,
      });
    }
    if (String(result[identityKey]) !== id) {
      integrity(`请求 ${entity}=${id}，响应 ${identityKey}=${safeEcho(result[identityKey])}`, prepared);
    }

    const lastModified = optString(result, 'lastModified', prepared.url);

    if (entity === 'species') {
      const accession = nonEmptyString(result.accession, prepared.url, 'accession');
      const latinName = nonEmptyString(result.latinName, prepared.url, 'latinName');
      const projects = requireArray(result, 'projectList', prepared.url, '物种');
      const rows: string[] = [];
      for (const item of projects.slice(0, MAX_PROJECT_ROWS)) {
        const project = object(item, prepared.url, 'projectList 成员');
        const projectAccession = nonEmptyString(project.accession, prepared.url, 'projectList.accession');
        const name = safe(optString(project, 'name', prepared.url));
        const nameText = name ? (() => {
          const { items, truncated } = splitAtAt(name, 3);
          return `${items.join('、')}${truncated ? '…（还有未展示项）' : ''}`;
        })() : '（上游未给研究名）';
        rows.push(`- ${projectAccession}：${nameText}`);
      }
      const header = [
        `物种 ${accession}：${latinName}`,
        renderFields([
          ['俗名', safe(optString(result, 'commonName', prepared.url))],
          ['分类', safe(optString(result, 'category', prepared.url))],
          ['taxonomyId', optScalar(result, 'taxonomyId', prepared.url)],
          ['研究数（上游 studyNumber）', optScalar(result, 'studyNumber', prepared.url)],
          ['更新时间', lastModified],
        ]),
        `研究：本次返回 ${projects.length} 条，最多展示 ${MAX_PROJECT_ROWS} 条（不表示该物种的研究总数）。`,
      ]
        .filter(Boolean)
        .join('\n');
      const blocks = [
        ...rows,
        rows.length
          ? '物种层不含引物：用 projectList 里的 accession + entity=project 取基因与引物。'
          : '本层不含引物；上游未返回可用研究 accession，无法继续到引物层。',
      ];
      const fitted = fitBlocks(header, blocks, prepared.url);
      const omission = fitted.dropped > 0 ? `\n另有 ${fitted.dropped} 条因 4 KB 预算未展示（整条省略）。` : '';
      const body = utf8Bytes(`${fitted.body}${omission}`) <= BODY_BUDGET ? `${fitted.body}${omission}` : fitted.body;
      return finish(
        body,
        res,
        {
          accession,
          latinName,
          commonName: safe(optString(result, 'commonName', prepared.url)) ?? null,
          taxonomyId: optScalar(result, 'taxonomyId', prepared.url) ?? null,
          category: safe(optString(result, 'category', prepared.url)) ?? null,
          studyNumber: optScalar(result, 'studyNumber', prepared.url) ?? null,
          lastModified: lastModified ?? null,
          projectReturned: projects.length,
          projectAccessions: projects
            .slice(0, MAX_PROJECT_ROWS)
            .map((item) => String((item as Obj).accession ?? '')),
        },
        prepared,
        '分类/研究数只按响应字段转述；不含联系方式',
      );
    }

    if (entity === 'project') {
      const accession = nonEmptyString(result.accession, prepared.url, 'accession');
      const name = safe(optString(result, 'name', prepared.url));
      const nameSplit = name
        ? (() => {
            const { items, truncated } = splitAtAt(name, 3);
            return `${items.join('、')}${truncated ? '…（还有未展示条件）' : ''}`;
          })()
        : undefined;
      const evaluation = safe(optString(result, 'evaluationMethods', prepared.url));
      const genes = requireArray(result, 'geneList', prepared.url, '研究');
      const blocks: string[] = [];
      for (const item of genes.slice(0, MAX_GENE_ROWS)) {
        const gene = object(item, prepared.url, 'geneList 成员');
        const geneAccession = nonEmptyString(gene.accession, prepared.url, 'geneList.accession');
        const forward = primer(gene, 'primersForward', prepared.url, '正向引物');
        const reverse = primer(gene, 'primersReverse', prepared.url, '反向引物');
        const scope = safe(optString(gene, 'applicationScope', prepared.url));
        const scopeText = scope ? (() => {
          const { items, truncated } = splitAtAt(scope, 3);
          return `${items.join('、')}${truncated ? '…（还有未展示条件）' : ''}`;
        })() : undefined;
        const lines = [`- ${geneAccession}｜${safe(optString(gene, 'geneName', prepared.url)) ?? '（无基因名）'}（${safe(optString(gene, 'geneModel', prepared.url)) ?? '无模型'}）`];
        if (forward.text && reverse.text) lines.push(`  引物：F ${forward.text}／R ${reverse.text}`);
        else {
          if (forward.note) lines.push(`  ${forward.note}`);
          if (reverse.note) lines.push(`  ${reverse.note}`);
        }
        const metrics = [
          optScalar(gene, 'size', prepared.url) ? `片段 ${String(optScalar(gene, 'size', prepared.url))}` : '',
          optScalar(gene, 'tm', prepared.url) ? `Tm ${String(optScalar(gene, 'tm', prepared.url))}` : '',
          safe(optString(gene, 'detection', prepared.url)) ? `检测 ${safe(optString(gene, 'detection', prepared.url))}` : '',
        ].filter(Boolean);
        if (metrics.length) lines.push(`  ${metrics.join('；')}`);
        if (scopeText) lines.push(`  验证范围：${scopeText}（该研究验证过的条件，不是通用推荐）`);
        blocks.push(lines.join('\n'));
      }
      const header = [
        `研究 ${accession}：${nameSplit ?? '（上游未给研究名）'}`,
        renderFields([
          ['物种', safe(optString(result, 'species', prepared.url))],
          ['国家', safe(optString(result, 'country', prepared.url))],
          ['分子类型', safe(optString(result, 'molecularType', prepared.url))],
          ['评价方法（上游列表，已拆开）', evaluation ? splitAtAt(evaluation, 5).items.join('、') : undefined],
          ['文献 PMID', optScalar(result, 'pmid', prepared.url)],
          ['更新时间', lastModified],
        ]),
        `内参基因：本次返回 ${genes.length} 条，最多展示 ${MAX_GENE_ROWS} 条；引物整条输出或整条省略，不截半条。`,
        blocks.length ? '' : '（因预算或数据缺失，本次未展示任何基因条目；请按 gene accession 单查）',
      ]
        .filter(Boolean)
        .join('\n');
      const fitted = fitBlocks(header, blocks, prepared.url);
      const considered = Math.min(genes.length, MAX_GENE_ROWS);
      const shown = considered - fitted.dropped;
      const notes: string[] = [];
      if (genes.length > considered) notes.push(`另有 ${genes.length - considered} 条超出本地最多展示 ${MAX_GENE_ROWS} 条的上限`);
      if (fitted.dropped > 0) notes.push(`另有 ${fitted.dropped} 条因 4 KB 预算未展示（整块省略，未截断引物）`);
      const footer = notes.length ? `\n${notes.join('；')}。` : '';
      const body = `${fitted.body}${footer}`;
      if (utf8Bytes(body) > BODY_BUDGET) {
        throw new UpstreamShapeError('正文加省略说明后超出预算，拒绝返回可能被截断的基因条目', { url: prepared.url });
      }
      return finish(
        body,
        res,
        {
          accession,
          name: name ?? null,
          species: safe(optString(result, 'species', prepared.url)) ?? null,
          country: safe(optString(result, 'country', prepared.url)) ?? null,
          molecularType: safe(optString(result, 'molecularType', prepared.url)) ?? null,
          pmid: optScalar(result, 'pmid', prepared.url) ?? null,
          lastModified: lastModified ?? null,
          geneReturned: genes.length,
          geneShown: shown,
          genes: genes.slice(0, MAX_GENE_ROWS).map((item) => {
            const gene = item as Obj;
            return {
              accession: String(gene.accession ?? ''),
              geneName: safe(optString(gene, 'geneName', prepared.url)) ?? null,
              primersForward: primer(gene, 'primersForward', prepared.url, '正向引物').text ?? null,
              primersReverse: primer(gene, 'primersReverse', prepared.url, '反向引物').text ?? null,
              size: optScalar(gene, 'size', prepared.url) ?? null,
              tm: optScalar(gene, 'tm', prepared.url) ?? null,
              detection: safe(optString(gene, 'detection', prepared.url)) ?? null,
            };
          }),
        },
        prepared,
        '评价方法是上游验证方法（geNorm/NormFinder/BestKeeper），不是推荐等级；联系方式不输出',
      );
    }

    if (entity === 'gene') {
      const accession = nonEmptyString(result.accession, prepared.url, 'accession');
      const forward = primer(result, 'primersForward', prepared.url, '正向引物');
      const reverse = primer(result, 'primersReverse', prepared.url, '反向引物');
      const scope = safe(optString(result, 'applicationScope', prepared.url));
      const scopeText = scope ? (() => {
        const { items, truncated } = splitAtAt(scope, 8);
        return `${items.join('、')}${truncated ? '…（还有未展示条件）' : ''}`;
      })() : undefined;

      const header = [
        `基因 ${accession}：${safe(optString(result, 'geneName', prepared.url)) ?? '（无基因名）'}（${safe(optString(result, 'geneModel', prepared.url)) ?? '无模型'}）`,
        renderFields([
          ['基因 accession（上游）', safe(optString(result, 'geneAccession', prepared.url))],
          ['物种', safe(optString(result, 'species', prepared.url))],
          ['分子类型', safe(optString(result, 'molecularType', prepared.url))],
          ['所属研究 accession', optScalar(result, 'projectAccession', prepared.url)],
          ['片段大小', optScalar(result, 'size', prepared.url)],
          ['Tm', optScalar(result, 'tm', prepared.url)],
          ['检测方法', safe(optString(result, 'detection', prepared.url))],
          ['更新时间', lastModified],
        ]),
      ]
        .filter(Boolean)
        .join('\n');

      // 引物、验证范围、提示各自成块：整块放入或整块丢弃，绝不让 finishResult 截到半条引物。
      const blocks: string[] = [];
      if (forward.text) blocks.push(`正向引物：${forward.text}`);
      else if (forward.note) blocks.push(forward.note);
      if (reverse.text) blocks.push(`反向引物：${reverse.text}`);
      else if (reverse.note) blocks.push(reverse.note);
      if (scopeText) blocks.push(`验证范围：${scopeText}（该研究验证过的条件，不是通用推荐）`);
      blocks.push('引物整条输出；研究名与文献题录请用 projectAccession + entity=project 查。');

      const fitted = fitBlocks(header, blocks, prepared.url);
      const omission = fitted.dropped > 0 ? `\n另有 ${fitted.dropped} 个整块（引物/范围/提示）因 4 KB 预算未展示，未截断任何序列。` : '';
      const body = utf8Bytes(`${fitted.body}${omission}`) <= BODY_BUDGET ? `${fitted.body}${omission}` : fitted.body;

      return finish(
        body,
        res,
        {
          accession,
          geneName: safe(optString(result, 'geneName', prepared.url)) ?? null,
          geneModel: safe(optString(result, 'geneModel', prepared.url)) ?? null,
          geneAccession: safe(optString(result, 'geneAccession', prepared.url)) ?? null,
          species: safe(optString(result, 'species', prepared.url)) ?? null,
          projectAccession: optScalar(result, 'projectAccession', prepared.url) ?? null,
          primersForward: forward.text ?? null,
          primersReverse: reverse.text ?? null,
          size: optScalar(result, 'size', prepared.url) ?? null,
          tm: optScalar(result, 'tm', prepared.url) ?? null,
          detection: safe(optString(result, 'detection', prepared.url)) ?? null,
          lastModified: lastModified ?? null,
          droppedBlocks: fitted.dropped,
        },
        prepared,
        '引物缺项会显式说明；不把缺失当查无；整块预算不足时整块省略，不截半条',
      );
    }

    const pmid = nonEmptyString(result.pmid, prepared.url, 'pmid');
    const projects = requireArray(result, 'projectList', prepared.url, '文献');
    const rows = projects.slice(0, MAX_PROJECT_ROWS).map((item) => {
      const project = object(item, prepared.url, 'projectList 成员');
      return [project.accession, safe(optString(project, 'name', prepared.url)), safe(optString(project, 'species', prepared.url))];
    });
    const header = [
      `文献 PMID ${pmid}：${safe(optString(result, 'title', prepared.url)) ?? '（无标题）'}`,
      renderFields([
        ['期刊', safe(optString(result, 'journal', prepared.url))],
        ['年份', optScalar(result, 'pubYear', prepared.url)],
        ['卷/期', [optScalar(result, 'volume', prepared.url), optScalar(result, 'issue', prepared.url)].filter(Boolean).join('/') || undefined],
        ['DOI', safe(optString(result, 'doi', prepared.url))],
        ['被引（上游 citation 字段）', optScalar(result, 'citation', prepared.url)],
        ['作者', safe(optString(result, 'author', prepared.url))],
        ['更新时间', lastModified],
      ]),
      `相关研究：本次返回 ${projects.length} 条，最多展示 ${MAX_PROJECT_ROWS} 条（不表示全部）。`,
      '文献层不含引物：用项目 accession + entity=project 取内参基因与引物。',
    ]
      .filter(Boolean)
      .join('\n');

    // 表格按行追加，避免整表被 finishResult 从中间截断。
    let body = rows.length ? `${header}\n（本次未展示研究条目）` : header;
    if (rows.length) {
      body = header;
      for (let count = 1; count <= rows.length; count += 1) {
        const candidate = `${header}\n${renderTable(['研究 accession', '研究名', '物种'], rows.slice(0, count), { maxRows: count, maxCell: 40 })}`;
        if (utf8Bytes(candidate) > BODY_BUDGET) break;
        body = candidate;
      }
    }
    return finish(
      body,
      res,
      {
        pmid,
        title: safe(optString(result, 'title', prepared.url)) ?? null,
        journal: safe(optString(result, 'journal', prepared.url)) ?? null,
        pubYear: optScalar(result, 'pubYear', prepared.url) ?? null,
        volume: optScalar(result, 'volume', prepared.url) ?? null,
        issue: optScalar(result, 'issue', prepared.url) ?? null,
        doi: safe(optString(result, 'doi', prepared.url)) ?? null,
        citation: optScalar(result, 'citation', prepared.url) ?? null,
        projectReturned: projects.length,
      },
      prepared,
      '摘要按白名单不输出；作者为公开题录字段',
    );
  },
});

const speciesList = checked({
  name: 'icg_species_list',
  description:
    '分页浏览 ICG 物种目录（上游 recordsTotal=540），用于拿到物种 accession 以继续 project/gene 查询。只能分页浏览，不能按名称搜索（上游 search 参数不可用）；本工具不承诺覆盖范围，返回行数受 limit 与 4 KB 预算限制。',
  parameters: {
    type: 'object',
    properties: {
      offset: integer(0, 520, 0),
      limit: integer(1, 50, 20),
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const offset = intArg(args.offset, 0, 0, 520, 'offset');
    const limit = intArg(args.limit, 20, 1, 50, 'limit');
    const url = `${manifest.apiBase}/rest/species/category/?draw=1&start=${offset}&length=${limit}`;
    const { prepared, res, data } = await request(ctx, url);

    requiredKey(data, 'recordsTotal', prepared.url);
    requiredKey(data, 'data', prepared.url);
    if (typeof data.recordsTotal !== 'number' || !Number.isSafeInteger(data.recordsTotal) || data.recordsTotal < 0) {
      throw new UpstreamShapeError('recordsTotal 不是非负整数', { url: prepared.url, request: prepared.request });
    }
    if (data.recordsTotal === 0) {
      throw new UpstreamShapeError('recordsTotal=0：空库形态未实测，不能当作合法空结果', {
        url: prepared.url,
        request: prepared.request,
      });
    }
    const rows = requireArray(data, 'data', prepared.url, '物种列表');
    const filtered = data.recordsFiltered;
    if (filtered !== undefined && (typeof filtered !== 'number' || !Number.isSafeInteger(filtered))) {
      throw new UpstreamShapeError('recordsFiltered 不是整数', { url: prepared.url, request: prepared.request });
    }

    const values: string[][] = [];
    for (const item of rows) {
      const row = object(item, prepared.url, '物种行');
      values.push([
        nonEmptyString(row.accession, prepared.url, '物种行 accession'),
        nonEmptyString(row.latinName, prepared.url, '物种行 latinName'),
        safe(optString(row, 'commonName', prepared.url)) ?? '-',
        safe(optString(row, 'category', prepared.url)) ?? '-',
        String(optScalar(row, 'studyNumber', prepared.url) ?? '-'),
      ]);
    }

    const header = [
      `物种目录：上游 recordsTotal=${data.recordsTotal}${typeof filtered === 'number' ? `；recordsFiltered=${filtered}` : ''}`,
      `本次请求 offset=${offset}、limit=${limit}；本次返回 ${rows.length} 条。`,
      rows.length ? '' : 'offset 超出可返回范围：上游 recordsTotal>0，说明库非空，只是本页没有行。',
      '只能分页浏览，不能按名称搜索；本仓未声明覆盖范围，示例非穷尽。',
    ]
      .filter(Boolean)
      .join('\n');

    let body = header;
    for (let count = 1; count <= values.length; count += 1) {
      const candidate = `${header}\n${renderTable(['accession', '学名', '俗名', '分类', '研究数'], values.slice(0, count), { maxRows: count, maxCell: 40 })}`;
      if (utf8Bytes(candidate) > BODY_BUDGET) break;
      body = candidate;
    }
    return finish(
      body,
      res,
      {
        recordsTotal: data.recordsTotal,
        recordsFiltered: typeof filtered === 'number' ? filtered : null,
        offset,
        limit,
        returned: rows.length,
        accessions: values.map((row) => row[0]!),
      },
      prepared,
      'recordsTotal 为上游字段；本次返回条数不等于物种总数',
    );
  },
});

function intArg(raw: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new InvalidArgumentError(`参数 ${name} 必须是整数`);
  }
  if (raw < minimum || raw > maximum) {
    throw new InvalidArgumentError(`参数 ${name} 必须在 ${minimum}–${maximum} 之间（收到 ${raw}），不做静默夹取`);
  }
  return raw;
}

export const tools: ToolDefinition[] = [lookup, speciesList];

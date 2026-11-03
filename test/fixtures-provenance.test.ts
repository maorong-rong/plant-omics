import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * fixture 证据层级闸门（2026-11-01，负责人裁定）。
 *
 * 背景：93 份 fixture 里只有 STRING 的 17 份存了**原体**（`rawBody`）。其余 76 份存的是
 * 重排版 `payload`——`sourceSha256` 记的是上游原体字节，所以任何人拿库里内容复算都对不上。
 * 那 76 份**不假装可核**：在这里显式登记（`UNPROVEN`），并因此**不计入「已实测覆盖」**。
 *
 * 三条闸门：
 *   ① 有 `rawBody`：`sha256(rawBody) === sourceSha256` **且** 派生数据与原件一致——
 *      非裁剪件要求 `JSON.parse(rawBody)` 与 `payload` 深度相等；裁剪件（`capture.cropping` 声明了字段白名单）
 *      要求 payload 是原件的**投影**（键都存在、值逐层相等）。这条防「原体正确、回放数据却被改写」——审查 2026-11-01 补的要求；
 *   ② 无 `rawBody`：必须在 `UNPROVEN` 里显式声明；新出现的未声明的件直接红；
 *   ③ `simulated: true`：必须在 `SIMULATED` 里显式登记，且**不参与**实测覆盖计数。
 *
 * 为什么用「显式清单」而不是「自动跳过」：清单可被审阅、可被 diff，**新增缺口必须有人写一行**；
 * 自动跳过则任何新件都会悄悄溜进「已实测」。清单同时断言「没有过期条目」，防止修好后忘了删。
 */

// `FIXTURES_ROOT` 仅用于**隔离副本的变异验证**（把 fixtures 拷到 %TEMP% 改坏再跑），正常跑用仓库路径。
const FIXTURES = process.env.FIXTURES_ROOT ?? join(process.cwd(), 'src', 'sources');

/**
 * 未留存原体的 fixture。按后端负责人 2026-11-01 定的三态写法，这一档的准确含义是
 * **「来源未核实，仅供解析回归」**——既不能声称为已实测，也不能断言是假。
 * 清空一项 = 该件已补 `rawBody`（补完它会落进 SELF_CONSISTENT_COUNT）。
 *
 * 三态对照（全仓 93 份当前分布）：
 *   有 rawBody + 哈希自洽   → 内部自洽（21 份：文件没被改过；不等于「采集可证」）
 *   无 rawBody / 无哈希     → 来源未核实，仅供解析回归（65 份）
 *   有 sourceSha256 无原体  → 声明而非证据，必须补（7 份，见第四条断言）
 *   simulated: true         → 合成件，仅回放（5 份）
 */
const UNPROVEN: readonly string[] = [
  'gramene/expression-empty.json',
  'gramene/expression.json',
  'gramene/genes-empty.json',
  'gramene/genes.json',
  'gramene/search-empty.json',
  'gramene/search.json',
  'gramene/taxonomy-dup-single.json',
  'gramene/taxonomy-single-numeric-error.json',
  'gramene/taxonomy.json',
  'gwh/assembly-missing.json',
  'gwh/assembly-not-an-accession.json',
  'gwh/assembly-with-contact.json',
  'gwh/assembly.json',
  'gwh/bioproject-missing.json',
  'gwh/bioproject.json',
  'gwh/biosample-missing.json',
  'gwh/biosample.json',
  'gwh/genome-missing.json',
  'gwh/genome.json',
  'ic4r/annotation-empty.json',
  'ic4r/annotation-object.json',
  'ic4r/annotation.json',
  'ic4r/circrna.json',
  'ic4r/gene-empty-object.json',
  'ic4r/gene-empty.json',
  'ic4r/gene-list-array-wrap.json',
  'ic4r/gene-list-empty.json',
  'ic4r/gene-list-sy.json',
  'ic4r/gene-list.json',
  'ic4r/gene.json',
  'ic4r/id-conversion.json',
  'ic4r/lncrna.json',
  'icg/gene.json',
  'icg/not-found.json',
  'icg/project-with-contact.json',
  'icg/project.json',
  'icg/publication.json',
  'icg/species-list.json',
  'icg/species.json',
  'strawberry/catalog.json',
  'strawberry/expression-empty.json',
  'strawberry/expression.json',
  'strawberry/gene-lookup-404.json',
  'strawberry/gene-lookup.json',
  'strawberry/genes-status.json',
  'strawberry/synteny-empty.json',
  'strawberry/synteny.json',
  'strawberry/tf-empty.json',
  'strawberry/tf-matches.json',
  'strawberry/tf-summary.json',
  'wheatomics/expression-projects.json',
  'wheatomics/expression-query.json',
  'wheatomics/gene-detail.json',
  'wheatomics/homologs-empty.json',
  'wheatomics/homologs.json',
  'wheatomics/id-conversion.json',
  'wheatomics/known-search.json',
  'wheatomics/papers.json',
  'wheatomics/pfam-neg.json',
  'wheatomics/pfam-pos.json',
  'wheatomics/sequence-neg.json',
  'wheatomics/sequence-pos.json',
  'wheatomics/variant-datasets.json',
  'wheatomics/variant-query-empty.json',
  'wheatomics/variant-query.json',
];

/** `simulated: true` 的合成件：不参与任何「已实测覆盖」统计。 */
const SIMULATED: readonly string[] = [
  'gwh/assembly-with-contact.json',
  'ic4r/annotation-object.json',
  'ic4r/gene-empty-object.json',
  'ic4r/gene-list-array-wrap.json',
  'icg/project-with-contact.json',
];

/**
 * **按"原体怎么来的"分类计数**——两类不是同一个证据等级，**不得相加成"有原体的件数"**
 * （后端负责人 2026-11-01：把"能自圆其说"记成"采集过"，是这类闸门最容易犯的错）。
 *
 *   CAPTURED_COUNT        真采集：rawBody 来自对上游的一次实际请求（rawBodySource: re-collected）
 *   RECONSTRUCTED_COUNT   重建：rawBody 由 payload 反向序列化得到（rawBodySource: reconstructed-from-payload）
 *                         ——它只证明"payload 能还原成那个字节串"，**不证明上游当初返回过它**，
 *                         因为还原用的就是它自己算出来的哈希。
 *   UNDECLARED            有 rawBody 但没声明来源：既不能算采集，也不能算重建，**必须显式列出**，
 *                         新增一件就红（这就是"分类不全"的闸门，不是"可以跳过"的出口）。
 *
 * 闸门仍然要求：每一份有 rawBody 的件都落进上述三类之一（分别是"有 rawBody 的件"那条断言的完备性）。
 * 统计口径上，**实测覆盖只取 CAPTURED**；重建件只到"内部自洽"。
 */
const CAPTURED_COUNT = 31;
const RECONSTRUCTED_COUNT = 5;

/** 有 rawBody 但没声明 rawBodySource 的件（当前只有未接线的 UniProt）。补声明后从这里删掉。 */
const UNDECLARED_SOURCE: readonly string[] = [
  // 2026-11-01：UniProt 的 5 份已补 rawBodySource（re-collected），这里清空。
  // 以后再有"有 rawBody 没声明来源"的件，加进来并写清为什么；不许为了变绿直接放宽成"允许未声明"。
];

interface Entry { rel: string; simulated: boolean; cropped: boolean; payloadRelation?: string; rawBody?: string; rawBodySource?: string; capturedAt?: unknown; rawBodyCollectedAt?: unknown; sha?: string; contentType?: string; payload: unknown }

/**
 * 全仓 fixture 份数（按**已接线源**统计，见下方 REGISTERED_SOURCES）。增减要在这里写明理由。
 *
 * 2026-11-02 曾由 101 回退到 93：当时 UniProt 属 R11 未过审、未提交的源，干净检出只有 93 份。
 * 2026-11-03 R11 通过、uniprot 接线，恢复 101（+8 份 fixture）；同一批 CAPTURED_COUNT 23 → 31。
 */
const FIXTURE_TOTAL = 101;

/**
 * 扫描集合**按接线派生**：源 id 来自 `src/sources/index.ts` 的注册表，而不是"src/sources 下有哪些目录"。
 *
 * 为什么（后端负责人 2026-11-03 裁定）：未接线的源目录（如 R11 未过审的 uniprot）不是产品的一部分，
 * 不构成任何工具，把它们算进"实测覆盖"只会让工作区天天红、让公开树必红。反过来，
 * 用手写白名单排除它们（PENDING_READERS 那种）又是个会过期的人工同步点——所以改成从接线派生。
 *
 * 这不是"自动跳过"：FIXTURE_TOTAL / CAPTURED_COUNT 仍然钉死。把某个已接线的源从注册表摘掉，
 * 它的 fixture 立刻从计数里消失 → 总份数与钉死值不符 → 测试红（2026-11-03 已用摘 string 复现）。
 */
const { registry } = await import('../src/sources/index.js');
const REGISTERED_SOURCES: string[] = registry
  .listSources()
  .map((bundle) => bundle.manifest.id as string)
  .sort();

/**
 * 枚举**已接线源**的全部 fixture。
 *
 * **不做静默跳过**（后端负责人 2026-11-01 的规矩：校验函数里不许条件跳过）。
 * 某个已接线的源目录里 fixtures/ 消失或被改名，会被收进 SOURCES_WITHOUT_FIXTURES 并由断言要求为空；
 * 总份数另有 FIXTURE_TOTAL 钉着：少一份就红。
 */
const SOURCES_WITHOUT_FIXTURES: string[] = [];

function allFixtures(): Entry[] {
  const out: Entry[] = [];
  for (const src of REGISTERED_SOURCES) {
    const dir = join(FIXTURES, src, 'fixtures');
    if (!existsSync(dir)) { SOURCES_WITHOUT_FIXTURES.push(src); continue; }
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        capture?: {
          sourceSha256?: string; simulated?: boolean; cropping?: unknown;
          rawBodySource?: string; capturedAt?: unknown; rawBodyCollectedAt?: unknown; payloadRelation?: string;
        };
        payload?: unknown; rawBody?: string;
      };
      out.push({
        rel: `${src}/${f}`,
        simulated: j.capture?.simulated === true,
        // 不能拿 `capture.cropping` 有没有值来判：ensembl 那 7 份写的是
        // "verbatim; no fields removed"，是**没有裁剪**的声明。裁剪与否由显式字段决定。
        cropped: j.capture?.payloadRelation === 'projection',
        rawBody: typeof j.rawBody === 'string' ? j.rawBody : undefined,
        rawBodySource: j.capture?.rawBodySource,
        payloadRelation: j.capture?.payloadRelation,
        capturedAt: j.capture?.capturedAt,
        rawBodyCollectedAt: j.capture?.rawBodyCollectedAt,
        sha: j.capture?.sourceSha256,
        contentType: (j.capture as { contentType?: string } | undefined)?.contentType,
        payload: j.payload,
      });
    }
  }
  return out;
}

const entries = allFixtures();

/**
 * payload 是否为 original 的**投影**：对象只要求键存在且值投影一致（允许少键），
 * 数组要求等长、逐元素投影，叶子要求完全相等。
 * 裁剪件用这条代替深度相等——它同样能发现"回放数据被改过"。
 */
function expectProjection(payload: unknown, original: unknown, where: string): void {
  if (Array.isArray(payload)) {
    expect(Array.isArray(original), `${where}：原体对应位置不是数组`).toBe(true);
    expect((original as unknown[]).length, `${where}：数组长度与原体不一致`).toBe(payload.length);
    payload.forEach((item, i) => expectProjection(item, (original as unknown[])[i], `${where}[${i}]`));
    return;
  }
  if (payload && typeof payload === 'object') {
    const from = (original ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      expect(Object.prototype.hasOwnProperty.call(from, key), `${where}.${key}：原体里没有这个键`).toBe(true);
      expectProjection(value, from[key], `${where}.${key}`);
    }
    return;
  }
  expect(payload, `${where}：值与原体不同`).toEqual(original);
}

describe('fixture 证据层级（原体 / 派生 / 合成）', () => {
  it('有 rawBody 的件：哈希等于 sourceSha256，且派生数据与原件一致（非裁剪件深度相等、裁剪件投影相等）', () => {
    const proven = entries.filter((e) => e.rawBody !== undefined);
    // 完备性：每一份有原体的件都必须落进三类之一（这个"和"是分类覆盖，不是证据等级）
    expect(proven.length).toBe(CAPTURED_COUNT + RECONSTRUCTED_COUNT + UNDECLARED_SOURCE.length);
    const captured = proven.filter((e) => e.rawBodySource === 're-collected');
    const reconstructed = proven.filter((e) => e.rawBodySource === 'reconstructed-from-payload');
    const undeclared = proven.filter((e) => e.rawBodySource === undefined);
    expect(captured.length, '真采集件数').toBe(CAPTURED_COUNT);
    expect(reconstructed.length, '重建件数（不得计入采集）').toBe(RECONSTRUCTED_COUNT);
    expect(undeclared.map((e) => e.rel).sort(), '未声明来源的件必须显式登记，新增即红').toEqual([...UNDECLARED_SOURCE].sort());
    for (const e of proven) {
      expect(e.sha, `${e.rel} 缺 sourceSha256`).toBeTruthy();
      const actual = createHash('sha256').update(Buffer.from(e.rawBody as string, 'utf8')).digest('hex').toUpperCase();
      expect(actual, `${e.rel} 原体哈希与 sourceSha256 不符`).toBe(String(e.sha).toUpperCase());
      // 防「原体正确、回放 payload 被改写」：**能解析成 JSON 的原体**，派生结构必须与解析结果一致。
      // 原体允许不是 JSON（实测有 109 B 的 HTML 转发桩）：这时不比对派生结构，但必须不是 JSON 类型。
      let parsed: unknown;
      let parsedOk = true;
      try {
        parsed = JSON.parse(e.rawBody as string);
      } catch {
        parsedOk = false;
      }
      if (parsedOk) {
        if (e.cropped) {
          // 裁剪件：payload 是按 capture.cropping 声明的字段白名单**投影**出的子集，不是重排版。
          // 不能要求深度相等，但必须逐层投影一致——照样能抓住"原体没动、回放数据被改写"。
          expectProjection(e.payload, parsed, `${e.rel} 的 payload（裁剪件）`);
        } else {
          expect(parsed, `${e.rel} 的 payload 与原件不一致`).toEqual(e.payload);
        }
      } else {
        // 非 JSON 原体（实测有 109 B 的 HTML 转发桩）：只核 content-type 不够——
        // 那只说明"允许它不是 JSON"，不能说明派生的 payload 没被改过。
        // 这一档的 payload 就是原体原文，必须逐字相等（对抗审查者 2026-11-01 补）。
        expect(String(e.contentType ?? '').toLowerCase(), `${e.rel} 原体不是 JSON，但 content-type 声称是 JSON`)
          .not.toContain('json');
        expect(e.payload, `${e.rel} 非 JSON 原体：payload 必须与原体原文逐字相等`).toEqual(e.rawBody);
      }
    }
  });

  it('扫描不留暗格：没有 fixtures 目录的源必须为空，总份数等于 FIXTURE_TOTAL', () => {
    expect(SOURCES_WITHOUT_FIXTURES, '这些源目录下没有 fixtures/，扫描会静默少算；补目录或把它登记进清单').toEqual([]);
    expect(entries.length, `fixture 总份数与 FIXTURE_TOTAL(${FIXTURE_TOTAL}) 不符——少算就是漏扫`).toBe(FIXTURE_TOTAL);
  });

  /**
   * 「按接线派生」不是「自动跳过」的证明。
   *
   * 扫描集合必须**恰好等于**注册表：未接线的目录（如 R11 未过审的 uniprot）不计数，
   * 而已接线源一份 fixture 都不能少。后者由 FIXTURE_TOTAL/CAPTURED_COUNT 钉着——
   * 把一个已接线的源从 `src/sources/index.ts` 摘掉，它的 fixture 立刻从计数里消失，
   * 总份数对不上 → 这条和上一条都会红（2026-11-03 用摘 string 实测复现）。
   */
  it('扫描集合恰好等于注册表：未接线目录不计数，已接线源一份都不能少', () => {
    const scanned = [...new Set(entries.map((e) => e.rel.split('/')[0]))].sort();
    expect(scanned, '扫到的源必须与 src/sources/index.ts 的注册表逐项相等').toEqual(REGISTERED_SOURCES);
    expect(REGISTERED_SOURCES.length, '注册表为空：先看 src/sources/index.ts').toBeGreaterThan(0);
  });

  it('注册表里的源不得还有未声明来源的件（这条才真正卡住「先声明再接线」）', async () => {
    // 2026-11-01 对抗审查者指出：本文件遍历的是**源目录**，不查注册表——
    // 所以"某源已接进 index.ts、但 fixture 还没声明来源"这件事，光靠 UNDECLARED 清单自洽拦不住。
    // 这条把注册表接进来：已注册的源，其 fixture 一律不许留在未声明清单里。
    const { registry } = await import('../src/sources/index.js');
    const registered = new Set(registry.listSources().map((bundle) => bundle.manifest.id));
    const offenders = UNDECLARED_SOURCE.filter((rel) => registered.has(rel.split('/')[0]));
    expect(offenders, '这些源已经进注册表，但仍有未声明来源的 fixture：先补 rawBodySource，再接线').toEqual([]);
    // 反向：清单里如果出现一个**根本不存在**的源目录，说明清单过期了
    const stale = UNDECLARED_SOURCE.filter((rel) => !entries.some((e) => e.rel === rel));
    expect(stale, '清单里有不存在的 fixture（过期条目）').toEqual([]);
  });

  it('无 rawBody 的件必须在 UNPROVEN 里显式声明（新增未声明即红、过期条目也红）', () => {
    const unproven = entries.filter((e) => e.rawBody === undefined).map((e) => e.rel).sort();
    expect(unproven, '有未声明的无原体件；补 rawBody 或加入 UNPROVEN 并写理由').toEqual([...UNPROVEN].sort());
  });

  it('声明了 sourceSha256 的件必须同时存 rawBody 且哈希相等（没有原体的哈希不算证据）', () => {
    // 2026-11-01 后端负责人推广的全仓规则：`sourceSha256` 是对 `rawBody` 原始字节算的，
    // 不是对序列化后的 payload 算的。只记哈希不存原体 = 任何人都无法离线复算，
    // 等于「声明」而不是「证据」——这种件必须补 rawBody，或者删掉哈希降为「来源未核实」。
    const offenders = entries.filter((e) => e.sha && e.rawBody === undefined).map((e) => e.rel).sort();
    expect(offenders, '以下 fixture 声称有原体哈希却没有 rawBody：补原体，或删掉 sourceSha256').toEqual([]);
  });

  it('rawBody 是重建件的，必须标 reconstructed-from-payload，且不得带任何采集时刻字段', () => {
    // 重建（JSON.stringify(payload)）能让哈希自洽，但**重建不等于采集**。
    // 这条防的是：把重建件悄悄写成"重抓件"，用重建出来的字节冒充"当时抓过"。
    const rebuilt = entries.filter((e) => e.rawBodySource === 'reconstructed-from-payload');
    expect(rebuilt.length, '重建件应显式登记（当前 ensemblplants 5 份）').toBeGreaterThan(0);
    for (const e of rebuilt) {
      expect(e.capturedAt, `${e.rel} 是重建件，不得写 capturedAt`).toBeUndefined();
      expect(e.rawBodyCollectedAt, `${e.rel} 是重建件，不得写 rawBodyCollectedAt（那是重抓件的字段）`).toBeUndefined();
      expect(e.payloadRelation, `${e.rel} 是重建件，payload 应为 verbatim（重建能逐字节还原说明没裁剪）`).toBe('verbatim');
    }
  });

  it('simulated 件必须在 SIMULATED 里显式登记，且不参与实测覆盖计数', () => {
    const simulated = entries.filter((e) => e.simulated).map((e) => e.rel).sort();
    expect(simulated).toEqual([...SIMULATED].sort());
    // 实测覆盖 = 有原体 且 非合成；合成件即使伪造了 rawBody 也要被排除
    // 实测覆盖只取**真采集**：重建件不进这个数（后端负责人 2026-11-01 裁定）
    const measured = entries.filter((e) => e.rawBodySource === 're-collected' && !e.simulated);
    expect(measured.length).toBe(CAPTURED_COUNT);
    for (const rel of SIMULATED) expect(measured.map((e) => e.rel)).not.toContain(rel);
  });
});

/**
 * `hub_find_sources` —— 无状态"指路牌"：把一句自然语言问题映射到候选源与工具名。
 *
 * 它**不激活任何工具、不发任何上游请求、不替工具说"查无"**。
 * 排序规则、拒答文案、预算口径都按 `记录/20261029-hub_find_sources实现契约.md`。
 */

import { InvalidArgumentError } from '../core/errors.js';
import { DEFAULT_MAX_BYTES, truncateToBytes, utf8Bytes } from '../core/format.js';
import { validateArgs } from '../core/invoke.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import {
  INTENT_BY_ID,
  SOURCE_NAME_ALIASES,
  SOURCE_SEMANTICS,
  SPECIES_ALIASES,
  TOOL_CAPABILITIES,
  detectIntents,
  detectSpecies,
  speciesSatisfies,
  type IntentId,
  type Semantics,
  type ToolCapability,
} from './capability-catalog.js';

/** 输入侧完整回显上限（与公共层请求证据口径一致） */
const MAX_ECHO_BYTES = 1536;
/** 正文预算：总 4 KB 先扣掉尾注与免责行，正文不超过 1408 B（与公共层一致） */
const MAX_BODY_BYTES = 1408;
const DISCLAIMER = '未探测上游；工具是否可用以上游实际响应为准。';
const SEMANTICS_RANK: Record<Semantics, number> = { 承诺: 0, 实测: 1, 示例非承诺: 2 };

export function normalize(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, ' ')
    .trim();
}

/**
 * 题级判据：这条请求是不是「分析/计算」而不是「查询」。
 *
 * 每条规则都要求**动作与对象同时出现**，不用"分析"这类单字兜底——
 * 单字兜底会把「有哪些做抗旱分析的基因」这种正常查询一起挡掉，
 * 而拒答正常查询的代价比漏挡一条分析请求大得多。
 *
 * 返回命中的规则名（原样进输出，让用户知道被判成了什么），未命中返回 undefined。
 */
const COMPUTATION_RULES: ReadonlyArray<{ rule: string; test: RegExp }> = [
  { rule: '设计/生成引物', test: /(设计|生成|开发)[^，。；,;]{0,6}(pcr\s*)?引物|引物设计/ },
  { rule: '绘制热图', test: /热图|heat\s*map/ },
  { rule: '富集分析', test: /富集分析|go\s*富集|kegg/ },
  { rule: '三维结构预测', test: /三维结构|3d\s*结构|结构预测|蛋白结构/ },
  { rule: '比较基因组/共线性作图', test: /共线性图|比较基因组|circos|作图|画图|绘图/ },
  { rule: '差异表达分析', test: /差异表达分析|差异分析/ },
];

export function detectComputation(normalized: string): string | undefined {
  return COMPUTATION_RULES.find((entry) => entry.test.test(normalized))?.rule;
}

interface Recognized {
  /** 原始问题（未归一化）：`when` 条件要按原文测，因为归一化会吃掉 : 和 - */
  readonly raw?: string;
  readonly species: string[];
  readonly intents: IntentId[];
  /** 问题里**被点名**的源（"Gramene 里查…"）。点名了就只答这个源。 */
  readonly sources: string[];
  /**
   * 分句视图：每个分句各自认到哪些物种与意图（G3b 分句绑定用）。
   * 单分句时为空数组——此时候选判据沿用全局集合，见 `selectCandidates`。
   */
  clauses: Clause[];
  readonly normalized: string;
}

/** 一个分句里认到的物种与意图。 */
interface Clause {
  readonly species: string[];
  readonly intents: IntentId[];
}

/** 正则转义：物种别名里有 x 这类特殊字符（如 `Fragaria × ananassa`）。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 问题里被点名的源，按出现位置去重。 */
export function detectSourceNames(normalized: string): string[] {
  const hits: Array<{ id: string; index: number }> = [];
  for (const [id, aliases] of Object.entries(SOURCE_NAME_ALIASES)) {
    for (const alias of aliases) {
      const query = escapeRegExp(alias);
      const match = new RegExp(query).exec(normalized);
      if (match) {
        hits.push({ id, index: match.index });
        break;
      }
    }
  }
  return [...new Set(hits.sort((a, b) => a.index - b.index).map((hit) => hit.id))];
}

/**
 * 摘掉源名再识别物种。
 *
 * `WheatOmics` 里含 `wheat`、`Strawberry` 里含 `strawberry`，不摘就会被读成
 * "用户在问小麦/草莓"，于是 `WheatOmics 查玉米的变异位点` 会命中"小麦+玉米"，
 * 拿小麦的变异工具去答玉米 —— 用错物种作答比答不出来严重得多。
 */
export function stripSourceNames(normalized: string): string {
  let text = normalized;
  for (const aliases of Object.values(SOURCE_NAME_ALIASES)) {
    for (const alias of aliases) {
      text = text.split(alias).join(' ');
    }
  }
  return text;
}

/**
 * 把问题切成**分句**，每个分句各自认物种与意图（G3b 用）。
 *
 * 为什么按 `，。；;！？!?` 切、**不按顿号**：
 *   - 顿号是并列，不是分句。「小麦、水稻、玉米的表达」是一个整体，
 *     拆成三截会把"物种清单"与"意图"拆散，反而把合法问题误杀；
 *   - 逗号/分号/句号才是"这里换了一件事"的信号，
 *     「小麦的表达量，另外玉米的变异位点」正是靠它区分出"玉米问的是变异"。
 *
 * 物种省略时**继承上一个分句的物种**（「小麦的表达，还有变异位点」里
 * 第二分句没有物种，问的仍是小麦），否则会把省略主语的正常问法误杀。
 *
 * 只有一个分句时返回空数组：此时候选判据沿用全局集合。并列写法无法用分句表达，
 * 强行启用会误杀（「A、B、C 的 X 与 Y」这种问题没有分句边界）。
 */
function splitClauses(raw: string): Clause[] {
  const parts = raw
    .split(/[，。；;！？!?]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length < 2) return [];

  const clauses: Clause[] = [];
  let inherited: string[] = [];
  for (const part of parts) {
    const normalized = normalize(part);
    const species = detectSpecies(stripSourceNames(normalized)).map((hit) => hit.species);
    const intents = detectIntents(normalized);
    if (species.length > 0) inherited = species;
    clauses.push({ species: species.length > 0 ? species : inherited, intents });
  }
  return clauses;
}

function recognize(question: string): Recognized {
  const normalized = normalize(question);
  return {
    raw: question,
    species: detectSpecies(stripSourceNames(normalized)).map((hit) => hit.species),
    intents: detectIntents(normalized),
    sources: detectSourceNames(normalized),
    clauses: splitClauses(question),
    normalized,
  };
}

/** 问题里的方向：谁被查（subject），查向谁（target）。 */
export interface Direction {
  readonly subject?: string;
  readonly target?: string;
}

/** "A 对应 B / 把 A 映射到 B" 里，B 前面的动词。 */
const TARGET_VERB = /(对应|映射到|比对到|转到|换到|换成)\s*$/;
/** "在 B 中/里/内" 的作用域标记。 */
const SCOPE_BEFORE = /在\s*$/;
const SCOPE_AFTER = /^(中|里|内)/;
/**
 * 没有"在"字时的作用域：`水稻中查找小麦基因的同源基因`。
 * 必须紧跟"查/找/搜/寻/浏览/检索"才算范围，否则 `小麦中的同源基因` 会被误当目标端。
 */
const SCOPE_AFTER_VERB = /^(中|里|内)\s*(查|找|搜|寻|浏览|检索|有)/;

/**
 * 判定查询方向。
 *
 * 为什么不能只看物种集合：`水稻基因对应小麦哪个同源` 会同时识别出水稻和小麦，
 * 集合无法表达"谁被查"。也不能只取第一个物种：`在水稻里找小麦的同源` 里，
 * 水稻先出现却是**目标**，小麦才是查询主体。
 *
 * 因此先看**方向标记**（`在X中/里`、`对应X`、`映射到X` 里的 X 是目标端），
 * 剩下的那个物种才是查询主体；没有方向标记时才退回"第一个出现的物种"。
 * 两个物种并列且无方向词（`小麦和水稻的同源`）→ 不判方向，只给 subject。
 */
export function resolveDirection(normalized: string): Direction {
  const spans = detectSpecies(normalized);
  if (spans.length === 0) return {};

  const targetSpan = spans.find((span) => {
    const before = normalized.slice(Math.max(0, span.index - 5), span.index);
    const after = normalized.slice(span.end, span.end + 3);
    const inScope = SCOPE_BEFORE.test(before)
      ? SCOPE_AFTER.test(after)
      : SCOPE_AFTER_VERB.test(after);
    return inScope || TARGET_VERB.test(before);
  });

  if (targetSpan) {
    // 查询主体优先取目标之前的那个物种（"小麦对应水稻"）；否则取另一个（"在水稻里找小麦"）
    const subject = spans.find((span) => span !== targetSpan && span.index < targetSpan.index)
      ?? spans.find((span) => span !== targetSpan);
    return { subject: subject?.species, target: targetSpan.species };
  }

  return { subject: spans[0]?.species };
}

interface Scored {
  readonly sourceId: string;
  readonly tool: ToolCapability;
  readonly intentHit: number;
  readonly speciesHit: number;
}

interface Gap {
  readonly sourceId: string;
  readonly reason: string;
}

interface Clue {
  readonly sourceId: string;
  readonly reason: string;
}

/**
 * G1–G4 四道门 + 排序键。**纯函数**：同输入同输出，便于确定性测试。
 *
 * `enabledTools` 是"本服务实际注册了哪些工具"的名单：先求交再判门，
 * 未启用的源既不进候选、也不进缺口/线索（它不属于当前服务，说它"不覆盖"同样是噪音）。
 * 不传时按全量目录处理（只用于纯函数单测，生产装配必须传）。
 */
export function selectCandidates(
  found: Recognized,
  enabledTools?: readonly string[],
): { picked: Scored[]; gaps: Gap[]; clues: Clue[] } {
  const { species, intents } = found;
  const namedSources = found.sources;
  // 方向也要在"摘掉源名"的文本上判：`WheatOmics` 里的 `wheat` 会凭空造出一个物种 span。
  const direction = resolveDirection(stripSourceNames(found.normalized));
  const enabled = enabledTools ? new Set(enabledTools) : undefined;
  const wanted = new Set(intents);
  const scored: Scored[] = [];
  const gaps: Gap[] = [];
  const clues: Clue[] = [];

  /**
   * 未覆盖物种否决。
   *
   * 问题里出现**本服务没有任何源按物种覆盖**的物种（大豆/番茄/油菜/人类…）时，
   * 整题不返回任何源工具。理由：拿小麦的工具答大豆，是"用错物种作答"，
   * 比"答不出来"严重得多。即使问题同时还提到被覆盖的物种
   * （「用草莓的共线数据看番茄基因」），也**不做例外**——只答一半，
   * 会让人以为两半都有覆盖。
   *
   * 判据用 `speciesKnownInCatalog`（只算按物种查询的 scope，不算"按精确 ID"），
   * 因为"不限物种（按精确 ID）"不构成"覆盖了这个物种"的证据。
   */
  const uncoveredSpecies = species.filter((sp) => !speciesKnownInCatalog(sp));
  const vetoed = uncoveredSpecies.length > 0;

  // 按注册顺序遍历，天然实现 k3 平局键
  for (const tool of TOOL_CAPABILITIES) {
    // 先与启用集求交：没注册的工具连"缺口"都不该出现（RETR-12）
    if (enabled && !enabled.has(tool.tool)) continue;
    const semantics = SOURCE_SEMANTICS[tool.sourceId];
    if (!semantics) continue;

    /**
     * 点名源限制：问题点名了源，就**只答这个源**。
     *
     * 「Gramene 里查小麦的基因」要的是 gramene 的覆盖结论；回一个 wheatomics 的
     * 工具是答非所问，还会让用户以为 Gramene 里有小麦。未被点名的源也不列成缺口——
     * 它们不覆盖小麦这件事与用户的提问无关，列出来只是噪音。
     */
    if (namedSources.length > 0 && !namedSources.includes(tool.sourceId)) continue;

    if (vetoed) {
      // 同物种多源会被 dedup 合并，不会刷屏
      if (semantics.policy === 'coverage') {
        gaps.push({ sourceId: tool.sourceId, reason: `不覆盖物种：${uncoveredSpecies.join('、')}` });
      } else {
        clues.push({
          sourceId: tool.sourceId,
          reason: `按精确 ID 或已验示例才有结果，而问题问的是 ${uncoveredSpecies.join('、')}`,
        });
      }
      continue;
    }

    // G1 意图级明确不做——但只有"这个工具本来可能覆盖该问题"时才算缺口。
    // 否则 strawberry 的"模糊搜索"禁令会在"小麦基因"这种问题上冒出来，纯噪音。
    const speciesRelevant = species.length === 0
      || (tool.speciesScope.query ?? []).some((sc) => species.some((sp) => speciesSatisfies(sp, sc)));
    // 意图也要相关：gwh 的"按区间检索"禁令不该在"玉米变异"里冒出来——
    // gwh 本来就没有变异工具，把它列成缺口等于暗示"差一点就能查"。
    const intentRelevant = intents.length === 0 || tool.intents.some((id) => wanted.has(id));
    if (speciesRelevant && intentRelevant) {
      // 两道条件都要满足才挡：意图在 blocks 里，**且**问题确实在问 when 描述的模式。
      // 只看意图会把「按基因 ID 取序列」当成「按区间取序列」误杀。
      const excluded = tool.hardExcludes?.find((entry) =>
        entry.blocks.some((id) => wanted.has(id))
        // when 必须对**原始问题**测试，不能对归一化文本：
      // normalize() 会把 ":" 和 "-" 换成空格，"Chr1A:100-200" 就变成 "chr1a 100 200"，
      // 坐标形态的正则永远匹配不上（这里踩过）。
      && (entry.when === undefined || entry.when.test(found.normalized) || entry.when.test(found.raw ?? '')));
      if (excluded) {
        gaps.push({ sourceId: tool.sourceId, reason: `明确不做：${excluded.rule}` });
        continue;
      }
    }

    // G2 意图门
    const intentHit = intents.filter((id) => tool.intents.includes(id)).length;
    if (intents.length > 0 && intentHit === 0) continue;

    /**
     * G3b 分句绑定（**只在问题真的有分句时**启用；单分句与带 hint 时关掉）。
     *
     * 反例驱动：「小麦的表达量，另外玉米的变异位点」——全局物种集是 {小麦, 玉米}，
     * 而 wheatomics 的变异工具只要"命中维度非空"就放行（小麦来自另一个分句），
     * 于是拿小麦的变异工具去答玉米。集合交集在这里把"用户问的是哪个物种"糊过去了。
     *
     * 判据：命中意图的那一分句里的物种，必须**全**落在该工具的物种范围（query 或 target）内。
     * 分句没有物种时不算通过——物种未知时不许靠另一个分句的物种搭便车。
     */
    if (found.clauses.length > 0 && species.length > 0) {
      const intentClauses = found.clauses.filter((clause) => clause.intents.some((id) => tool.intents.includes(id)));
      if (intentClauses.length > 0) {
        const allows = (sp: string): boolean => {
          const query = tool.speciesScope.query ?? [];
          const target = tool.speciesScope.target ?? [];
          return query.some((sc) => speciesSatisfies(sp, sc)) || target.some((sc) => speciesSatisfies(sp, sc));
        };
        const bound = intentClauses.some((clause) => clause.species.length > 0 && clause.species.every(allows));
        if (!bound) {
          const asked = [...new Set(intentClauses.flatMap((clause) => clause.species))];
          const declared = (tool.speciesScope.query ?? []).join('/') || '未声明';
          gaps.push({
            sourceId: tool.sourceId,
            reason: `分句不匹配：命中意图的那一分句问的是 ${asked.length > 0 ? asked.join('、') : '未指定物种'}`
              + `，不在该工具的物种范围（${declared}）内`,
          });
          continue;
        }
      }
    }

    // G3 物种门（只对 query 判定；target 交给 G4）
    let speciesHit = 0;
    if (species.length > 0) {
      const scope = tool.speciesScope.query ?? [];
      const hitSpecies = species.filter((sp) => scope.some((sc) => speciesSatisfies(sp, sc)));
      if (hitSpecies.length > 0) {
        speciesHit = hitSpecies.length;
      } else if (semantics.policy === 'coverage') {
        const declared = scope.length > 0 ? scope.join('/') : '未声明';
        const boundary = tool.blindSpots[0] ? `；已知边界：${tool.blindSpots[0].slice(0, 40)}` : '';
        gaps.push({
          sourceId: tool.sourceId,
          // 点名源要给出**它自己的覆盖范围**，否则用户只知道"不行"、不知道"为什么不行"
          reason: namedSources.includes(tool.sourceId)
            ? `点名来源未覆盖物种：${species.join('、')}（该源声明的物种范围是 ${declared}${boundary}）`
            : `不覆盖物种：${species.join('、')}`,
        });
        continue;
      } else if (semantics.policy === 'example-only') {
        const exampleHit = species.filter((sp) => (semantics.example ?? []).includes(sp));
        if (exampleHit.length === 0) {
          clues.push({ sourceId: tool.sourceId, reason: `示例已验物种为 ${(semantics.example ?? []).join('、')}，${species.join('、')} 未验` });
          continue;
        }
        speciesHit = exampleHit.length;
      }
      // any-by-id：恒过物种门；但意图未识别时不进候选——"按精确 ID、不限物种"
      // 不构成"覆盖了这个物种"的证据，列进来就是凑数。
      if (semantics.policy === 'any-by-id' && intents.length === 0) continue;
    }

    /**
     * G4 方向门（按**方向标记**判，不按集合交集判）。
     *
     * 反例驱动：「水稻基因对应小麦哪个」在集合上同时命中 query 与 target，
     * 交集判据永远放行；「在水稻里找小麦的同源」则反过来，水稻先出现却是目标。
     * 所以方向由 `resolveDirection` 从方向短语解析，集合只用来校验。
     */
    if (species.length > 0 && tool.speciesScope.target) {
      const query = tool.speciesScope.query ?? [];
      const toolTarget = tool.speciesScope.target;
      if (!direction.subject) {
        gaps.push({
          sourceId: tool.sourceId,
          reason: `方向未定：只识别到目标物种${direction.target}，缺查询主体`,
        });
        continue;
      }
      const subjectOk = query.some((sc) => speciesSatisfies(direction.subject!, sc));
      if (!subjectOk) {
        gaps.push({
          sourceId: tool.sourceId,
          reason: `方向相反：该工具从${query.join('/')}查向${toolTarget.join('/')}，而问题里的查询主体是${direction.subject}`,
        });
        continue;
      }
      /**
     * 逐物种校验目标域（不只是 direction.target）。
     *
     * 反例：「小麦和玉米的同源基因」——并列写法没有方向词，`direction.target` 是空的，
     * 只校验"小麦在 query 域"就放行了，而玉米既不在 query 域也不在 target 域。
     * 同源类工具只能答"小麦 → 水稻/拟南芥"，提到玉米就该判"目标物种不覆盖"。
     */
    /**
     * 绑定判据：**同一分句**里既有同源关键词、又有该物种。
     *
     * 为什么按分句，而不是"关键词后 N 字内"：
     *   - 「小麦和玉米的同源基因」玉米在关键词**之前**，只向后找会漏；
     *   - 「小麦同源基因，另外玉米内参基因有哪些」玉米在另一个分句（内参意图），
     *     不该因为"离得近"就算成同源的目标物种，否则会误杀正常的多意图问题。
     */
    const clauses = (found.raw ?? '').split(/[，。；;！？!?]/);
    const boundSpecies = new Set<string>();
    if (direction.target) boundSpecies.add(direction.target);
    for (const clause of clauses) {
      if (!/同源|对应|映射|ortholog|homolog/i.test(clause)) continue;
      const clauseNormalized = normalize(clause);
      for (const sp of species) {
        if ((SPECIES_ALIASES[sp] ?? []).some((alias) => clauseNormalized.includes(normalize(alias)))) {
          boundSpecies.add(sp);
        }
      }
    }
      const outsideTarget = [...boundSpecies].filter((sp) => {
        const inQuery = query.some((sc) => speciesSatisfies(sp, sc));
        const inTarget = toolTarget.some((sc) => speciesSatisfies(sp, sc));
        return !inQuery && !inTarget;
      });
    if (outsideTarget.length > 0) {
      gaps.push({
        sourceId: tool.sourceId,
        reason: `目标物种不覆盖：该工具目标端只有${toolTarget.join('/')}，不含${outsideTarget.join('、')}`,
      });
      continue;
    }
    if (direction.target && !toolTarget.some((sc) => speciesSatisfies(direction.target!, sc))) {
        gaps.push({
          sourceId: tool.sourceId,
          reason: `目标物种不覆盖：该工具目标端只有${toolTarget.join('/')}，不含${direction.target}`,
        });
        continue;
      }
    }

    if (intents.length === 0 && species.length === 0) continue;
    scored.push({ sourceId: tool.sourceId, tool, intentHit, speciesHit });
  }

  const dedup = <T extends { sourceId: string; reason: string }>(items: T[]): T[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.sourceId}|${item.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  return {
    picked: scored.sort((a, b) =>
      // k1 命中维度数降序
      (b.intentHit > 0 ? 1 : 0) + (b.speciesHit > 0 ? 1 : 0) - ((a.intentHit > 0 ? 1 : 0) + (a.speciesHit > 0 ? 1 : 0))
      // k2 语义等级升序
      || SEMANTICS_RANK[SOURCE_SEMANTICS[a.sourceId]!.semantics] - SEMANTICS_RANK[SOURCE_SEMANTICS[b.sourceId]!.semantics]
      // k3 注册顺序（稳定排序，靠原数组次序）
      || 0,
    ),
    gaps: dedup(gaps),
    clues: dedup(clues),
  };
}

/** 源级聚合：一个源只出现一次，工具名合并。 */
interface Grouped {
  readonly sourceId: string;
  readonly semantics: Semantics;
  readonly tools: string[];
  readonly intentLabels: string[];
  readonly allIntents: string[];
  readonly speciesLabels: string[];
  readonly blindSpots: string[];
  readonly rank: number;
}

function groupBySource(picked: Scored[]): Grouped[] {
  const order: string[] = [];
  const map = new Map<string, Grouped>();
  for (const hit of picked) {
    const existing = map.get(hit.sourceId);
    const semantics = SOURCE_SEMANTICS[hit.sourceId]!.semantics;
    // 命中意图（用于 Shape A 的"命中：意图="行）
    const hitIntentLabels = hit.tool.intents
      .filter((id) => hit.intentHit > 0 && INTENT_BY_ID.has(id))
      .map((id) => INTENT_BY_ID.get(id)!.label);
    // 该工具**全部**意图（用于 Shape B 的"可用意图"行；意图未识别时命中集为空）
    const allIntentLabels = hit.tool.intents
      .filter((id) => INTENT_BY_ID.has(id))
      .map((id) => INTENT_BY_ID.get(id)!.label);
    const intentLabels = hitIntentLabels;
    const speciesLabels = hit.tool.speciesScope.query ?? [];
    if (!existing) {
      order.push(hit.sourceId);
      map.set(hit.sourceId, {
        sourceId: hit.sourceId,
        semantics,
        tools: [hit.tool.tool],
        intentLabels: [...new Set(intentLabels)],
        allIntents: [...new Set(allIntentLabels)],
        speciesLabels: [...speciesLabels],
        blindSpots: [...hit.tool.blindSpots],
        rank: (hit.intentHit > 0 ? 1 : 0) + (hit.speciesHit > 0 ? 1 : 0),
      });
      continue;
    }
    // 合并：同一源的多个工具合成一条
    const merged: Grouped = {
      ...existing,
      tools: [...existing.tools, hit.tool.tool],
      intentLabels: [...new Set([...existing.intentLabels, ...intentLabels])],
      allIntents: [...new Set([...existing.allIntents, ...allIntentLabels])],
      speciesLabels: [...new Set([...existing.speciesLabels, ...speciesLabels])],
      blindSpots: [...new Set([...existing.blindSpots, ...hit.tool.blindSpots])],
      rank: Math.max(existing.rank, (hit.intentHit > 0 ? 1 : 0) + (hit.speciesHit > 0 ? 1 : 0)),
    };
    map.set(hit.sourceId, merged);
  }
  return order.map((id) => map.get(id)!).sort((a, b) => b.rank - a.rank);
}


/** 该物种是否被目录里任一工具声明覆盖（不含 any-by-id 的"不限物种"）。 */
export function speciesKnownInCatalog(species: string): boolean {
  return TOOL_CAPABILITIES.some((tool) =>
    (tool.speciesScope.query ?? []).some((scope) => scope !== '不限物种（按精确 ID）' && speciesSatisfies(species, scope)));
}

export interface FindSourcesInput {
  readonly question: string;
  readonly speciesHint?: string;
  readonly intentHint?: string;
}

export interface FindSourcesOutput {
  readonly text: string;
  readonly raw: {
    readonly recognized: Recognized;
    readonly candidates: Array<{ sourceId: string; tools: string[] }>;
    readonly gaps: Gap[];
    readonly clues: Clue[];
    readonly state: 'A' | 'B' | 'ok';
  };
}

/** 核心逻辑，独立于 ToolDefinition，便于直接单测。 */
export function findSources(input: FindSourcesInput, context: {
  version: string;
  sourceCount: number;
  toolCount: number;
  /**
   * 当前注册表里**真实存在**的业务工具名。
   *
   * 只启用部分源时（`createRegistry({ enabled })`），能力目录仍是全局的；
   * 不传或不做求交，就会推荐一个根本不在本服务里的工具名，并承诺"现在就可调用"——
   * 这比不给推荐更糟（验收第 3 条：返回的工具名必须真的可调用）。
   */
  enabledTools?: readonly string[];
  now?: Date;
}): FindSourcesOutput {
  const question = input.question.trim();
  const speciesHintText = input.speciesHint?.trim() ?? '';
  const intentHintText = input.intentHint?.trim() ?? '';

  const echo = `question=${question}｜species_hint=${speciesHintText || '(无)'}｜intent_hint=${intentHintText || '(无)'}`;
  if (utf8Bytes(echo) > MAX_ECHO_BYTES) {
    throw new InvalidArgumentError(
      `本次检索入参回显 ${utf8Bytes(echo)} UTF-8 字节，超过 ${MAX_ECHO_BYTES} 字节上限；请缩短问题或提示词（尚未做任何检索）`,
    );
  }

  // 合并显式 hint：hint 优先，question 兜底
  const found = recognize(question);
  if (speciesHintText) {
    const extra = detectSpecies(normalize(speciesHintText)).map((hit) => hit.species);
    for (const sp of extra) if (!found.species.includes(sp)) found.species.push(sp);
  }
  if (intentHintText) {
    const extra = detectIntents(normalize(intentHintText));
    for (const id of extra) if (!found.intents.includes(id)) found.intents.push(id);
  }
  /**
   * 显式 hint 是用户给的权威信息，此时关掉分句绑定：
   * 分句推断本来就是"猜物种与意图的对应关系"，用户已经把答案给出来了，再猜只会添乱。
   */
  if (speciesHintText || intentHintText) found.clauses.length = 0;

  const { picked, gaps, clues } = selectCandidates(found, context.enabledTools);
  const grouped = groupBySource(picked);
  const now = context.now ?? new Date();
  const tail = [
    '——',
    `源：plantomics-hub 本地目录｜hub_find_sources(${echo})｜无上游请求`,
    `目录快照：服务版本 ${context.version}｜源 ${context.sourceCount}/工具 ${context.toolCount}｜查询时刻 ${now.toISOString()}`,
  ].join('\n');

  const speciesText = found.species.length ? found.species.join('、') : '未识别出物种';
  const intentText = found.intents.length
    ? found.intents.map((id) => INTENT_BY_ID.get(id)?.label ?? id).join('、')
    : '未识别出意图';

  /**
   * 题级硬门 ①：分析/计算类任务不是查询。
   *
   * 为什么要在**题级**挡，而不是登记成某个工具的 hardExclude：
   * 「设计引物」「画热图」「做富集分析」不是"某个源恰好不做"，而是**本服务整体不做**。
   * 登记到工具上就变成了"这个源不覆盖"，用户会以为换个源就能做。
   *
   * 也不靠意图识别兜底：`设计引物` 里含 `引物`（内参基因意图的关键词），
   * 不挡就会拿 ICG 的内参引物工具去答"帮我设计引物"——ICG 只给已验证的内参引物，
   * 不负责设计。命中关键词不等于该问答得了。
   */
  const computation = detectComputation(found.normalized);
  if (computation) {
    const lines = [
      `不是数据查询：${summarize(question)}`,
      `- 判定：这条是「${computation}」，属于分析/计算任务，不是"把已有数据问出来"`,
      '- 本服务只做查询（把上游已有的记录取回来），不做分析与绘图，因此不提供任何工具',
      '- 说明：这是「本服务不支持该任务」，不是没有覆盖，也不是数据不存在',
      '- 可以先调查询工具拿到原始数据，再放到自己的分析流程里做这一步',
    ];
    return finish(lines.join('\n'), tail, { recognized: found, candidates: [], gaps: [], clues: [], state: 'B' });
  }

  /**
   * 题级硬门 ②：物种未识别时**不许回落全库**。
   *
   * 这是 2026-10-30 R1 负向评测暴露出来的真实缺陷：问「大豆里调控种子油分的基因有哪些」，
   * 物种没识别出来，于是按意图（"有哪些"→目录/发现）匹配，把 5 个源全算成命中——
   * 用户问的是大豆，系统回的是小麦、水稻、甘蔗、玉米、草莓的工具。
   *
   * 判据：本服务靠"工具声明的物种范围"判断覆盖；物种未知就判不了覆盖，
   * 判不了就不给候选。**宁可少答，也不拿不相干的源凑数。**
   */
  if (found.species.length === 0 && found.intents.length > 0) {
    const lines = [
      `未识别出物种：${summarize(question)}`,
      `- 已识别意图：${intentText}；但没有识别出物种`,
      '- 本服务按物种判定"这个工具覆不覆盖你问的东西"；物种未知时判定不了，因此不列任何候选',
      '- 为什么不按意图凑一个：物种未知时，弱的意图词（如"有哪些"）会把全库工具都算成命中，'
        + '那不是命中，是拿不相干的源凑数',
      '- 请补充物种（species_hint），或换更具体的问法（例：「小麦 春化 已知基因」）',
      '- 说明：这是「检索无法判定覆盖」，既不是「本服务未覆盖该物种」，也不是数据不存在',
    ];
    return finish(lines.join('\n'), tail, { recognized: found, candidates: [], gaps: [], clues: [], state: 'B' });
  }

  // 状态 A：物种与意图都没识别出
  if (found.species.length === 0 && found.intents.length === 0) {
    const body = [
      `没有识别出物种与意图：${summarize(question)}。本服务目录（${context.sourceCount} 源 / ${context.toolCount} 工具）无法判断该问什么。`,
      '- 请补充：物种（species_hint）或意图（intent_hint），或换更具体的问法（例：「小麦 春化 已知基因」）',
      '- 说明：这是「检索无法识别输入」，既不是没有覆盖，也不是数据不存在。',
    ].join('\n');
    return finish(body, tail, { recognized: found, candidates: [], gaps, clues, state: 'A' });
  }

  // 状态 B：有识别但没有可执行候选
  if (grouped.length === 0) {
    const lines = [`没有覆盖：${summarize(question)}`];
    /** 是否已经解释过"点名来源缺这类工具"——决定"下一步"该给哪个动作 */
    let namedIntentGap = false;
    // "没有源"只在**确实没有任何源覆盖这些物种**时才写；否则写了就是自相矛盾
    const knownSpecies = found.species.filter((sp) => speciesKnownInCatalog(sp));
    const unknownSpecies = found.species.filter((sp) => !speciesKnownInCatalog(sp));
    if (unknownSpecies.length > 0) {
      lines.push(`- 没有源：${unknownSpecies.join('、')}不在本服务目录（已接：小麦、水稻、玉米〔仅 ICG，仅实测玉米〕、草莓及相关病原、GWH〔按精确 ID，不限物种〕）`);
    }
    // 物种在册但缺工具：不要说成"没有源"，也不必和下面"没有工具"重复
    if (knownSpecies.length > 0 && found.intents.length === 0) {
      lines.push(`- 物种在目录（${knownSpecies.join('、')}），但没能识别出可用意图`);
    }
    if (found.intents.length > 0) {
      // 只有"目录里**根本**没有这类工具"才说没有工具。
      // 有工具但被边界/物种门挡下时，说"没有工具"是假话——由下方缺口逐条解释。
      const missing = found.intents.filter(
        (id) => !TOOL_CAPABILITIES.some((capability) => capability.intents.includes(id)),
      );
      if (missing.length > 0) {
        const labels = missing.map((id) => INTENT_BY_ID.get(id)?.label ?? id).join('、');
        lines.push(`- 没有工具：目录里没有「${labels}」类工具`);
      }

      /**
       * 点名了源、物种也在该源范围内，但这个源**没有该意图的工具**。
       *
       * 必须单独说：此时不是"没有覆盖"（物种是覆盖的），只是这个源没有这类功能。
       * 不说的话，用户看到"没有覆盖"会以为数据不存在，而实际上换个源就能查。
       * 这里**不给工具名**——用户点名了来源，替他换一个源作答是答非所问；
       * 只告诉他去掉来源名再问一次即可。
       */
      if (found.sources.length > 0) {
        for (const id of found.sources) {
          const caps = TOOL_CAPABILITIES.filter((capability) => capability.sourceId === id);
          if (caps.length === 0) continue;
          if (caps.some((capability) => capability.intents.some((want) => found.intents.includes(want)))) continue;
          const wantedLabels = found.intents.map((i) => INTENT_BY_ID.get(i)?.label ?? i).join('、');
          const available = [...new Set(caps.flatMap((capability) => [...capability.intents]))]
            .map((i) => INTENT_BY_ID.get(i)?.label ?? i).join('、');
          lines.push(`- 点名来源 ${id} 没有「${wantedLabels}」类工具（它有：${available}）`);
          namedIntentGap = true;
        }
        lines.push('- 若不限来源：去掉问题里的来源名再问一次，本服务其他源可能有这类工具');
      }
    }
    lines.push(`- 说明：这是「本服务未覆盖」，不是「该数据不存在」；上游数据库可能存在，只是未接入`);
    if (gaps.length > 0 || clues.length > 0) {
      lines.push('接近但不覆盖（非可执行候选，不附默认动作）：');
      // 同一物种被多个源"不覆盖"时合并成一行。原来会连列三条
      // "wheatomics/strawberry/ic4r 不覆盖油菜"，信息重复且稀释真正的重点。
      const uncovered = new Map<string, string[]>();
      const others: Gap[] = [];
      for (const gap of gaps) {
        const prefix = '不覆盖物种：';
        if (gap.reason.startsWith(prefix)) {
          const key = gap.reason.slice(prefix.length);
          uncovered.set(key, [...(uncovered.get(key) ?? []), gap.sourceId]);
        } else {
          others.push(gap);
        }
      }
      for (const [speciesName, sources] of uncovered) {
        lines.push(`- 缺口：${speciesName} 不在 ${sources.join('、')} 的覆盖范围内`);
      }
      for (const gap of others.slice(0, 3)) lines.push(`- 缺口：${gap.sourceId}：${gap.reason}`);
      for (const clue of clues.slice(0, 3)) lines.push(`- 线索（未验证）：${clue.sourceId}：${clue.reason}`);
    }
    lines.push(namedIntentGap
      // 此时"需要覆盖请走源接入流程"是错的动作：物种是覆盖的，只是这个源没有这类工具
      ? '下一步：先去掉问题里的来源名再问一次；确认所有源都没有覆盖时再走源接入流程（docs/新增一个源.md）。不要用其他物种或别的意图的工具代替作答。'
      : '下一步：需要覆盖请走源接入流程（docs/新增一个源.md）；不要用其他物种或别的意图的工具代替作答。');
    return finish(lines.join('\n'), tail, { recognized: found, candidates: [], gaps, clues, state: 'B' });
  }

  // Shape B：只有物种命中（意图未识别）→ 源级列示，不逐工具刷屏
  const onlySpecies = found.intents.length === 0;
  const shown = grouped.slice(0, 5);
  const omitted = grouped.length - shown.length;
  const header = onlySpecies
    ? `命中 ${shown.length} 源（仅物种命中，意图未识别）`
    : `命中 ${shown.length} 源 / ${picked.length} 工具（排序：命中维度 > 语义等级 > 注册顺序${grouped.length < 3 ? '；不足 3 个，如实给出' : ''}）`;

  const lines: string[] = [`识别：物种=${speciesText}；意图=${intentText}`, header];
  if (onlySpecies) {
    shown.forEach((group, index) => {
      lines.push(`${circled(index)} ${group.sourceId}｜${group.semantics}（${group.tools.length} 个工具）`);
      lines.push(`   可用意图：${group.allIntents.join('、') || '（目录未标注）'}`);
      lines.push(`   盲区：${group.blindSpots.slice(0, 2).join('；')}${group.blindSpots.length > 2 ? `（另有 ${group.blindSpots.length - 2} 条，见工具描述）` : ''}`);
    });
    lines.push('下一步：请明确意图（如 表达/变异/同源）后我给出精确工具；也可用 species_hint/intent_hint 显式指定。');
  } else {
    shown.forEach((group, index) => {
      lines.push(`${circled(index)} ${group.sourceId}｜${group.semantics}`);
      lines.push(`   命中：物种=${group.speciesLabels.join('、') || '不限'}；意图=${group.intentLabels.join('、')}`);
      lines.push(`   工具：${group.tools.join('、')}`);
      lines.push(`   盲区：${group.blindSpots.slice(0, 3).join('；')}`);
    });
    if (omitted > 0) lines.push(`另有 ${omitted} 个较弱命中未列。`);
    lines.push(`下一步：直接调 ${shown[0]!.tools[0]}（全部工具现在就可调用，无需激活），参数见其 schema。`);
  }
  /**
   * 有候选时**不输出**"接近但不覆盖"节。
   * 理由：此时"ic4r 不覆盖小麦"这类条目没有任何决策价值，只会稀释真正的候选；
   * 契约里这一节本身就标注"可省"。缺口/线索只在状态 B（0 候选）时输出，那里它才是解释。
   */

  return finish(lines.join('\n'), tail, {
    recognized: found,
    candidates: shown.map((group) => ({ sourceId: group.sourceId, tools: group.tools })),
    gaps,
    clues,
    state: 'ok',
  });
}

function circled(index: number): string {
  return ['①', '②', '③', '④', '⑤'][index] ?? `${index + 1}.`;
}

function summarize(question: string): string {
  const text = question.trim();
  return text.length <= 40 ? text : `${text.slice(0, 39)}…`;
}

/**
 * 拼装最终文本：**先扣免责行与尾注**，正文超预算才截断；免责行与尾注永不截断。
 *
 * 顺序必须是"先扣后截"：`truncateToBytes` 只按预算切，不判断哪些内容不能切。
 * 早先把 DISCLAIMER 拼在 body 里、只预留 tail，正文一超限就把"未探测上游"说明切掉
 * （RETR-09 同类缺陷，审查在 hub_status 上复现、此处为同类风险）。
 */
function finish(
  body: string,
  tail: string,
  raw: FindSourcesOutput['raw'],
): FindSourcesOutput {
  const marker = '…（正文已截断；请缩小问题范围）';
  const reserved = utf8Bytes(tail) + utf8Bytes(DISCLAIMER) + utf8Bytes(marker) + 3; // 3 = 三个换行
  const budget = Math.min(MAX_BODY_BYTES, DEFAULT_MAX_BYTES - reserved);
  if (budget <= 0) {
    throw new Error('hub_find_sources 的免责行与尾注已超出 4 KB 预算，无法保证出处完整');
  }
  const clipped = truncateToBytes(body, budget);
  const text = [
    clipped.text,
    clipped.truncated ? marker : '',
    DISCLAIMER,
    tail,
  ].filter((part) => part !== '').join('\n');
  if (utf8Bytes(text) > DEFAULT_MAX_BYTES) {
    throw new Error('hub_find_sources 输出预算不变量被破坏');
  }
  return { text, raw };
}

export interface CatalogSnapshot {
  readonly version: string;
  readonly sourceCount: number;
  readonly toolCount: number;
  /**
   * 本服务实际注册的业务工具名。装配时从注册表取，**必须是运行时值**：
   * 子集启用（`createRegistry({ enabled })`）时它与全局能力目录不同，
   * 不求交就会推荐不存在的工具并承诺可调用（RETR-12）。
   */
  readonly enabledTools?: readonly string[];
}

/**
 * 工厂：把「目录快照」（版本与规模）注入工具。
 *
 * 为什么不用 ctx：ToolContext 只有 http/signal，加字段等于改公共契约；
 * 而版本与规模在装配时就已知，注入进来最简单，也不让检索工具去碰 registry。
 */
export function createFindSourcesTool(snapshot: CatalogSnapshot): ToolDefinition {
  const tool: ToolDefinition = {
    name: 'hub_find_sources',
    description:
      '不知道哪个数据库能回答时先用它：给一句自然语言问题（可带 species_hint/intent_hint），'
      + '返回候选源与可直接调用的工具名、命中依据与盲区；没有覆盖会如实说「未覆盖」而不是「数据不存在」。'
      + '它是本地目录查询，不发任何上游请求，也不代替具体工具作答。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '自然语言问题，例如「小麦里调控春化的已知基因」' },
        species_hint: { type: 'string', description: '可选：物种提示（中文/拉丁名/俗名），用于兜底识别' },
        intent_hint: { type: 'string', description: '可选：意图提示（如 表达 / 变异 / 同源 / 序列）' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    async run(args): Promise<ToolResult> {
      validateArgs(tool, args);
      const input: FindSourcesInput = {
        question: String(args.question ?? ''),
        speciesHint: args.species_hint === undefined ? undefined : String(args.species_hint),
        intentHint: args.intent_hint === undefined ? undefined : String(args.intent_hint),
      };
      const result = findSources(input, {
        version: snapshot.version,
        sourceCount: snapshot.sourceCount,
        toolCount: snapshot.toolCount,
        enabledTools: snapshot.enabledTools,
      });
      return {
        text: result.text,
        raw: result.raw,
        meta: {
          sourceId: 'hub',
          request: `LOCAL hub_find_sources(question=${input.question})`,
          url: 'local://capability-catalog',
          status: 200,
          durationMs: 1,
          at: new Date().toISOString(),
        },
      };
    },
  };
  return tool;
}

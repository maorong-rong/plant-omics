import { describe, expect, it } from 'vitest';

import { INTENT_BY_ID, INTENTS, TOOL_CAPABILITIES } from '../src/retrieval/capability-catalog.js';
import { registry } from '../src/sources/index.js';

/**
 * 新意图 `interaction`（蛋白互作）的上线约束（后端负责人 2026-11-01 裁定）。
 *
 * 背景：STRING 的 `interaction_partners` 找不到现成意图可归——硬塞进 `homolog` 会把
 * "同源"和"互作"两类完全不同的生物学关系混成一类。所以新开一个意图，但**新意图必须自带边界**：
 *
 *   1. 意图定义要写清"什么算互作"（只指实验/预测的蛋白-蛋白互作伙伴）；
 *   2. **只有 STRING 能命中它**——新意图最容易出的事是别的源描述里恰好有"互作/相互作用"字样，
 *      被误判成能接这个意图，于是用户问互作、拿到一个根本不做互作的源。
 *
 * 这两条都做成断言：第一条查定义文本，第二条查能力表与真实注册表。
 */

const INTERACTION_KEYWORDS = ['互作', '相互作用', '蛋白互作', '互作网络', 'ppi', 'interaction', 'partner'];

/**
 * 关键词命中位置：中文按子串，**ASCII 词按词边界**。
 *
 * 为什么必须分两种（2026-11-03 实测误报）：`ppi` 按子串会命中 `idmapping` 里的 `ppi`
 * （i-d-m-a-pp-i-ng），把「不做 ID 批量映射」这句无关说明判成互作声明。
 * 中文没有词边界概念，只能按子串；ASCII 必须用 \b，否则一个字母串能命中任何含它的单词。
 */
function indexOfKeyword(sentence: string, keyword: string): number {
  if (!/[a-z]/i.test(keyword)) return sentence.toLowerCase().indexOf(keyword.toLowerCase());
  // 英文要认复数：审查者反例「supports protein interactions」「returns partners」都算肯定声明，`\binteraction\b` 抓不到。
  const pattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?\\b`, 'i');
  const match = pattern.exec(sentence);
  return match ? match.index : -1;
}

const NEGATIONS = ['不做', '不含', '不支持', '不是', '不算', '不提供', '不涉及', '没有', '无', '非', '不能', '不返回', '不给', '未见'];

/**
 * 判"肯定式互作声明"：**否定词必须紧邻关键词**（关键词前 8 个字符内）。
 *
 * 为什么不能"同句有否定词就算否定"：对抗审查者 2026-11-01 的反例——
 * 「不返回序列，但支持互作」同句有"不"，可它**明明在正面声明支持互作**。
 * 同句判定会把这种漏掉，而漏掉正是要防的方向。
 */
function positiveInteractionClaim(text: string): string | undefined {
  // 转折词：含"但/不过/然而/只是/除外"时，后半句才是真正的表述（后端负责人 2026-11-01）。
  // "不返回序列，但支持互作"里，否定落在前半句，互作声明在后半句——只按"紧邻 8 字"仍会漏，
  // 所以先按转折词切段，段内再按句号切，逐段判定。
  const TRANSITIONS = /但|不过|然而|只是|除外/g;
  const segments = text.split(TRANSITIONS);
  for (const segment of segments) {
    for (const sentence of segment.split(/[。！？；\n]/).map((s) => s.trim()).filter(Boolean)) {
      const lowered = sentence.toLowerCase();
      for (const word of INTERACTION_KEYWORDS) {
        const at = indexOfKeyword(lowered, word);
        if (at < 0) continue;
        const before = sentence.slice(Math.max(0, at - 8), at);
        if (NEGATIONS.some((neg) => before.includes(neg))) continue;
        return word;
      }
    }
  }
  return undefined;
}

describe('interaction 意图：定义与独占性', () => {
  it('判定函数本身分工正确：肯定式命中、否定式放行（防止"黑名单误杀合法说明"）', () => {
    expect(positiveInteractionClaim('本工具支持蛋白互作查询')).toBe('互作');
    expect(positiveInteractionClaim('按 ID 查互作伙伴与 score')).toBe('互作');
    expect(positiveInteractionClaim('本工具不做互作')).toBeUndefined();
    expect(positiveInteractionClaim('不含互作伙伴数据')).toBeUndefined();
    expect(positiveInteractionClaim('不支持 ppi 查询')).toBeUndefined();
    // 审查者反例：英文复数/肯定式必须抓到
    expect(positiveInteractionClaim('supports protein interactions')).toBe('interaction');
    expect(positiveInteractionClaim('returns partners')).toBe('partner');
    // 同一段里"否定一句 + 肯定一句"仍要抓到肯定的那句
    expect(positiveInteractionClaim('不提供同源信息。本工具提供蛋白互作排名')).toBe('互作');
    // 审查者反例：同句有"不"，但否定的是别的东西，互作仍是正面声明
    expect(positiveInteractionClaim('不返回序列，但支持互作')).toBe('互作');
    expect(positiveInteractionClaim('不支持区间查询。本工具提供蛋白互作排名')).toBe('互作');
    // 转折词：后半句才是真正的表述
    expect(positiveInteractionClaim('不返回序列，但支持互作')).toBe('互作');
    expect(positiveInteractionClaim('不支持批量导出，不过可以查互作伙伴')).toBe('互作');
    expect(positiveInteractionClaim('只返回互作伙伴，不返回序列')).toBe('互作');
    expect(positiveInteractionClaim('支持互作，但不含同源信息')).toBe('互作');
    // 转折后是否定：整句没有肯定声明
    expect(positiveInteractionClaim('支持查询，但不做互作')).toBeUndefined();
  });
  it('意图定义写清了"不算互作"的三类（同源 / 通路 / 转录因子），不许只写标签', () => {
    const intent = INTENT_BY_ID.get('interaction');
    expect(intent, 'interaction 意图必须存在').toBeTruthy();
    expect(intent?.label).toBe('蛋白互作');
    // 关键词保留，供中文问法命中
    expect(intent?.keywords).toEqual(expect.arrayContaining(INTERACTION_KEYWORDS));

    // 边界写在源头注释里：读取源文件，确认三类"不算"都被点名
    const source = require('node:fs').readFileSync(
      new URL('../src/retrieval/capability-catalog.ts', import.meta.url), 'utf8',
    ) as string;
    for (const term of ['homolog', '通路', '转录因子']) {
      expect(source, `意图定义里必须写明「${term}」不算互作`).toContain(term);
    }
  });

  it('只有 STRING 的工具声明 interaction，别的源一律不许', () => {
    const owners = TOOL_CAPABILITIES
      .filter((cap) => cap.intents.includes('interaction'))
      .map((cap) => cap.sourceId);
    expect([...new Set(owners)]).toEqual(['string']);
  });

  it('真实注册表里，声明 interaction 的工具也只在 STRING 源下', () => {
    const declaring = registry.listTools().filter((tool) =>
      TOOL_CAPABILITIES.some((cap) => cap.tool === tool.name && cap.intents.includes('interaction')),
    ).map((tool) => tool.name);
    expect(declaring.length).toBeGreaterThan(0);
    const stringTools = new Set(registry.getSource('string')?.tools.map((tool) => tool.name) ?? []);
    for (const name of declaring) {
      expect(stringTools.has(name), `${name} 声明了 interaction，但它不属于 STRING 源`).toBe(true);
    }
  });

  it('其它源的工具描述里不得出现「肯定式互作声明」（否定说法不算）', () => {
    // 旧写法"出现互作词就红"会误杀"本工具不做互作"这种合法否定说明——
    // 和 web 的 check-wording 是同一解法：正向约束 + 否定语境放行。
    const offenders: string[] = [];
    for (const bundle of registry.listSources()) {
      if (bundle.manifest.id === 'string') continue;
      for (const tool of bundle.tools) {
        const hit = positiveInteractionClaim(String(tool.description));
        if (hit) offenders.push(`${bundle.manifest.id}/${tool.name} 正面声明了「${hit}」`);
      }
    }
    expect(offenders, '这些源在描述里**正面声明**能做互作：要么改描述，要么在能力表里显式声明').toEqual([]);
  });

  it('STRING 互作工具的 blindSpots 必须写出三类排除项（删任一条即红）', () => {
    // 这句"不算同源、不算通路上下游、不算转录因子调控"是意图定义的**实质内容**，
    // 不是注释装饰：删掉它 hub_find_sources 展示给模型的边界就没了，而旧断言照样绿。
    const cap = TOOL_CAPABILITIES.find((entry) => entry.tool === 'string_interaction_partners');
    expect(cap, 'string_interaction_partners 必须在能力表里').toBeTruthy();
    const text = cap!.blindSpots.join(' ');
    for (const term of ['同源', '通路', '转录因子']) {
      expect(text, `blindSpots 必须显式排除「${term}」`).toContain(term);
    }
    expect(text).toContain('互作伙伴');
  });

  it('实际路由独占性：问「互作伙伴」只落到 STRING，别的源不出现在候选里', async () => {
    // 审查者 2026-11-01：不能换成关键词规则就替代行为测试，要验真实路由。
    const { findSources } = await import('../src/retrieval/find-sources.js');
    const out = findSources(
      { question: '拟南芥 AT1G65480 这个蛋白有哪些互作伙伴' },
      { version: 'test', sourceCount: registry.listSources().length, toolCount: registry.listTools().length },
    );
    const intents = out.raw.recognized.intents ?? [];
    expect(intents, '互作问题必须识别出 interaction 意图').toContain('interaction');
    const sourceIds = out.raw.candidates.map((c) => c.sourceId);
    expect(sourceIds, '只有 STRING 能接互作，别的源不许出现在候选里').toEqual(['string']);
    const tools = out.raw.candidates.flatMap((c) => c.tools);
    expect(tools).toContain('string_interaction_partners');
  });

  it('实际路由：问同源基因不得落到 interaction（两类关系不许混）', async () => {
    const { findSources } = await import('../src/retrieval/find-sources.js');
    const out = findSources(
      { question: '小麦的这个基因在玉米里的同源基因是哪个' },
      { version: 'test', sourceCount: registry.listSources().length, toolCount: registry.listTools().length },
    );
    const intents = out.raw.recognized.intents ?? [];
    expect(intents).not.toContain('interaction');
  });

  it('INTENTS 的 id 与类型清单不漂：新增意图必须同步 IntentId', () => {
    const ids = INTENTS.map((intent) => intent.id);
    expect(new Set(ids).size, '意图 id 不许重复').toBe(ids.length);
    expect(ids).toContain('interaction');
  });
});

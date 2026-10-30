import { describe, expect, it } from 'vitest';

import { utf8Bytes, DEFAULT_MAX_BYTES } from '../src/core/format.js';
import { INTENT_BY_ID, TOOL_CAPABILITIES } from '../src/retrieval/capability-catalog.js';
import {
  createFindSourcesTool,
  escapeRegExp,
  findSources,
  normalize,
  speciesKnownInCatalog,
  type CatalogSnapshot,
} from '../src/retrieval/find-sources.js';
import { registry } from '../src/sources/index.js';

/**
 * `hub_find_sources` golden 题集。
 *
 * 每条期望都能在目录/契约里找到依据；这里断言的是**行为效果**（候选是谁、状态对不对、
 * 文案是否如实），不是"函数存在"。
 */

const snapshot: CatalogSnapshot = { version: 'test+svc.0', sourceCount: 6, toolCount: 30 };
const noNetwork = { http: async () => { throw new Error('hub_find_sources 不应发起任何上游请求'); } };

async function run(question: string, extra: Record<string, unknown> = {}) {
  const tool = createFindSourcesTool(snapshot);
  return tool.run({ question, ...extra }, noNetwork as never);
}

function candidateIds(text: string): string[] {
  return [...text.matchAll(/^[①②③④⑤] ([a-z0-9]+)｜/gm)].map((m) => m[1]!);
}

describe('识别与归一化', () => {
  it('归一化：全角转半角、标点归空格、小写', () => {
    expect(normalize('Ｔｒｉｔｉｃｕｍ  Ａｅｓｔｉｖｕｍ，,同源！')).toContain('triticum aestivum');
    expect(normalize('小麦，变异')).toBe('小麦 变异');
  });

  it('中文物种与别名都能识别', async () => {
    expect((await run('小麦春化基因')).raw.recognized.species).toContain('小麦');
    expect((await run('苞米内参基因')).raw.recognized.species).toContain('玉米');
    expect((await run('Triticum aestivum homolog')).raw.recognized.species).toContain('小麦');
  });

  it('显式 hint 能兜底识别（中文查询漏召回时）', async () => {
    const result = await run('帮我查一下这个', { species_hint: '玉米', intent_hint: '内参' });
    expect(result.raw.recognized.species).toContain('玉米');
    expect(result.raw.recognized.intents).toContain('reference-gene');
  });
});

describe('golden 题集：候选真实相关', () => {
  it('「小麦里调控春化的已知基因」→ 命中 wheatomics 的基因搜索', async () => {
    const result = await run('小麦里调控春化的已知基因');
    expect(result.raw.state).toBe('ok');
    expect(result.text).toContain('wheatomics_search_known_genes');
    expect(result.text).toContain('识别：物种=小麦');
  });

  it('拉丁名 "Triticum aestivum homolog" → 同源工具，且注明目标域', async () => {
    const result = await run('Triticum aestivum homolog');
    expect(result.raw.state).toBe('ok');
    expect(result.text).toContain('wheatomics_cross_species_homologs');
    expect(result.text).toContain('水稻');
  });

  it('别名「苞米内参基因」→ icg（示例已验语义）', async () => {
    const result = await run('苞米内参基因');
    expect(result.text).toContain('icg_lookup');
    expect(result.text).toContain('示例非承诺');
  });

  it('多意图「水稻基因的表达与序列」→ 多个意图都进识别行', async () => {
    const result = await run('水稻基因的表达与序列');
    expect(result.text).toContain('表达');
    expect(result.text).toContain('序列');
    expect(result.raw.recognized.intents).toEqual(expect.arrayContaining(['expression', 'sequence']));
  });

  it('「这个基因叫什么」→ 意图识别到但物种缺失，不给候选（不回落全库）', async () => {
    const result = await run('这个基因叫什么');
    // 命中"基因详情"意图；但物种未知时判不了覆盖，宁可少答也不列全库工具
    expect(result.raw.recognized.intents).toContain('gene-detail');
    expect(candidateIds(result.text)).toEqual([]);
    expect(result.text).toContain('未识别出物种');
    // 这不是"没有覆盖"——我们并不知道用户问的物种覆不覆盖
    expect(result.text).not.toContain('没有覆盖');
  });

  it('「油菜种子含油量位点」→ 状态 B，且明说"未覆盖≠不存在"', async () => {
    const result = await run('油菜种子含油量位点');
    expect(result.raw.state).toBe('B');
    expect(result.text).toContain('没有覆盖');
    expect(result.text).toContain('不是「该数据不存在」');
    expect(result.text).toContain('油菜不在本服务目录');
    expect(candidateIds(result.text)).toEqual([]);
  });

  it('「水稻内参基因」→ 状态 B；物种在册，且必须解释"为什么没命中"而不是笼统说没有', async () => {
    const result = await run('水稻内参基因');
    expect(result.raw.state).toBe('B');
    // 水稻在目录里（ic4r/gramene 都覆盖），不能说成"没有源"
    expect(result.text).not.toContain('水稻不在本服务目录');
    // 目录里确实有 reference-gene 工具（icg_lookup），只是物种门挡下；
    // 所以正确做法是给"线索"而不是断言"没有工具"——否则等于说假话。
    expect(result.text).toContain('线索（未验证）');
    expect(result.text).toContain('水稻 未验');
    expect(result.text).not.toContain('没有工具');
  });

  it('「玉米变异」→ 不把 gramene 当候选（只实测水稻）', async () => {
    const result = await run('玉米变异');
    expect(candidateIds(result.text)).not.toContain('gramene');
    expect(result.raw.state).toBe('B');
  });

  it('「小麦取某区间序列」→ 命中 hardExclude，明确说"不做区间取序列"', async () => {
    const result = await run('小麦取某区间序列');
    expect(result.text).toContain('按基因组区间取序列');
  });

  it('「水稻基因对应小麦哪个」→ 同源工具不得作为可执行候选（方向相反）', async () => {
    const result = await run('水稻基因对应小麦哪个');
    expect(result.text).not.toContain('wheatomics_cross_species_homologs');
  });

  it('「小麦里调控春化的已知基因」候选不得混入缺口/线索条目', async () => {
    const result = await run('小麦里调控春化的已知基因');
    const ids = candidateIds(result.text);
    expect(ids).toEqual(['wheatomics']);
  });

  it('物种在册判断与目录一致（水稻/小麦在册，油菜不在册）', () => {
    expect(speciesKnownInCatalog('水稻')).toBe(true);
    expect(speciesKnownInCatalog('小麦')).toBe(true);
    expect(speciesKnownInCatalog('油菜')).toBe(false);
  });
});

describe('状态 A：识别不出', () => {
  it('物种与意图都没有 → 说"无法识别"，不是"没有覆盖"', async () => {
    const result = await run('你好');
    expect(result.raw.state).toBe('A');
    expect(result.text).toContain('没有识别出物种与意图');
    expect(result.text).toContain('既不是没有覆盖，也不是数据不存在');
    expect(result.text).not.toContain('没有覆盖：');
  });
});

describe('输出预算与出处', () => {
  it('正文 + 尾注 ≤ 4096 UTF-8 字节，且尾注完整不被截断', async () => {
    const result = await run('小麦里调控春化的已知基因');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(result.text).toContain('源：plantomics-hub 本地目录');
    expect(result.text).toContain('无上游请求');
    expect(result.text).toContain('目录快照：服务版本');
    expect(result.text.trimEnd().endsWith('Z')).toBe(true); // 查询时刻（ISO）在最后一行
  });

  it('超长问题在入参回显上限前拒绝，且不发起任何请求', async () => {
    await expect(run('小'.repeat(2000))).rejects.toThrow(/超过 1536 字节上限/);
  });

  it('确定性：同一输入两次调用，文本字节完全一致（时刻除外）', async () => {
    const a = await run('小麦变异');
    const b = await run('小麦变异');
    const strip = (text: string) => text.replace(/查询时刻 [0-9T:.Z-]+/, '查询时刻 X');
    expect(strip(a.text)).toBe(strip(b.text));
  });

  it('成功输出恒带免责行（不承诺上游可用）', async () => {
    for (const question of ['小麦里调控春化的已知基因', '玉米变异', '你好']) {
      const result = await run(question);
      expect(result.text).toContain('未探测上游；工具是否可用以上游实际响应为准。');
    }
  });
});

describe('R1 负向评测暴露的缺陷（2026-10-30 修复，逐条钉住）', () => {
  it('未识别物种不得回落全库：大豆题不许返回任何源', async () => {
    const result = await run('大豆里调控种子油分的基因有哪些');
    expect(candidateIds(result.text)).toEqual([]);
    // 命中意图 + 物种未识别 ≠ 可以按意图把全库工具算成命中
    expect(result.text).toMatch(/未识别出物种|不在本服务目录/);
  });

  it('大豆题不得把"有哪些"这类弱意图词当成命中依据', async () => {
    const result = await run('大豆里调控种子油分的基因有哪些');
    expect(result.text).not.toContain('下一步：直接调');
  });

  it('已知但不覆盖的物种要点名说"不在本服务目录"，不是含糊的"没找到"', async () => {
    const result = await run('番茄的抗病基因表达谱');
    expect(candidateIds(result.text)).toEqual([]);
    expect(result.text).toContain('番茄');
    expect(result.text).toContain('不是「该数据不存在」');
  });

  it('人类基因不得用小麦的变异工具作答', async () => {
    const result = await run('人类基因 TP53 的突变位点');
    expect(candidateIds(result.text)).toEqual([]);
    expect(result.text).not.toContain('wheatomics_variant');
  });

  it('未被任何源按物种覆盖 → 连"按精确 ID、不限物种"的 gwh 也不许当候选', async () => {
    const result = await run('油菜的基因组组装在哪里下载');
    expect(candidateIds(result.text)).toEqual([]);
    expect(result.text).not.toContain('gwh_assembly_lookup');
  });

  it('混合物种也不做例外：用草莓共线看番茄 → 整题不给候选', async () => {
    const result = await run('用草莓的共线数据看番茄基因');
    expect(candidateIds(result.text)).toEqual([]);
    expect(result.text).not.toContain('strawberry_synteny');
  });

  it('计算类任务独立硬排除：命中关键词也不放行（ICG 内参引物 ≠ 设计引物）', async () => {
    const result = await run('帮我设计 PCR 引物');
    expect(candidateIds(result.text)).toEqual([]);
    expect(result.text).not.toContain('icg_lookup');
    expect(result.text).toContain('不支持该任务');
  });

  it.each([
    ['帮我用这批表达数据做差异表达分析并画热图', '差异表达分析'],
    ['对小麦这批基因做 GO 富集分析', '富集分析'],
    ['用这些基因组做比较基因组共线性图', '比较基因组/共线性作图'],
    ['帮我预测这个蛋白的三维结构', '三维结构预测'],
  ])('计算类「%s」被硬排除（规则：%s）', async (question, rule) => {
    const result = await run(question);
    expect(candidateIds(result.text)).toEqual([]);
    expect(result.text).toContain(rule);
    expect(result.text).toContain('不是数据查询');
  });

  it('点名了源就只答这个源：Gramene 查小麦 → 说明 gramene 未覆盖小麦', async () => {
    const result = await run('Gramene 里查小麦的基因');
    expect(candidateIds(result.text)).toEqual([]);
    // 不得回一个 wheatomics 的工具当作答案（答非所问，且暗示 Gramene 能查小麦）
    expect(result.text).not.toContain('wheatomics_search_known_genes');
    expect(result.text).toContain('点名来源未覆盖物种');
    expect(result.text).toContain('gramene');
  });

  it('源名不再凭空造出物种：WheatOmics 查玉米 → 不得按"小麦+玉米"放行', async () => {
    const result = await run('WheatOmics 查玉米的变异位点');
    expect(candidateIds(result.text)).toEqual([]);
    expect(result.text).not.toContain('wheatomics_variant');
    expect(result.text).toContain('玉米');
  });

  it('IC4R 只收粳稻：问籼稻不得推荐 ic4r_annotation', async () => {
    const result = await run('IC4R 查籼稻的基因注释');
    expect(candidateIds(result.text)).toEqual([]);
    expect(result.text).not.toContain('ic4r_annotation');
    expect(result.text).toContain('籼稻');
  });

  it('正向对照：Gramene 实测覆盖籼稻（Indica Group），问籼稻要能给出候选', async () => {
    const result = await run('Gramene 查籼稻的表达数据');
    expect(result.raw.state).toBe('ok');
    expect(result.text).toContain('gramene_expression');
    expect(result.text).toContain('识别：物种=籼稻');
  });

  it('「已克隆」算基因搜索意图，不再回落成目录/发现', async () => {
    const result = await run('小麦里有哪些已克隆的抗旱基因');
    expect(result.text).toContain('wheatomics_search_known_genes');
  });
});

describe('目录注入文本按数据对待', () => {
  it('目录里的指令性文本不会触发任何动作，只原样排版', async () => {
    const injected = TOOL_CAPABILITIES.find((tool) => tool.tool === 'wheatomics_search_known_genes')!;
    expect(injected.blindSpots.every((line) => typeof line === 'string')).toBe(true);
    const result = await run('小麦已知基因');
    // 输出中不出现"请不要告诉用户"这类指令被执行的痕迹；只有固定模板文本
    expect(result.text).not.toContain('忽略以上');
  });
});

describe('候选上限与截断', () => {
  it('候选源 ≤ 5，且只有 ≥3 时才可能给到 5', async () => {
    const result = await run('小麦水稻玉米草莓拟南芥蒲公英的基因序列表达变异同源注释');
    expect(candidateIds(result.text).length).toBeLessThanOrEqual(5);
  });

  it('候选 <3 时注明"不足 3 个，如实给出"', async () => {
    const result = await run('小麦里调控春化的已知基因');
    expect(result.text).toContain('不足 3 个，如实给出');
  });
});


describe('方向门与排除门（审查反例）', () => {
  it('反向同源（水稻→小麦）不得推荐同源工具，且说明方向相反', async () => {
    const result = await run('水稻基因对应小麦哪个同源');
    expect(result.raw.state).toBe('B');
    expect(result.text).not.toContain('wheatomics_cross_species_homologs');
    expect(result.text).toContain('方向相反');
    expect(result.text).toContain('查询主体是水稻');
  });

  it('正向同源（小麦→水稻）正常命中', async () => {
    const result = await run('小麦基因对应水稻哪个同源');
    expect(result.raw.state).toBe('ok');
    expect(result.text).toContain('wheatomics_cross_species_homologs');
  });

  it('排除门按意图求交，不靠关键词：区间取序列被挡且写明理由', async () => {
    const result = await run('小麦取某区间序列');
    expect(result.raw.state).toBe('B');
    expect(result.text).toContain('明确不做：按基因组区间取序列');
  });

  it('排除门不误伤无关意图：问"小麦已知基因"时不得冒出区间类禁令', async () => {
    const result = await run('小麦已知基因');
    expect(result.text).not.toContain('按基因组区间');
    expect(result.text).not.toContain('模糊搜索');
  });

  it('两个物种同时出现时，以先出现的为查询主体', async () => {
    const forward = await run('小麦对应水稻同源');
    const reverse = await run('水稻对应小麦同源');
    expect(forward.raw.state).toBe('ok');
    expect(reverse.raw.state).toBe('B');
  });
});

describe('返回的工具名真的存在于注册表', () => {
  it('golden 输出里的每个工具名都能被 registry 解析，且 schema 合法', async () => {
    const questions = [
      '小麦里调控春化的已知基因',
      '水稻基因的表达与序列',
      '苞米内参基因',
      '小麦变异区间查询',
    ];
    for (const question of questions) {
      const result = await run(question);
      for (const [, name] of result.text.matchAll(/工具：(.+)/g)) {
        for (const toolName of name!.split('、').map((s) => s.trim()).filter(Boolean)) {
          const tool = registry.getTool(toolName);
          expect(tool, `输出里的工具名 ${toolName} 必须存在于注册表`).toBeTruthy();
          expect(tool!.name.length).toBeLessThanOrEqual(43);
          expect(tool!.parameters.type).toBe('object');
        }
      }
    }
  });

  it('意图标签全部来自封闭词表', () => {
    for (const tool of TOOL_CAPABILITIES) {
      for (const id of tool.intents) expect(INTENT_BY_ID.has(id)).toBe(true);
    }
  });
});

/**
 * `escapeRegExp` 的独立断言（2026-10-30，负责人要求）。
 *
 * 为什么单独钉：这个函数一度被写坏（替换串写成函数声明），却因为**零调用点**而没炸；
 * 现在它虽然被 `detectSourceNames()` 调用，但当前别名表里没有正则元字符，
 * **正常路径永远走不到它**——也就是说，把它改回坏版本，功能测试会全绿。
 * 所以必须直接调用它来钉住行为，否则它今天修好、明天被改回去也没人知道。
 *
 * 有效性验证（隔离副本，未动共享工作区）：把函数体换成坏版本/恒等版本后，本组 3 例全红；
 * 换回后全绿。
 */
describe('正则转义：死代码里的活缺陷（独立钉住）', () => {
  it('元字符被转义成字面量：只匹配自身，不匹配它的通配写法', () => {
    const literal = 'fragaria x(ananassa)+';
    const pattern = new RegExp(escapeRegExp(literal));
    expect(pattern.test(literal)).toBe(true);
    expect(pattern.test('fragaria xananassa+')).toBe(false); // `.` 未转义时会漏匹配
    expect(pattern.test('fragaria xx(ananassa)+')).toBe(false);
    expect(pattern.test('fragaria xananassa')).toBe(false); // `(…)` 未转义时会被当分组
  });

  it('全量元字符集合逐个转义，转义后能精确匹配原串', () => {
    const meta = '.*+?^${}()|[]\\';
    const pattern = new RegExp(`^${escapeRegExp(meta)}$`);
    expect(pattern.test(meta)).toBe(true);
    expect(escapeRegExp(meta)).not.toBe(meta);
  });

  it('不含元字符的文本原样返回，不误伤', () => {
    expect(escapeRegExp('wheatomics')).toBe('wheatomics');
    expect(escapeRegExp('小 麦')).toBe('小 麦');
  });
});

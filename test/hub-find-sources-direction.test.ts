/**
 * `hub_find_sources` 的方向门与无覆盖文案验收（检索负责人持）。
 *
 * 这组用例来自两个真实反例：
 *   1. 只用"物种集合是否与 target 相交"判方向，遇到「水稻基因对应小麦哪个」时
 *      集合同时命中 query 与 target，方向永远判不出来；
 *   2. 「在水稻里找小麦的同源」里水稻先出现却是**目标**，用"第一个物种"同样判错。
 * 因此方向必须由**方向短语**解析，语法见 `resolveDirection`。
 */

import { describe, expect, it } from 'vitest';

import type { Fetcher } from '../src/core/types.js';
import { createRegistry } from '../src/sources/index.js';

const forbiddenHttp = (async (url: string) => {
  throw new Error(`hub_find_sources 不应联网，但请求了 ${url}`);
}) as Fetcher;

function findSources(question: string): Promise<string> {
  const registry = createRegistry();
  const tool = registry.getTool('hub_find_sources');
  if (!tool) throw new Error('hub_find_sources 未接线');
  return tool.run({ question }, { http: forbiddenHttp }).then((result) => result.text);
}

describe('方向门：按方向短语判，不按集合交集判', () => {
  it('反查（水稻基因→小麦）不可执行，写明方向相反', async () => {
    const text = await findSources('水稻基因对应小麦哪个同源基因');
    expect(text).toContain('方向相反');
    expect(text).toContain('查询主体是水稻');
    expect(text).not.toContain('wheatomics_cross_species_homologs');
  });

  it('正查（小麦基因→水稻）命中同源工具', async () => {
    const text = await findSources('小麦基因对应水稻哪个同源基因');
    expect(text).toContain('wheatomics_cross_species_homologs');
    expect(text).not.toContain('方向相反');
  });

  it('目标物种先出现也不影响方向：在水稻里找小麦的同源 → 可执行', async () => {
    const text = await findSources('在水稻里找小麦的同源基因');
    expect(text).toContain('wheatomics_cross_species_homologs');
    expect(text).not.toContain('方向相反');
  });

  it('「在X中」是目标端：在小麦里找水稻的同源 → 不可执行', async () => {
    const text = await findSources('在小麦里找水稻的同源基因');
    expect(text).toContain('方向相反');
    expect(text).not.toContain('wheatomics_cross_species_homologs');
  });

  it('并列物种且无方向词 → 不判方向，正常命中并在盲区说明目标域', async () => {
    const text = await findSources('小麦和水稻的同源基因');
    expect(text).toContain('wheatomics_cross_species_homologs');
    expect(text).not.toContain('方向相反');
    expect(text).toContain('目标域只有水稻与拟南芥');
  });

  it('无「在」字的作用域也算目标端：水稻中查找小麦基因的同源 → 可执行', async () => {
    const text = await findSources('水稻中查找小麦基因的同源基因');
    expect(text).toContain('wheatomics_cross_species_homologs');
    expect(text).not.toContain('方向相反');
  });

  it('反向同样成立：小麦中查找水稻基因的同源 → 方向相反', async () => {
    const text = await findSources('小麦中查找水稻基因的同源基因');
    expect(text).toContain('方向相反');
    expect(text).not.toContain('wheatomics_cross_species_homologs');
  });

  it('「X中的」不是作用域：「小麦中的同源基因」正常命中', async () => {
    const text = await findSources('小麦中的同源基因');
    expect(text).toContain('wheatomics_cross_species_homologs');
    expect(text).not.toContain('方向相反');
  });

  it('「X的同源基因在Y里」：X 是查询主体，Y 是目标端', async () => {
    // 水稻基因的同源基因在小麦里 → 是"水稻→小麦"，与本工具（小麦→水稻/拟南芥）方向相反
    const reverse = await findSources('水稻的同源基因在小麦里是哪个');
    expect(reverse).toContain('方向相反');
    expect(reverse).toContain('查询主体是水稻');
    expect(reverse).not.toContain('wheatomics_cross_species_homologs');

    // 反过来：小麦的同源基因在水稻里 → 可执行
    const forward = await findSources('小麦的同源基因在水稻里是哪个');
    expect(forward).toContain('wheatomics_cross_species_homologs');
    expect(forward).not.toContain('方向相反');
  });

  it('目标物种不在目标端 → 缺口「目标物种不覆盖」，不是方向相反', async () => {
    const text = await findSources('小麦基因在玉米里的同源基因');
    expect(text).toContain('目标物种不覆盖');
    expect(text).not.toContain('wheatomics_cross_species_homologs');
  });
});

describe('排除门：意图求交 + 模式条件，不误杀合法查询', () => {
  it('按基因 ID 取序列不被「按区间取序列」禁令误杀（RETR-04）', async () => {
    const text = await findSources('按小麦基因ID取序列');
    expect(text).toContain('wheatomics_sequence');
    expect(text).not.toContain('明确不做：按基因组区间取序列');
  });

  it('真的问区间序列时才挡，并说明原因', async () => {
    const text = await findSources('取小麦某个区间序列');
    expect(text).toContain('明确不做：按基因组区间取序列');
    expect(text).not.toContain('wheatomics_sequence');
  });

  it('被边界挡下时不得谎称「目录里没有这类工具」', async () => {
    const text = await findSources('取小麦某个区间序列');
    expect(text).not.toContain('没有工具');
    expect(text).toContain('这是「本服务未覆盖」');
  });
});

describe('启用集求交：没注册的工具一个都不许出现（RETR-12）', () => {
  const subset = createRegistry({ enabled: ['wheatomics'] });

  it('只启用小麦时，不得推荐 ic4r / gramene 的工具', async () => {
    const tool = subset.getTool('hub_find_sources');
    expect(tool, 'hub_find_sources 未接线').toBeDefined();
    const out = await tool!.run({ question: '水稻基因详情' }, { http: forbiddenHttp });
    expect(out.text).not.toContain('ic4r_gene');
    expect(out.text).not.toContain('gramene_gene');
    // 也不许把它们当缺口/线索列出来——它们不在本服务里
    expect(out.text).not.toContain('ic4r：');
    expect(out.text).not.toContain('gramene：');
  });

  it('输出的每个工具名都能在当前注册表解析（验收第 3 条）', async () => {
    const tool = subset.getTool('hub_find_sources')!;
    for (const question of ['水稻基因详情', '草莓转录因子', '小麦变异', '油菜含油量位点']) {
      const out = await tool.run({ question }, { http: forbiddenHttp });
      // 只扫"工具：""下一步"这类声明工具名的行，避免把 species_hint 之类的参数名当成工具
      const declared = out.text
        .split('\n')
        .filter((line) => /工具：|下一步：/.test(line))
        .join('\n');
      for (const match of declared.matchAll(/\b([a-z0-9]+_[a-z0-9_]+)\b/g)) {
        const name = match[1]!;
        if (name.startsWith('hub_')) continue;
        expect(subset.getTool(name), `${question} 推荐了不存在的工具 ${name}`).toBeDefined();
      }
    }
  });

  it('全量注册表仍能命中跨源候选（求交没有把正常召回压掉）', async () => {
    const full = createRegistry();
    const tool = full.getTool('hub_find_sources')!;
    const out = await tool.run({ question: '水稻基因详情' }, { http: forbiddenHttp });
    expect(out.text).toContain('ic4r_gene');
  });
});

describe('确定性口径：除查询时刻外逐字节一致', () => {
  it('同一问题两次调用，剥掉时刻后完全一致', async () => {
    const tool = createRegistry().getTool('hub_find_sources')!;
    const strip = (text: string) => text.replace(/查询时刻 [^\n]+/g, '查询时刻 <T>');
    const first = strip((await tool.run({ question: '小麦春化已知基因' }, { http: forbiddenHttp })).text);
    const second = strip((await tool.run({ question: '小麦春化已知基因' }, { http: forbiddenHttp })).text);
    expect(first).toBe(second);
  });
});

describe('RETR-09 同类：正文截断时免责行与尾注必须保留', () => {
  // 构造能真正触达 1408 B 正文预算的问题：多物种 + 多意图，命中多源且盲区较长。
  // （短问题不会触发截断，这也是此前"未能复现"的原因。）
  const LONG_QUESTION = '小麦、水稻、草莓、玉米的基因表达与变异、同源、序列、注释、转录因子、共线、组装、样本、内参基因都要';

  it('触发截断时，免责行与查询时刻仍然完整，且整包 ≤4 KB', async () => {
    const tool = createRegistry().getTool('hub_find_sources')!;
    const out = await tool.run({ question: LONG_QUESTION }, { http: forbiddenHttp });
    const text = out.text;

    expect(text).toContain('正文已截断'); // 证明真的走到了截断分支
    expect(text).toContain('未探测上游；工具是否可用以上游实际响应为准。');
    expect(text).toMatch(/查询时刻/);
    expect(text.trimEnd().endsWith(`查询时刻 ${text.match(/查询时刻 ([^\n]+)/)![1]}`)).toBe(true);
    // 免责行不能重复出现（拼装时只由 finish 追加一次）
    expect(text.split('未探测上游；工具是否可用').length - 1).toBe(1);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(4096);
  });

  it('不截断的短问题同样带免责行与尾注（回归旧行为）', async () => {
    const tool = createRegistry().getTool('hub_find_sources')!;
    const text = (await tool.run({ question: '小麦春化已知基因' }, { http: forbiddenHttp })).text;
    expect(text).not.toContain('正文已截断');
    expect(text).toContain('未探测上游；工具是否可用以上游实际响应为准。');
    expect(text).toMatch(/查询时刻/);
  });
});

describe('无覆盖文案：同物种合并一行', () => {
  it('目录完全没有该物种时，缺口只出现一行并列出源名', async () => {
    const text = await findSources('油菜种子含油量相关位点');
    expect(text).toContain('没有覆盖');
    // 合并后的格式：油菜 不在 wheatomics、strawberry、ic4r 的覆盖范围内
    const merged = text.split('\n').filter((line) => line.includes('不在') && line.includes('覆盖范围内'));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toContain('油菜');
    expect(merged[0]).toMatch(/wheatomics|strawberry|ic4r/);
    // 不再逐源刷屏三条
    expect(text).not.toMatch(/- 缺口：wheatomics：不覆盖物种/);
  });

  it('0 覆盖不等于“数据不存在”：文案必须区分两类事实', async () => {
    const text = await findSources('油菜种子含油量相关位点');
    expect(text).toContain('不是「该数据不存在」');
  });

  it('有候选时不输出缺口节（避免稀释真正的候选）', async () => {
    const text = await findSources('小麦已知基因');
    expect(text).not.toContain('接近但不覆盖');
  });
});

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

describe('启用集求交：未加载源只能出现在「未加载」区块（R1–R5，2026-11-03）', () => {
  /**
   * 原意由 R1–R4 承接：2026-11-03 之前这里是「未加载源一个都不许出现」，
   * 那会让"已接入但本会话没装"的源彻底隐身（接了像没接）。现在允许出现，
   * 但必须待在固定区块里、带加装路径，且不计入「命中 X 源」。
   */
  const subset = createRegistry({ enabled: ['wheatomics'] });
  const runSubset = async (question: string): Promise<string> => {
    const tool = subset.getTool('hub_find_sources');
    if (!tool) throw new Error('hub_find_sources 未接线');
    return (await tool.run({ question }, { http: forbiddenHttp })).text;
  };
  const BLOCK_TITLE = /^另外 \d+ 个相关源未加载/;
  const CIRCLED = /^[①-⑳] /;
  const splitAtBlock = (text: string): { before: string[]; after: string[] } => {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => BLOCK_TITLE.test(line));
    return at < 0 ? { before: lines, after: [] } : { before: lines.slice(0, at), after: lines.slice(at) };
  };
  // 这个问题在「只启用 wheatomics」时同时出现：已加载候选（wheatomics）+ 未加载命中源（覆盖小麦的其它源）
  const QUESTION = '小麦基因详情';

  /** 从「未加载」区块里取源 id（区块项形如 `- string：目录登记 2 个工具｜加装：…`）。 */
  const unloadedIdsOf = (after: string[]): string[] => after.slice(1)
    .filter((line) => line.startsWith('- '))
    .map((line) => /^- ([a-z0-9-]+)：/.exec(line)?.[1])
    .filter((id): id is string => Boolean(id));

  it('R1 结构：未加载源的工具名只许出现在该区块之后，候选区不许有', async () => {
    const { before, after } = splitAtBlock(await runSubset(QUESTION));
    const ids = unloadedIdsOf(after);
    expect(ids.length, '这个问题没有产生「未加载」区块，R1 无从检验').toBeGreaterThan(0);
    const head = before.join('\n');
    const block = after.join('\n');
    for (const id of ids) {
      expect(head, `未加载源 ${id} 的工具名混进了候选区`).not.toContain(`${id}_`);
      // 区块内也不许出现工具名（它只报 id 与目录登记数，不当成可调工具）
      expect(block).not.toContain(`${id}_`);
    }
  });

  it('R2 计数：「命中 X 源」只数已加载的候选，不把未加载源算进去', async () => {
    const text = await runSubset(QUESTION);
    const { before } = splitAtBlock(text);
    const matched = /命中 (\d+) 源/.exec(text);
    expect(matched, '输出里没有「命中 X 源」').toBeTruthy();
    const declared = Number(matched![1]);
    const rendered = before.filter((line) => CIRCLED.test(line)).length;
    expect(declared, `「命中 ${declared} 源」与候选区实际渲染的 ${rendered} 个源不一致`).toBe(rendered);
    expect(before.join('\n'), '未加载的源被算进了候选区').not.toMatch(/^[①-⑳] (ic4r|gramene)｜/m);
  });

  it('R3 区块内容：每项要给源 id、目录登记工具数、可执行的加装路径、以及「不可直接调用」', async () => {
    const { after } = splitAtBlock(await runSubset(QUESTION));
    expect(after.length, '没有「另外 N 个相关源未加载」区块').toBeGreaterThan(1);
    expect(after[0], '区块标题必须写明不可直接调用').toContain('不可直接调用');
    const items = after.slice(1).filter((line) => line.startsWith('- '));
    expect(items.length, '区块里没有列出源').toBeGreaterThan(0);
    for (const item of items) {
      expect(item, `缺源 id 或目录登记数：${item}`).toMatch(/^- [a-z0-9-]+：目录登记 \d+ 个工具/);
      expect(item, `缺加装路径：${item}`).toContain('加装：');
      // 可执行的加装路径：要么点名环境变量/请求头，要么明确「启用后重开会话」。
      // 只说"未加载"不算路径——那就等于只告诉用户"没有"。
      expect(item, `加装路径不可执行：${item}`).toMatch(/PLANTOMICS_SOURCES|x-plantomics-sources|重开会话/);
    }
  });

  it('R4 收尾：「下一步」行不得指向未加载源的工具', async () => {
    const text = await runSubset(QUESTION);
    const steps = text.split('\n').filter((line) => line.startsWith('下一步'));
    expect(steps.length, '输出没有「下一步」行').toBeGreaterThan(0);
    for (const line of steps) {
      expect(line, `下一步把用户指向了未加载源：${line}`).not.toMatch(/ic4r|gramene/);
      expect(line).not.toMatch(/ic4r_|gramene_/);
    }
  });

  it('R5 负控：同一问题在「全源启用」时，那些源的工具名出现在候选区（证明挡住它们的是区块，不是过滤）', async () => {
    const subsetText = await runSubset(QUESTION);
    const ids = unloadedIdsOf(splitAtBlock(subsetText).after);
    const full = await findSources(QUESTION);
    const head = splitAtBlock(full).before.join('\n');
    const visible = ids.filter((id) => head.includes(`${id}_`));
    expect(
      visible.length,
      `全源启用时仍看不到 ${ids.join('/')} 的工具名：说明不是区块在挡，而是它们压根没被召回`,
    ).toBeGreaterThan(0);
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

describe('RETR-09 同类：正文超预算时免责行与尾注必须保留', () => {
  // 2026-10-30 口径变更（v2.2 + 去掉 slice(0,5)）后，超预算不再靠"硬截断正文"，
  // 而是**少列几个命中源并明说"另有 N 个命中源未展示"**。这里保护的东西不变：
  // 免责行只出现一次、尾注完整且以查询时刻收尾、整包 ≤4 KB——只是触发路径换了。
  const LONG_QUESTION = '小麦、水稻、草莓、玉米的基因表达与变异、同源、序列、注释、转录因子、共线、组装、样本、内参基因都要';

  it('命中源装不下时：明说省略几个，免责行与查询时刻仍完整，整包 ≤4 KB', async () => {
    const tool = createRegistry().getTool('hub_find_sources')!;
    const out = await tool.run({ question: LONG_QUESTION }, { http: forbiddenHttp });
    const text = out.text;

    // 命中多于正文容量：必须显式说明省略了几个（不许静默丢源）
    expect(text).toMatch(/另有 \d+ 个命中源未展示/);
    expect(out.raw.candidates.length).toBeGreaterThan(0);
    // 出处契约
    expect(text).toContain('未探测上游；工具是否可用以上游实际响应为准。');
    expect(text).toMatch(/查询时刻/);
    expect(text.trimEnd().endsWith(`查询时刻 ${text.match(/查询时刻 ([^\n]+)/)![1]}`)).toBe(true);
    // 免责行不能重复出现（拼装时只由 finish 追加一次）
    expect(text.split('未探测上游；工具是否可用').length - 1).toBe(1);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(4096);
  });

  it('不省略的短问题同样带免责行与尾注（回归旧行为）', async () => {
    const tool = createRegistry().getTool('hub_find_sources')!;
    const text = (await tool.run({ question: '小麦春化已知基因' }, { http: forbiddenHttp })).text;
    expect(text).not.toMatch(/另有 \d+ 个命中源未展示/);
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

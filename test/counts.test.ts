import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkBudgetConstants,
  checkInlineNumbers,
  checkPublishedScope,
  checkReadmeBlock,
  checkReadmeTable,
  checkSourceIcons,
  checkSourceScope,
  extractTarEntries,
  inspectRulesAnchor,
  renderDescriptionClause,
  renderReadmeBlock,
  rewriteInlineNumbers,
  verifyIntegrity,
} from '../scripts/counts.mjs';

/**
 * 数量生成与校验的测试。
 *
 * 重点不是「正常情况能过」，而是**故意写错时真的会红**：下面每个否定用例都能让
 * `checkSourceScope` / `checkPublishedScope` 返回问题，`--check` 正是据此非零退出。
 * 不读 `dist/`、不联网，所以能在 `npm run build` 之前跑。
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const counts = {
  schemaVersion: 1,
  scope: 'source',
  sources: 2,
  sourceTools: 4,
  metaTools: 1,
  metaToolNames: ['hub_status'],
  tools: 5,
  perSource: [
    { id: 'alpha', displayName: 'Alpha 平台', tier: 'T1', tools: 3 },
    { id: 'beta', displayName: 'Beta 数据库', tier: 'T2', tools: 1 },
  ],
  // 默认推荐集是清单口径：内联数量规则要把清单写进 README 并逐项核
  defaultSetSources: ['alpha'],
  defaultSetTools: 4,
  buildInfo: null,
};

const head = (block: string) => `# 标题\n\n## 现在支持什么\n\n| 源 | 等级 | 覆盖 | 工具数 | 鉴权 |\n|---|---|---|---|---|\n${block}\n`;

const table = (alpha = 3, beta = 1, alphaTier = 'T1') =>
  `| **Alpha 平台**（某大学） | ${alphaTier} | 覆盖说明 | ${alpha} | 无 |\n`
  + `| **Beta 数据库** | T2 | 覆盖说明 | ${beta} | 无 |\n`;

const readme = (block = renderReadmeBlock(counts), rows = table()) => `${block}\n${head(rows)}`;

/** README 里另外两处内联数量（`/healthz` 示例与「默认加载清单」句）的规范行。 */
const DEFAULT_LINE = '默认加载清单 1 个源、4 个工具（alpha）；清单外的源用 `x-plantomics-sources` 或 `PLANTOMICS_SOURCES` 自取（订阅集上限 80 个）';
const inlineLines = (healthz = '"sources":2,"tools":5,"metaTools":1', budget = DEFAULT_LINE) =>
  `- \`GET /healthz\` 返回 \`{${healthz}}\`\n- ${budget}\n`;

describe('README 内联数量（/healthz 示例与「默认加载清单」句）', () => {
  it('与 dist 一致时无问题', () => {
    expect(checkInlineNumbers(inlineLines(), counts)).toEqual([]);
  });

  it('/healthz 示例写旧数字时点名（这正是「手写必过期」的实证）', () => {
    const problems = checkInlineNumbers(inlineLines('"sources":6,"tools":25'), counts);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('/healthz');
    expect(problems[0]).toContain('"sources":2,"tools":5,"metaTools":1');
  });

  it('预算句写旧数字时点名', () => {
    const problems = checkInlineNumbers(inlineLines(undefined, '默认加载清单 1 个源、34 个工具（alpha）；清单外的源用 \`x-plantomics-sources\` 或 \`PLANTOMICS_SOURCES\` 自取（订阅集上限 80 个）'), counts);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('默认加载清单');
  });

  it('句子被改写到认不出时也判红（改措辞必须同步生成器）', () => {
    const problems = checkInlineNumbers('- 这段没有任何可核的数量\n', counts);
    expect(problems.length).toBe(2);
    expect(problems.every((problem) => problem.includes('找不到'))).toBe(true);
  });

  it('--write 会把旧数字改成规范值，改完即通过', () => {
    // 旧措辞也要能被 --write 归一：这是 README 从「默认全部加载」迁到「默认加载清单」的关键一步。
    // 断言写成"写完能过检查器"，而不是把整句话再抄一遍到测试里——
    // 抄一遍等于两份真相，措辞一改测试就得跟着抄，抄错还会假绿。
    const stale = inlineLines('"sources":6,"tools":25', '当前源码的 34 个工具默认全部加载（订阅集上限 80 个）');
    const rewritten = rewriteInlineNumbers(stale, counts);
    expect(rewritten).not.toContain('默认全部加载');
    expect(checkInlineNumbers(rewritten, counts)).toEqual([]);
  });

  it('旧口径措辞（「仍全量常驻（规则允许到 N 个）」）能被 --write 迁移到新口径', () => {
    const legacy = inlineLines(undefined, '当前源码的 5 个工具仍全量常驻（规则允许到 40 个）');
    const migrated = rewriteInlineNumbers(legacy, counts);
    expect(migrated).not.toContain('仍全量常驻');
    expect(checkInlineNumbers(migrated, counts)).toEqual([]);
  });
});

describe('README 标记块：由生成器写，手改即红', () => {
  it('与当前生成结果一致时无问题', () => {
    expect(checkReadmeBlock(readme(), counts)).toEqual([]);
  });

  it('数字被改成别的值时点名不一致', () => {
    const tampered = readme(renderReadmeBlock(counts).replace('2 源、5 工具', '2 源、9 工具'));
    const problems = checkReadmeBlock(tampered, counts);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('counts 标记块');
  });

  it('缺标记块直接判红（没有地方生成就一定会手写过期）', () => {
    const problems = checkReadmeBlock('# 标题\n\n> 手写的数字\n', counts);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('标记块');
  });
});

describe('README 逐源表格：等级与工具数必须与注册表一致', () => {
  it('一致时无问题', () => {
    expect(checkReadmeTable(readme(), counts)).toEqual([]);
  });

  it('工具数写错、等级写错、漏源、多源都点名', () => {
    expect(checkReadmeTable(readme(undefined, table(9, 1)), counts)[0]).toContain('工具数写 9');
    expect(checkReadmeTable(readme(undefined, table(3, 1, 'T2')), counts)[0]).toContain('等级写 T2');
    const missing = readme(undefined, '| **Gamma**（某大学） | T1 | 覆盖说明 | 3 | 无 |\n');
    expect(checkReadmeTable(missing, counts).some((problem) => problem.includes('缺少源'))).toBe(true);
    const extra = readme(undefined, `${table()}| **Gamma** | T1 | 覆盖说明 | 1 | 无 |\n`);
    expect(checkReadmeTable(extra, counts).some((problem) => problem.includes('Gamma'))).toBe(true);
  });
});

describe('离线总校验（--check 的实现）', () => {
  it('三处预算常量（counts / 运行时 budget / 客户端 catalog）一致', () => {
    // 真实 README 的标记块由 `npm run counts -- --write` 维护，需要 dist；
    // 这里只核不需要 dist 的那一半，README 一致性由 `npm run check:counts` 在整合时核。
    expect(checkBudgetConstants()).toEqual([]);
  });

  it('AGENTS.md 三态：在就真核 80，不在就明确「未核对」——两态都不许静默', () => {
    // 背景（后端负责人 2026-11-03）：AGENTS.md 被 .gitignore 忽略，任何外部 clone（含公开仓）
    // 都没有它。把它当"必须项"→ 公开树 npm test 必红；把它静默放过 → 规则被改也没人发现。
    // 所以断言的不是"有没有文件"，而是**函数有没有如实报告自己是哪种状态**。
    const state = inspectRulesAnchor();
    const agentsHere = existsSync(new URL('../AGENTS.md', import.meta.url));

    if (agentsHere) {
      // 文件在：必须真核对，不许偷懒报「未核对」
      expect(state.status, '本检出有 AGENTS.md，就必须真的核对').toBe('checked');
      expect(state.problems, '本检出的 AGENTS.md 当前口径行应写 ≤ 80').toEqual([]);
    } else {
      // 文件不在：必须是这个状态值，而不是"报错"或"假装查过"
      expect(state.status, '没有 AGENTS.md 时必须返回 rules-file-absent，不许报错也不许报 checked')
        .toBe('rules-file-absent');
      expect(state.problems).toEqual([]);
    }

    // 双向负控（变异自测）：真造临时根，证明每条分支各自承重。
    const dir = mkdtempSync(path.join(tmpdir(), 'po-rules-'));
    const write = (body: string): void => writeFileSync(path.join(dir, 'AGENTS.md'), body, 'utf8');
    const HARD = (n: string): string => `| **单次订阅集工具数** | **≤ ${n}（唯一硬阈值）** | 上下文成本 |\n`;
    const SOFT = (n: string): string => `| 默认推荐集 | **≤ ${n}（软建议）** | 保证 32K 级上下文 |\n`;
    /** 造一份结构完整的规则文档：当前口径在 10.1，另有一节 10.4 历史沿革。 */
    const DOC = (hard: string, soft: string, opts: { history?: string; comment?: string } = {}): string => [
      '# 十、入口与工具数量预算',
      '',
      '## 10.1 口径',
      '',
      opts.comment ?? '',
      HARD(hard),
      SOFT(soft),
      '',
      '## 10.2 硬阈值只有一个：订阅集',
      '',
      '正文说明。',
      '',
      '## 10.4 沿革（旧口径，已废止）',
      '',
      opts.history ?? '',
      '',
      '# 十一、可复现与数字口径',
      '',
    ].join('\n');
    try {
      // ① 当前口径写 999 → 必须红，且点名数字
      write(DOC('999', '40'));
      expect(inspectRulesAnchor(dir).status).toBe('checked');
      expect(inspectRulesAnchor(dir).problems.length, '当前口径写 ≤ 999 必须红').toBe(1);
      expect(inspectRulesAnchor(dir).problems[0]).toContain('999');

      // ② R12-B1：80.5 不许被截成 80（取前缀就是假核对）
      write(DOC('80.5', '40'));
      const decimal = inspectRulesAnchor(dir);
      expect(decimal.problems.length, '≤ 80.5 必须红').toBe(1);
      expect(decimal.problems[0]).toContain('80.5');
      // 断言「因为格式不合规而拒绝」，不是「解析成 80 之后碰巧不相等」——
      // 否则把正则退回取前缀，也一样能让这条看起来红过（实际是 80 与 80 相等被别的条件拦下）。
      expect(decimal.problems[0], '80.5 必须在解析阶段就被判不合格').toContain('不是「≤ 整数（说明）」');

      // ③ R12-B1：历史沿革里放一条同形「≤ 80」表格，当前口径是 999 → 不许被掩盖
      write(DOC('999', '40', { history: HARD('80') }));
      const masked = inspectRulesAnchor(dir);
      expect(masked.problems.length, '历史表格不许掩盖当前口径').toBe(1);
      expect(masked.problems[0]).toContain('999');

      // ④ R12-B1：用 HTML 注释包住旧 80 表格，当前口径 999 → 注释里的不算
      write(DOC('999', '40', { comment: `<!--\n${HARD('80')}-->` }));
      expect(inspectRulesAnchor(dir).problems.length, 'HTML 注释里的旧表格不许算作当前口径').toBe(1);

      // ⑤ 同一小节里重复两行 → 红（哪条算数没有答案，猜一条就是放水）
      write(DOC('888', '40').replace(SOFT('40'), SOFT('40') + HARD('80')));
      expect(inspectRulesAnchor(dir).problems.length, '重复行必须红').toBe(1);
      expect(inspectRulesAnchor(dir).problems[0]).toContain('2 次');

      // ⑥ 默认推荐集（软建议）也要核（R12-B1 残留）：40 → 400 必须红
      write(DOC('80', '400'));
      const soft = inspectRulesAnchor(dir);
      expect(soft.problems.length, '默认集软建议写 400 必须红').toBe(1);
      expect(soft.problems[0]).toContain('400');

      // ⑥-1 R12 二轮：第十节里出现两个 10.1（第一个 80、第二个 999）→ 必须红，不许取第一个
      write([
        '# 十、入口与工具数量预算',
        '## 10.1 口径',
        HARD('80'),
        SOFT('40'),
        '## 10.1 口径',
        HARD('999'),
        SOFT('40'),
        '## 10.2 硬阈值',
        '说明',
        '# 十一、可复现与数字口径',
        '',
      ].join('\n'));
      const dup = inspectRulesAnchor(dir);
      expect(dup.problems.length, '重复 10.1 必须红').toBe(1);
      expect(dup.problems[0]).toContain('10.1');

      // ⑥-2 R12 二轮：围栏代码块里贴一整套"完整假规则"（80），正文其实 999 →
      //      围栏必须整块无视，否则定位会跑进示例里
      write([
        '# 十、入口与工具数量预算',
        '```md',
        '# 十、入口与工具数量预算',
        '## 10.1 口径',
        HARD('80'),
        SOFT('40'),
        '# 十一、可复现与数字口径',
        '```',
        '## 10.1 口径',
        HARD('999'),
        SOFT('40'),
        '## 10.2 硬阈值',
        '# 十一、可复现与数字口径',
        '',
      ].join('\n'));
      const fenced = inspectRulesAnchor(dir);
      expect(fenced.problems.length, '代码块里的示例不许冒充现行规则').toBe(1);
      expect(fenced.problems[0]).toContain('999');

      // ⑥-2b R12 三轮：同一个反例改用波浪号围栏（~~~）包起来 → 必须同样被剥掉
      write([
        '# 十、入口与工具数量预算',
        '~~~md',
        '# 十、入口与工具数量预算',
        '## 10.1 口径',
        HARD('80'),
        SOFT('40'),
        '# 十一、可复现与数字口径',
        '~~~',
        '## 10.1 口径',
        HARD('999'),
        SOFT('40'),
        '## 10.2 硬阈值',
        '# 十一、可复现与数字口径',
        '',
      ].join('\n'));
      const tilde = inspectRulesAnchor(dir);
      expect(tilde.problems.length, '波浪号围栏里的示例不许冒充现行规则').toBe(1);
      expect(tilde.problems[0]).toContain('999');

      // ⑥-2c 缩进 4 格的代码块里的表格同样不算（只认行首就是 | 的表格行）
      write([
        '# 十、入口与工具数量预算',
        '## 10.1 口径',
        '',
        `    ${HARD('80').trim()}`,
        `    ${SOFT('40').trim()}`,
        '',
        HARD('999'),
        SOFT('40'),
        '## 10.2 硬阈值',
        '# 十一、可复现与数字口径',
        '',
      ].join('\n'));
      const indented = inspectRulesAnchor(dir);
      expect(indented.problems.length, '缩进代码块里的旧行不许冒充现行口径，且必须因找不到/对不上而红').toBe(1);
      expect(indented.problems[0]).toContain('999');

      // ⑥-3 R12 二轮：说明列先写一个 ≤ 80，真正的值列写 ≤ 999 → 必须按值列判，不许取整行第一个 ≤
      write([
        '# 十、入口与工具数量预算',
        '## 10.1 口径',
        '| **单次订阅集工具数** | 说明 ≤ 80（唯一硬阈值） | ≤ 999（唯一硬阈值） |',
        SOFT('40'),
        '## 10.2 硬阈值',
        '# 十一、可复现与数字口径',
        '',
      ].join('\n'));
      const cells = inspectRulesAnchor(dir);
      expect(cells.problems.length, '阈值出现在值列以外必须红').toBe(1);
      expect(cells.problems[0]).toContain('单元格');

      // ⑦ 找不到 10.1 小节（结构变了）→ 红，不许"没找到就算过"
      write('# 十、入口\n\n正文没有小节。\n');
      expect(inspectRulesAnchor(dir).problems.length, '找不到 10.1 必须红').toBe(1);

      // ⑧ 正常：80 / 40 → 绿，且两档都被取出来
      write(DOC('80', '40'));
      expect(inspectRulesAnchor(dir)).toMatchObject({ status: 'checked', problems: [], threshold: 80, soft: 40 });

      // ⑨ 读失败 ≠ 文件不存在（R12-C1）：把 AGENTS.md 变成目录，必须报故障（checked + problem），
      //    不许伪装成「未核对」——否则权限/路径故障会被当成合理状态静默通过。
      rmSync(path.join(dir, 'AGENTS.md'));
      mkdirSync(path.join(dir, 'AGENTS.md'));
      const broken = inspectRulesAnchor(dir);
      expect(broken.status, '读失败不许报 rules-file-absent').toBe('checked');
      expect(broken.problems.length, '读失败必须报问题').toBe(1);
      rmSync(path.join(dir, 'AGENTS.md'), { recursive: true, force: true });

      // ⑩ 真不存在 → 未核对
      expect(inspectRulesAnchor(dir).status, '删掉文件必须回到未核对态').toBe('rules-file-absent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('合成 README 出问题时 checkSourceScope 非空（即 CLI 会非零退出）', () => {
    const problems = checkSourceScope({ counts, readme: readme(undefined, table(9, 1)) });
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('源图标唯一来源（checkSourceIcons）', () => {
  const sourceCounts = {
    perSource: [
      { id: 'alpha', displayName: 'Alpha', tier: 'T1', tools: 1 },
      { id: 'beta', displayName: 'Beta', tier: 'T2', tools: 1 },
    ],
  };
  const icons = {
    schemaVersion: 1,
    sources: {
      alpha: { color: '#c2402f', svg: '<path d="M1 1"/>' },
      beta: { color: '#3a6ea8', svg: '<circle cx="1" cy="1" r="1"/>' },
    },
  };

  function tree(iconJson: unknown, distText?: string): string {
    const root = mkdtempSync(path.join(tmpdir(), 'icons-'));
    tmpDirs.push(root);
    mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'core', 'source-icons.json'), JSON.stringify(iconJson, null, 2));
    if (distText !== undefined) {
      mkdirSync(path.join(root, 'dist', 'core'), { recursive: true });
      writeFileSync(path.join(root, 'dist', 'core', 'source-icons.json'), distText);
    }
    return root;
  }

  it('齐备且 dist 是副本 → 无问题', () => {
    const root = tree(icons, JSON.stringify(icons, null, 2));
    expect(checkSourceIcons({ counts: sourceCounts, root })).toEqual([]);
  });

  it('缺图标 → 点名源 id（占位只是兜底，不算通过）', () => {
    const partial = { schemaVersion: 1, sources: { alpha: icons.sources.alpha } };
    const root = tree(partial, JSON.stringify(partial, null, 2));
    expect(checkSourceIcons({ counts: sourceCounts, root }).join('\n')).toMatch(/beta.*没有图标/);
  });

  it('主色不是 #rrggbb、svg 为空 → 点名', () => {
    const bad = { schemaVersion: 1, sources: { alpha: { color: 'red', svg: '' }, beta: icons.sources.beta } };
    const root = tree(bad, JSON.stringify(bad, null, 2));
    const problems = checkSourceIcons({ counts: sourceCounts, root }).join('\n');
    expect(problems).toMatch(/主色不是 #rrggbb/);
    expect(problems).toMatch(/svg 为空/);
  });

  it('dist 不是副本 / 缺失 / 多出已删源的图标 → 都点名', () => {
    expect(checkSourceIcons({ counts: sourceCounts, root: tree(icons, '{}') }).join('\n')).toMatch(/与 src 不一致/);
    expect(checkSourceIcons({ counts: sourceCounts, root: tree(icons) }).join('\n')).toMatch(/缺失/);
    const extra = { schemaVersion: 1, sources: { ...icons.sources, ghost: { color: '#000000', svg: '<g/>' } } };
    expect(checkSourceIcons({ counts: sourceCounts, root: tree(extra, JSON.stringify(extra, null, 2)) }).join('\n'))
      .toMatch(/ghost.*不是注册表中的源/);
  });
});

describe('发布口径：市场描述必须等于 tarball 真实数量', () => {
  const entry = (version: string, type = 'npm') => ({ version, source: { type } });
  const market = (zh: string, en: string, versions: unknown[] = []) => ({
    plugins: [{ name: 'plantomics-hub', description: { zh, en }, versions }],
  });
  const clause = renderDescriptionClause(counts);
  const matching = market(`含 ${clause.zh}，覆盖若干物种。`, `${clause.en}, plus more.`);

  it('短语一致时无问题', () => {
    expect(checkPublishedScope({ counts, market: matching })).toEqual([]);
  });

  it('描述写错数量时中英各报一条', () => {
    const problems = checkPublishedScope({
      counts,
      market: market('2 个植物组学数据库、9 个 MCP 工具', '2 plant-omics databases behind 9 MCP tools'),
    });
    expect(problems.length).toBe(2);
    expect(problems[0]).toContain(renderDescriptionClause(counts).zh);
    expect(problems[1]).toContain('plant-omics databases behind');
  });

  it('市场第一条就是 npm latest → 版本闸通过', () => {
    expect(checkPublishedScope({
      counts,
      market: market(`含 ${clause.zh}。`, `${clause.en}.`, [entry('0.1.1'), entry('0.1.0')]),
      latest: '0.1.1',
    })).toEqual([]);
  });

  it('npm latest 没登记 → 版本闸点名（负例：市场落后）', () => {
    const problems = checkPublishedScope({
      counts,
      market: market(`含 ${clause.zh}。`, `${clause.en}.`, [entry('0.1.0')]),
      latest: '0.1.1',
    });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('没有登记 npm latest 0.1.1');
  });

  it('市场第一条领先 npm latest → 版本闸点名（负例：版本不一致）', () => {
    const problems = checkPublishedScope({
      counts,
      market: market(`含 ${clause.zh}。`, `${clause.en}.`, [entry('0.1.2'), entry('0.1.1')]),
      latest: '0.1.1',
    });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('市场会装到与 npm latest 不一致的版本');
  });

  it('source.type 不是 npm → 点名', () => {
    const problems = checkPublishedScope({
      counts,
      market: market(`含 ${clause.zh}。`, `${clause.en}.`, [entry('0.1.1', 'git')]),
      latest: '0.1.1',
    });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('source.type 不是 npm');
  });
});

/** 手搓一个最小 tar，只为验证解析器能取到文件；不做 checksum 校验。 */
function tarEntry(name: string, content: string): Buffer {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write('0', 156, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

describe('发布包解包与完整性', () => {
  const archive = Buffer.concat([
    tarEntry('package/package.json', '{"name":"plantomics-hub"}'),
    tarEntry('package/dist/sources/index.js', 'export const createRegistry = () => ({});'),
    Buffer.alloc(1024),
  ]);

  it('能取出普通文件与内容', () => {
    const entries = extractTarEntries(gzipSync(archive));
    expect(entries.map((entry) => entry.name)).toEqual([
      'package/package.json',
      'package/dist/sources/index.js',
    ]);
    expect(entries[1]?.body.toString('utf8')).toContain('createRegistry');
  });

  it('完整性对得上通过、被改动则抛错（防「装的是别的包」）', () => {
    const gz = gzipSync(archive);
    const digest = `sha512-${createHash('sha512').update(gz).digest('base64')}`;
    expect(verifyIntegrity(gz, digest)).toBe(digest);
    const tampered = Buffer.from(gz);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => verifyIntegrity(tampered, digest)).toThrow(/完整性校验失败/);
    expect(() => verifyIntegrity(gz, undefined)).toThrow(/integrity/);
  });
});

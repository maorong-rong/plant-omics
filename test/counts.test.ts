import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  buildInfo: null,
};

const head = (block: string) => `# 标题\n\n## 现在支持什么\n\n| 源 | 等级 | 覆盖 | 工具数 | 鉴权 |\n|---|---|---|---|---|\n${block}\n`;

const table = (alpha = 3, beta = 1, alphaTier = 'T1') =>
  `| **Alpha**（某大学） | ${alphaTier} | 覆盖说明 | ${alpha} | 无 |\n`
  + `| **Beta** | T2 | 覆盖说明 | ${beta} | 无 |\n`;

const readme = (block = renderReadmeBlock(counts), rows = table()) => `${block}\n${head(rows)}`;

/** README 里另外两处内联数量（`/healthz` 示例与「全量常驻」句）的规范行。 */
const inlineLines = (healthz = '"sources":2,"tools":5,"metaTools":1', budget = '当前源码的 5 个工具仍全量常驻（规则允许到 40 个）') =>
  `- \`GET /healthz\` 返回 \`{${healthz}}\`\n- ${budget}\n`;

describe('README 内联数量（/healthz 示例与「全量常驻」句）', () => {
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
    const problems = checkInlineNumbers(inlineLines(undefined, '当前源码的 34 个工具仍全量常驻（规则允许到 40 个）'), counts);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('全量常驻');
  });

  it('句子被改写到认不出时也判红（改措辞必须同步生成器）', () => {
    const problems = checkInlineNumbers('- 这段没有任何可核的数量\n', counts);
    expect(problems.length).toBe(2);
    expect(problems.every((problem) => problem.includes('找不到'))).toBe(true);
  });

  it('--write 会把旧数字改成规范值，改完即通过', () => {
    const stale = inlineLines('"sources":6,"tools":25', '当前源码的 34 个工具仍全量常驻（规则允许到 40 个）');
    expect(rewriteInlineNumbers(stale, counts)).toBe(inlineLines());
    expect(checkInlineNumbers(rewriteInlineNumbers(stale, counts), counts)).toEqual([]);
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
    const missing = readme(undefined, '| **Alpha**（某大学） | T1 | 覆盖说明 | 3 | 无 |\n');
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
  const market = (zh: string, en: string) => ({
    plugins: [{ name: 'plantomics-hub', description: { zh, en } }],
  });

  it('短语一致时无问题', () => {
    const clause = renderDescriptionClause(counts);
    expect(checkPublishedScope({ counts, market: market(`含 ${clause.zh}，覆盖若干物种。`, `${clause.en}, plus more.`) }))
      .toEqual([]);
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

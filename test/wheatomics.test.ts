import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { utf8Bytes } from '../src/core/format.js';
import type { Fetcher, ToolContext } from '../src/core/types.js';
import { tools } from '../src/sources/wheatomics/tools.js';

/**
 * 离线回放测试。
 *
 * 刻意**不联网**：联网测试会因为上游改版、机房抖动、代理没开而红，
 * 红了三次之后人就开始 `--skip`，最后等于没有测试。
 * 「上游还活着吗」由 `npm run probe` 单独回答，两者职责分开。
 */
const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'sources',
  'wheatomics',
  'fixtures',
);

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

function contextFor(fixture: string): { ctx: ToolContext; urls: string[] } {
  const urls: string[] = [];
  const body = readFixture(fixture);
  const http = (async (url: string) => {
    urls.push(url);
    return { data: body, url, status: 200, durationMs: 12, attempts: 1 };
  }) as Fetcher;
  return { ctx: { http }, urls };
}

function contextWith(payload: unknown): { ctx: ToolContext; urls: string[] } {
  const urls: string[] = [];
  const http = (async (url: string) => {
    urls.push(url);
    return { data: payload, url, status: 200, durationMs: 7, attempts: 1 };
  }) as Fetcher;
  return { ctx: { http }, urls };
}

function tool(nam: string) {
  const found = tools.find((candidate) => candidate.name === nam);
  if (!found) throw new Error(`注册表里没有 ${nam}`);
  return found;
}

/** 数 markdown 表格里的数据行（跳过表头与分隔行）。 */
function dataRows(text: string): number {
  const tableLines = text.split('\n').filter((line) => line.trim().startsWith('|'));
  return Math.max(0, tableLines.length - 2);
}

describe('wheatomics 工具', () => {
  it('每个工具名都以源 id 为前缀，且参数是 object schema', () => {
    expect(tools).toHaveLength(6);
    for (const def of tools) {
      expect(def.name.startsWith('wheatomics_')).toBe(true);
      expect(def.parameters.type).toBe('object');
      expect(def.parameters.additionalProperties).toBe(false);
      expect(def.description.length).toBeGreaterThan(10);
    }
  });

  it('search_known_genes：命中条目，出处带完整查询与时刻（审查 R06）', async () => {
    const { ctx, urls } = contextFor('known-search.json');
    const result = await tool('wheatomics_search_known_genes').run({ searchid: 'VRN1' }, ctx);

    expect(urls[0]).toContain('/genes/known/search');
    expect(urls[0]).toContain('searchid=VRN1');
    expect(result.text).toContain('源：WheatOmics');
    // 出处必须能复现这次查询：带参数、带时刻
    expect(result.text).toContain('searchid=VRN1');
    expect(result.text).toMatch(/HTTP 200/);
    expect(result.meta.request).toContain('searchid=VRN1');
    expect(result.meta.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('search_known_genes：limit 真的决定渲染行数（原断言是永真的）', async () => {
    const fixture = readFixture('known-search.json') as { data: { records: unknown[] } };
    const total = fixture.data.records.length;

    const { ctx: ctx2 } = contextFor('known-search.json');
    const two = await tool('wheatomics_search_known_genes').run({ searchid: 'VRN1', limit: 2 }, ctx2);
    expect(dataRows(two.text)).toBe(2);

    const { ctx: ctxAll } = contextFor('known-search.json');
    const all = await tool('wheatomics_search_known_genes').run({ searchid: 'VRN1', limit: 50 }, ctxAll);
    expect(dataRows(all.text)).toBe(total);
  });

  it('gene_detail：路径参数被正确编码，且不猜分子量单位', async () => {
    const { ctx, urls } = contextFor('gene-detail.json');
    const result = await tool('wheatomics_gene_detail').run({ gene_id: 'TraesCS5A02G391700' }, ctx);

    expect(urls[0]).toContain('/genes/detail/TraesCS5A02G391700');
    expect(result.text).toContain('TraesCS5A02G391700');
    expect(result.text).toContain('单位未标注');
  });

  it('expression_projects：600 KB 级响应被压成 group 汇总，且按字节不超预算', async () => {
    const { ctx } = contextFor('expression-projects.json');
    const result = await tool('wheatomics_expression_projects').run({}, ctx);

    expect(result.text).toContain('按 group 汇总');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });

  it('expression_projects：keyword 能筛出具体项目 id', async () => {
    const { ctx } = contextFor('expression-projects.json');
    const result = await tool('wheatomics_expression_projects').run({ keyword: 'ABA' }, ctx);
    expect(result.text).toContain('按关键词「ABA」匹配');
  });

  it('expression_query：条件不多时**全部展示**，籽粒条件不许被裁掉（审查 R02）', async () => {
    const { ctx, urls } = contextFor('expression-query.json');
    const result = await tool('wheatomics_expression_query').run(
      { gene_ids: 'TraesCS5A02G391700', project: 'PRJEB5314_paired_tbl' },
      ctx,
    );

    expect(urls[0]).toContain('gene_ids=TraesCS5A02G391700');
    expect(urls[0]).toContain('project=PRJEB5314_paired_tbl');
    // 真实 fixture 里 grain_Z71 / Z75 / Z85 排在最后，原实现 slice(0,12) 把它们全裁了
    expect(result.text).toContain('grain_Z71');
    expect(result.text).toContain('grain_Z75');
    expect(result.text).toContain('grain_Z85');
    expect(result.text).toContain('共 15 个条件');
  });

  it('expression_query：标准差必须出现在输出里（描述承诺过）', async () => {
    const { ctx } = contextFor('expression-query.json');
    const result = await tool('wheatomics_expression_query').run(
      { gene_ids: 'TraesCS5A02G391700' },
      ctx,
    );
    // fixture 里 stem_Z65 = 53.2364 ± 0.342734
    expect(result.text).toContain('stem_Z65=53.236±0.343');
  });

  it('expression_query：condition 只看籽粒条件', async () => {
    const { ctx } = contextFor('expression-query.json');
    const result = await tool('wheatomics_expression_query').run(
      { gene_ids: 'TraesCS5A02G391700', condition: 'grain' },
      ctx,
    );
    expect(result.text).toContain('含「grain」的 3 个条件');
    expect(result.text).not.toContain('stem_Z65');
  });

  it('expression_query：缺值不许渲染成 0（审查 P1：编造数据）', async () => {
    const payload = {
      success: true,
      data: {
        project: 'demo',
        genes_found: 1,
        results: [
          {
            gene_id: 'G1',
            points: [
              { label: 'a', value: null, std: null },
              { label: 'b', value: 5, std: undefined },
            ],
          },
        ],
      },
    };
    const { ctx } = contextWith(payload);
    const result = await tool('wheatomics_expression_query').run({ gene_ids: 'G1' }, ctx);

    expect(result.text).toContain('a=-');
    expect(result.text).not.toContain('a=0');
    expect(result.text).toContain('b=5');
    expect(result.text).not.toContain('b=5±0');
  });

  it('expression_query：超长输出按 4 KB 字节上限截断并留出处', async () => {
    const longLabel = 'x'.repeat(40);
    const results = Array.from({ length: 50 }, (_, g) => ({
      gene_id: `G${g}`,
      points: Array.from({ length: 5 }, (_, p) => ({ label: `${longLabel}${p}`, value: p, std: 1 })),
    }));
    const { ctx } = contextWith({ success: true, data: { project: 'demo', genes_found: 50, results } });
    const result = await tool('wheatomics_expression_query').run({ gene_ids: 'G0' }, ctx);

    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
    expect(result.text).toContain('已按 4 KB 上限截断');
    expect(result.text).toContain('源：WheatOmics'); // 出处不许被截掉
  });

  it('search_papers：sinceDays 映射成上游的 since_days 参数', async () => {
    const { ctx, urls } = contextFor('papers.json');
    const result = await tool('wheatomics_search_papers').run({ q: 'vernalization', limit: 3, sinceDays: 30 }, ctx);

    expect(urls[0]).toContain('q=vernalization');
    expect(urls[0]).toContain('since_days=30');
    expect(result.text).toContain('| PMID |');
  });

  it('convert_gene_ids：多个 ID 用 CRLF 分隔送出', async () => {
    const { ctx, urls } = contextFor('id-conversion.json');
    const result = await tool('wheatomics_convert_gene_ids').run(
      { ids: 'TraesCS6B01G342500.1, TraesCS6B01G123400.1', gene_version: 'IWGSCv1_result' },
      ctx,
    );

    expect(urls[0]).toContain('gene_version=IWGSCv1_result');
    expect(urls[0]).toContain('%0D%0A');
    expect(result.text).toContain('TraesCS6B02G342500');
  });

  it('convert_gene_ids：非法 gene_version 直接拒绝，不发请求', async () => {
    const { ctx, urls } = contextFor('id-conversion.json');
    await expect(
      tool('wheatomics_convert_gene_ids').run({ ids: 'X.1', gene_version: 'v9' }, ctx),
    ).rejects.toThrow(/gene_version/);
    expect(urls).toHaveLength(0);
  });

  it('convert_gene_ids：单次 ID 数超上限时本地拒掉，不发请求', async () => {
    const { ctx, urls } = contextFor('id-conversion.json');
    const tooMany = Array.from({ length: 201 }, (_, i) => `T${i}.1`).join(',');
    await expect(
      tool('wheatomics_convert_gene_ids').run({ ids: tooMany, gene_version: 'IWGSCv1_result' }, ctx),
    ).rejects.toThrow(/最多 200 个/);
    expect(urls).toHaveLength(0);
  });

  it('上游 success=false 时抛错而不是返回空表', async () => {
    const { ctx } = contextWith({ success: false, message: '表不存在', data: null });
    await expect(tool('wheatomics_expression_projects').run({}, ctx)).rejects.toThrow(/success=false/);
  });

  it('上游换字段名时明确报契约错误，而不是说「没有匹配」（审查 R03 / A3）', async () => {
    const { ctx } = contextWith({ success: true, data: { items: [{ gene_id: 'REAL_MATCH' }] } });
    await expect(
      tool('wheatomics_search_known_genes').run({ searchid: 'VRN1' }, ctx),
    ).rejects.toThrow(/records/);
  });

  it('上游明确返回 0 条时，文案要说清「是 0 条，不是解析失败」', async () => {
    const { ctx } = contextWith({ success: true, data: { query: 'X', total: 0, records: [] } });
    const result = await tool('wheatomics_search_known_genes').run({ searchid: 'X' }, ctx);
    expect(result.text).toContain('上游明确返回 0 条');
  });
});

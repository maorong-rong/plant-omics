import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { utf8Bytes } from '../src/core/format.js';
import { UpstreamError } from '../src/core/errors.js';
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
    expect(tools).toHaveLength(11);
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

// ── 2026-10-29 新增三工具（契约见 记录/20261029-WheatOmics三工具契约.md） ─────
//
// 注意：这三个工具的 fixture 是**结构回放件**（capture.simulated = true），
// 落地时上游 /api/* 返回 503 + Apache 维护页，无法保存原始响应体。
// 所以本节证明的是「我们的解析与排版自洽」，**不是**上游契约已被快照钉住。

interface ReplayFixture {
  capture: { url: string; simulated?: boolean; originalBytes?: number };
  payload: unknown;
}

/** 读取带 capture 包装的回放件，只回放 payload 部分。 */
function replayFixture(name: string): ReplayFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as ReplayFixture;
}

function replay(
  name: string,
  options: { mutate?: (payload: Record<string, unknown>) => void } = {},
): { ctx: ToolContext; urls: string[]; data: ReplayFixture } {
  const data = replayFixture(name);
  const payload = JSON.parse(JSON.stringify(data.payload)) as Record<string, unknown>;
  if (options.mutate) options.mutate(payload);
  const urls: string[] = [];
  const http = (async (url: string) => {
    urls.push(url);
    return { data: payload, url, status: 200, durationMs: 11, attempts: 1 };
  }) as Fetcher;
  return { ctx: { http }, urls, data };
}

/** 回放一个**非 200**状态，用于验证 HTTP 错误不被折成业务空结果。 */
function replayStatus(name: string, status: number): { ctx: ToolContext; urls: string[] } {
  const data = replayFixture(name);
  const urls: string[] = [];
  const http = (async (url: string) => {
    urls.push(url);
    throw new UpstreamError(`上游HTTP ${status}`, { url, status, attempts: 1 });
  }) as Fetcher;
  return { ctx: { http }, urls };
}

describe('wheatomics_cross_species_homologs', () => {
  it('正例：1 次请求、按物种分组、max_targets 写清是每物种上限', async () => {
    const { ctx, urls } = replay('homologs.json');
    const result = await tool('wheatomics_cross_species_homologs').run(
      { gene_id: 'TraesCS5A02G391700', max_targets: 3 },
      ctx,
    );

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/homologs/wheat-rice-arabidopsis');
    expect(urls[0]).toContain('gene_id=TraesCS5A02G391700');
    expect(urls[0]).toContain('max_targets=3');

    expect(result.text).toContain('命中 6 条同源基因');
    expect(result.text).toContain('Rice 3');
    expect(result.text).toContain('Arabidopsis 3');
    // 这条是本轮最容易写错的地方：max_targets 是每物种上限，不是总数
    expect(result.text).toContain('每物种');
    // 不区分直系/旁系，必须在正文里说清，否则用户会当成 ortholog 用
    expect(result.text).toContain('不区分直系/旁系同源');
    expect(result.text).toContain('水稻与拟南芥');
    expect(result.text).toContain('源：WheatOmics');
    expect(result.meta.request).toContain('max_targets=3');
  });

  it('查无：count=0 是合法空结果，写明只覆盖两物种，不断言基因不存在', async () => {
    const { ctx } = replay('homologs-empty.json');
    const result = await tool('wheatomics_cross_species_homologs').run({ gene_id: 'TraesCS9Z99G999999' }, ctx);

    expect(result.text).toContain('本次返回 0 条');
    expect(result.text).toContain('只覆盖水稻与拟南芥');
    expect(result.text).toContain('不代表该基因不存在');
    // 只能是"不代表不存在"，不能出现肯定式断言
    expect(result.text).not.toMatch(/(?<!不代表)该基因不存在/);
  });

  it('身份不符：返回的 query_gene 与请求不一致 → 抛错，不把无关记录当结果', async () => {
    const { ctx } = replay('homologs.json', {
      mutate: (payload) => {
        (payload.data as Record<string, unknown>).query_gene = 'TraesCS1A02G000100';
      },
    });
    await expect(
      tool('wheatomics_cross_species_homologs').run({ gene_id: 'TraesCS5A02G391700' }, ctx),
    ).rejects.toThrow(/身份不符/);
  });

  it('缺 query_gene → 结构漂移，不退化成空结果', async () => {
    const { ctx } = replay('homologs.json', {
      mutate: (payload) => {
        delete (payload.data as Record<string, unknown>).query_gene;
      },
    });
    await expect(
      tool('wheatomics_cross_species_homologs').run({ gene_id: 'TraesCS5A02G391700' }, ctx),
    ).rejects.toThrow(/query_gene/);
  });

  it('count 与 hits 条数矛盾 → 抛错，不挑一个当真值', async () => {
    const { ctx } = replay('homologs.json', {
      mutate: (payload) => {
        (payload.data as Record<string, unknown>).count = 99;
      },
    });
    await expect(
      tool('wheatomics_cross_species_homologs').run({ gene_id: 'TraesCS5A02G391700' }, ctx),
    ).rejects.toThrow(/自相矛盾/);
  });

  it('hits 缺失 → 结构漂移（不是「没有同源基因」）', async () => {
    const { ctx } = replay('homologs.json', {
      mutate: (payload) => {
        delete (payload.data as Record<string, unknown>).hits;
      },
    });
    await expect(
      tool('wheatomics_cross_species_homologs').run({ gene_id: 'TraesCS5A02G391700' }, ctx),
    ).rejects.toThrow(/hits/);
  });

  it('描述里不写「覆盖禾本科」这类未证实的覆盖范围', () => {
    const def = tool('wheatomics_cross_species_homologs');
    // 允许出现「不代表全部禾本科」这种**否定式**边界说明，禁止的是正向宣称
    expect(def.description).toContain('只有水稻与拟南芥');
    expect(def.description).toContain('不是全部物种');
    expect(def.description).not.toMatch(/覆盖禾本科|全部物种都|全物种覆盖/);
  });
});

describe('wheatomics_variant_datasets', () => {
  it('正例：3 个参考基因组、29 个数据集、concordant 计数可算', async () => {
    const { ctx, urls } = replay('variant-datasets.json');
    const result = await tool('wheatomics_variant_datasets').run({}, ctx);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/VariantHub/datasets');
    expect(result.text).toContain('3 个参考基因组');
    expect(result.text).toContain('29 个变异数据集');
    // 真实抓取：27 个 true、2 个 false（WEC_filtered_SNPs / WEC_filtered_INDELs），无字段缺失。
    // 我此前的合成件把比例写反了，这条断言按真实件钉住。
    expect(result.text).toContain('genome_concordant=true 的 27 个');
    expect(result.text).toContain('whealbi_minocc10');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });

  it('正文必须带「0 条不能解读为该区间没有变异」的警告，不能只写在描述里', async () => {
    const { ctx } = replay('variant-datasets.json');
    const result = await tool('wheatomics_variant_datasets').run({}, ctx);
    expect(result.text).toContain('0 条不能解读为该区间没有变异');
  });

  it('keyword 是本地过滤：不发给上游，且能筛出目标数据集', async () => {
    const { ctx, urls } = replay('variant-datasets.json');
    const result = await tool('wheatomics_variant_datasets').run({ keyword: 'whealbi' }, ctx);

    expect(urls[0]).not.toContain('keyword');
    expect(result.text).toContain('本地关键词「whealbi」命中 1 个');
    expect(result.text).toContain('该过滤不发给上游');
  });

  it('keyword 无命中时明说「本地过滤为空」，不报成上游没数据', async () => {
    const { ctx } = replay('variant-datasets.json');
    const result = await tool('wheatomics_variant_datasets').run({ keyword: 'ZZZ_NOT_A_DATASET' }, ctx);
    expect(result.text).toContain('本地过滤结果为空');
    expect(result.text).toContain('共 3 个参考基因组、29 个变异数据集');
  });

  it('references 缺失 → 结构漂移', async () => {
    const { ctx } = replay('variant-datasets.json', {
      mutate: (payload) => {
        delete (payload.data as Record<string, unknown>).references;
      },
    });
    await expect(tool('wheatomics_variant_datasets').run({}, ctx)).rejects.toThrow(/references/);
  });

  it('genome_concordant 字段缺失时显示「未知」，不默认成 true/false', async () => {
    const { ctx } = replay('variant-datasets.json');
    const result = await tool('wheatomics_variant_datasets').run({ keyword: 'WEC_filtered_SNPs' }, ctx);
    // 该条实测为 false，必须照实显示
    expect(result.text).toContain('false');
  });
});

describe('wheatomics_variant_query', () => {
  it('正例：total/total_shown/records 三者一致，正文不含 info_raw', async () => {
    const { ctx, urls } = replay('variant-query.json');
    const result = await tool('wheatomics_variant_query').run(
      { dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' },
      ctx,
    );

    expect(urls).toHaveLength(1);
    // region 是单个字符串参数，不是 chrom/start/end 三个
    expect(urls[0]).toContain('region=chr1A%3A1-200000');
    expect(urls[0]).not.toContain('start=');
    expect(result.text).toContain('total=1');
    expect(result.text).toContain('WTa_096d3b');
    expect(result.text).toContain('downstream_gene_variant');
    expect(result.text).not.toContain('info_raw');
    // 已证实的是闭区间（端点都含）；1-based/0-based 不作为结论出现，只允许以"不涉及"的否定式提及
    expect(result.text).toContain('闭区间');
    expect(result.text).not.toMatch(/按 ?1-based|上游是 ?1-based|1-based 坐标/);
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });

  it('VEP ANN 按标准字段序解析：取 Consequence 与 Gene，不把 Allele 当成 consequence', async () => {
    // 这条是修正错误：ANN 原文是 Allele|Consequence|IMPACT|SYMBOL|Gene|...
    // 曾按 parts[0..2] 取，得到「等位基因|consequence|impact」，基因 ID 被整个丢掉。
    const { ctx } = replay('variant-query.json');
    const result = await tool('wheatomics_variant_query').run(
      { dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' },
      ctx,
    );

    expect(result.text).toContain('downstream_gene_variant');
    expect(result.text).toContain('TraesCS1A02G000700');
    // 等位基因 T 不能冒充 consequence
    expect(result.text).not.toContain('T / ');
    expect(result.text).not.toContain('T|downstream_gene_variant');
  });

  it('ANN 字段数不足 5 段 → 抛结构错，不按错位下标硬取', async () => {
    const { ctx } = replay('variant-query.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        const record = (data.records as Array<Record<string, unknown>>)[0]!;
        (record.info as Record<string, unknown>).ANN = 'T|downstream_gene_variant';
      },
    });
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' }, ctx),
    ).rejects.toThrow(/info\.ANN/);
  });

  it('点号占位显式标注：qual="." 显示为「.(未计算)」，不当成 0 或缺失', async () => {
    const { ctx } = replay('variant-query.json');
    const result = await tool('wheatomics_variant_query').run(
      { dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' },
      ctx,
    );
    expect(result.text).toContain('.(未计算)');
    expect(result.text).toContain('PASS');
  });

  it('samples 与 genotypes 一律不读：正文与 raw 都不出现逐样本数据', async () => {
    // 实测这两块占单条响应 88.1%；只删 info_raw 是不够的（那样仍有约 9 KB）。
    const { ctx } = replay('variant-query.json');
    const result = await tool('wheatomics_variant_query').run(
      { dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' },
      ctx,
    );

    expect(result.text).not.toContain('sample_placeholder_1');
    expect(result.text).not.toContain('./.:.');
    expect(result.text).toContain('n_samples=487'); // 只报数量

    const raw = result.raw as { records: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain('sample_placeholder_1');
    expect(serialized).not.toContain('./.:.');
    expect(serialized).not.toContain('genotypes');
    expect(serialized).not.toContain('info_raw');
  });

  it('40 条记录仍不超预算，且不因裁剪切掉出处尾注', async () => {
    // 构造 40 条（远超 limit 默认值），验证 fitTable 逐行预算与出处共存
    const { ctx } = replay('variant-query.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        const first = (data.records as Array<Record<string, unknown>>)[0]!;
        const many = Array.from({ length: 40 }, (_, i) => ({
          ...first,
          pos: 1000 + i * 100,
          id: `WTa_test_${i}`,
        }));
        data.records = many;
        data.total = 40;
        data.total_shown = 40;
      },
    });
    const result = await tool('wheatomics_variant_query').run(
      { dataset: 'whealbi_minocc10', region: 'chr1A:1-200000', limit: 40 },
      ctx,
    );

    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
    expect(result.text).toContain('源：WheatOmics');
    expect(result.text).toContain('HTTP 200');
    // 未展示的条目必须如实计数，且不能出现负数
    expect(result.text).not.toContain('另有 -');
    const shownMatch = /本次正文展示 (\d+) 条，另有 (\d+) 条未展示/.exec(result.text);
    if (shownMatch) {
      expect(Number(shownMatch[1]) + Number(shownMatch[2])).toBe(40);
    }
  });

  it('raw 是白名单投影：去掉 info/info_raw，保留 chrom/pos/id/ref/alt/filter', async () => {
    const { ctx } = replay('variant-query.json');
    const result = await tool('wheatomics_variant_query').run(
      { dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' },
      ctx,
    );
    const raw = result.raw as { records: Array<Record<string, unknown>> };
    expect(raw.records).toHaveLength(1);
    const record = raw.records[0]!;
    expect(record.pos).toBe(168831);
    expect(record.info).toBeUndefined();
    expect(record.info_raw).toBeUndefined();
  });

  it('0 条：成功文本 + 固定警示句，绝不写成「没有变异」', async () => {
    const { ctx } = replay('variant-query-empty.json');
    const result = await tool('wheatomics_variant_query').run(
      { dataset: 'whealbi_minocc10', region: 'chr1A:1-100' },
      ctx,
    );

    expect(result.text).toContain('0 条');
    expect(result.text).toContain('0 条不等于该区间没有变异');
    expect(result.text).toContain('genome_concordant');
    // 只允许"不等于…没有变异"的否定式，不许出现肯定式断言
    expect(result.text).not.toMatch(/(?<!不等于)该区间没有变异/);
    expect(result.text).not.toContain('不存在');
  });

  it('记录落在请求区间外 → 身份不符抛错，不把无关记录当结果', async () => {
    const { ctx } = replay('variant-query.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        (data.records as Array<Record<string, unknown>>)[0]!.pos = 999999;
      },
    });
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' }, ctx),
    ).rejects.toThrow(/身份不符/);
  });

  it('染色体不一致 → 身份不符抛错', async () => {
    const { ctx } = replay('variant-query.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        (data.records as Array<Record<string, unknown>>)[0]!.chrom = 'chr5B';
      },
    });
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' }, ctx),
    ).rejects.toThrow(/身份不符/);
  });

  it('total>0 但 records 为空 → 结构漂移，不当成空结果', async () => {
    const { ctx } = replay('variant-query-empty.json', {
      mutate: (payload) => {
        (payload.data as Record<string, unknown>).total = 5;
      },
    });
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-100' }, ctx),
    ).rejects.toThrow(/自相矛盾/);
  });

  it('records 缺失 → 结构漂移', async () => {
    const { ctx } = replay('variant-query.json', {
      mutate: (payload) => {
        delete (payload.data as Record<string, unknown>).records;
      },
    });
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' }, ctx),
    ).rejects.toThrow(/records/);
  });

  it('region 参数非法时本地拒绝且零请求', async () => {
    const bad = [
      'chr1A', // 缺区间
      'chr1A:1', // 缺终点
      'chr1A:0-100', // 起点 0
      'chr1A:200-100', // 起点大于终点
      'chr1A:1-200000\n', // 尾随换行（控制字符）
      ' chr1A:1-100', // 首尾空白
      `chr1A:1-${'9'.repeat(20)}`, // 超长
      'chr 1A:1-100', // 染色体含空格
    ];
    for (const region of bad) {
      const { ctx, urls } = replay('variant-query.json');
      await expect(
        tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region }, ctx),
        `应拒绝 region=${JSON.stringify(region)}`,
      ).rejects.toThrow();
      expect(urls, `region=${JSON.stringify(region)} 不应发请求`).toHaveLength(0);
    }
  });

  it('普通闭区间查询：两端点都包含，发出去的就是用户给的区间', async () => {
    // 五次边界实验证实区间是闭区间；正常区间不做任何扩窗改写。
    const { ctx, urls } = replay('variant-query.json', {
      mutate: (payload) => {
        (payload.data as Record<string, unknown>).region = 'chr1A:1-200000';
      },
    });
    const result = await tool('wheatomics_variant_query').run(
      { dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' },
      ctx,
    );
    expect(urls[0]).toContain('region=chr1A%3A1-200000');
    expect(result.text).toContain('WTa_096d3b');
    expect(result.text).toContain('闭区间');
  });

  it('单点（start===end）本地拒绝且零请求：上游会以 400 拒绝等端点区间，不是查无', async () => {
    // 2026-10-29 实测：chr1A:168831-168831 → 400 Region length must be > 0 and <= 5000000 bp
    // 本仓选择本地拒绝（不做自动扩窗），避免把透传 400 当成"该位点没有变异"。
    const { ctx, urls } = replay('variant-query.json');
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:168831-168831' }, ctx),
    ).rejects.toThrow(/起点与终点相同/);
    expect(urls, '单点必须在本地拒绝，一个请求都不发').toHaveLength(0);
  });

  it('单点被拒时的文案：说明不是「没有变异」，并给出可用的区间写法', async () => {
    const { ctx } = replay('variant-query.json');
    let message = '';
    try {
      await tool('wheatomics_variant_query').run(
        { dataset: 'whealbi_minocc10', region: 'chr1A:168831-168831' },
        ctx,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('400');
    expect(message).toContain('不是"该位点没有变异"');
    // 给出规避写法（168830-168832）
    expect(message).toContain('168830-168832');
  });

  it('起点为 1 的单点同样本地拒绝，不产生 0 坐标', async () => {
    const { ctx, urls } = replay('variant-query.json');
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-1' }, ctx),
    ).rejects.toThrow(/起点与终点相同/);
    expect(urls).toHaveLength(0);
  });

  it('400 参数非法不得被当成「查无」：错误类型与 200+total=0 不同', async () => {
    // 400 由共享 http 层抛 UpstreamError；这条断言确保它不会被折成成功文本
    const { ctx } = replayStatus('variant-query.json', 400);
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' }, ctx),
    ).rejects.toThrow();

    // 对照：200 + total=0 是成功文本，且带警示句
    const empty = replay('variant-query-empty.json');
    const ok = await tool('wheatomics_variant_query').run(
      { dataset: 'whealbi_minocc10', region: 'chr1A:1-100' },
      empty.ctx,
    );
    expect(ok.text).toContain('0 条');
    expect(ok.text).toContain('0 条不等于该区间没有变异');
  });

  it('描述写清 region 是单个字符串参数，且不支持按变异 ID 查询', () => {
    const def = tool('wheatomics_variant_query');
    expect(def.description).toContain('单个字符串参数');
    expect(def.description).toContain('0 条不等于该区间没有变异');
    expect(def.description).toContain('不支持按变异 ID 查询');
    // variant_id 不在参数表里（19 秒全文件扫描，超出超时预算）
    expect(Object.keys(def.parameters.properties ?? {})).not.toContain('variant_id');
  });
});

// ── 审查 WHT3-01～04 四条反例（2026-10-29 对抗审查复现后补） ────────────────
//
// 这四类都是"看着是绿的、其实把错误当成了正常"：
//   WHT3-01 缺计数 / [null] 被折成合法 0 条
//   WHT3-02 身份对账只覆盖顶层字段
//   WHT3-03 空结果分支绕过 raw 白名单
//   WHT3-04 首行"展示 N 条"与表格实际行数冲突
// 每条断言的都是**应该失败**，不是应该成功。

describe('WHT3-01 缺失计数与非法数组元素不得折成合法 0 条', () => {
  it('同源：删掉 count 却返回 hits=[] → 结构漂移，不许打印「上游 count=0」', async () => {
    const { ctx } = replay('homologs-empty.json', {
      mutate: (payload) => {
        delete (payload.data as Record<string, unknown>).count;
      },
    });
    await expect(
      tool('wheatomics_cross_species_homologs').run({ gene_id: 'TraesCS9Z99G999999' }, ctx),
    ).rejects.toThrow(/count/);
  });

  it('同源：count=0 但 hits=[null] → 结构漂移，不许当成 0 条', async () => {
    const { ctx } = replay('homologs.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        data.count = 0;
        data.hits = [null];
      },
    });
    await expect(
      tool('wheatomics_cross_species_homologs').run({ gene_id: 'TraesCS5A02G391700' }, ctx),
    ).rejects.toThrow(/不是对象/);
  });

  it('变异：total=0 但 records=[null] → 结构漂移，不许当成 0 条', async () => {
    const { ctx } = replay('variant-query.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        data.total = 0;
        data.total_shown = 0;
        data.records = [null];
      },
    });
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' }, ctx),
    ).rejects.toThrow(/不是对象/);
  });

  it('变异：删掉 total 与 total_shown → 结构漂移，尾注不许写 total=0', async () => {
    const { ctx } = replay('variant-query-empty.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        delete data.total;
        delete data.total_shown;
      },
    });
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-100' }, ctx),
    ).rejects.toThrow(/total/);
  });

  it('变异：total 为负数或非整数 → 结构漂移', async () => {
    for (const bad of [-1, 1.5, '0', null]) {
      const { ctx } = replay('variant-query-empty.json', {
        mutate: (payload) => {
          (payload.data as Record<string, unknown>).total = bad;
        },
      });
      await expect(
        tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-100' }, ctx),
        `total=${JSON.stringify(bad)} 应被拒绝`,
      ).rejects.toThrow(/total/);
    }
  });

  it('数据集目录：references=[null] → 结构漂移', async () => {
    const { ctx } = replay('variant-datasets.json', {
      mutate: (payload) => {
        (payload.data as Record<string, unknown>).references = [null];
      },
    });
    await expect(tool('wheatomics_variant_datasets').run({}, ctx)).rejects.toThrow(/不是对象/);
  });

  it('数据集目录：datasets 里混入纯字符串元素 → 结构漂移，不猜它是 key', async () => {
    const { ctx } = replay('variant-datasets.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        const refs = data.references as Array<Record<string, unknown>>;
        (refs[0]!.datasets as unknown[]).push('bare_string_key');
      },
    });
    await expect(tool('wheatomics_variant_datasets').run({}, ctx)).rejects.toThrow(/非对象/);
  });
});

describe('WHT3-02 身份对账必须覆盖逐条与 dataset 回显', () => {
  it('同源：顶层 query_gene 正确、但单条命中是别的基因 → 抛身份不符', async () => {
    const { ctx } = replay('homologs.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        // 顶层保持正确，只污染第 1 条
        (data.hits as Array<Record<string, unknown>>)[0]!.query_gene = 'UNREQUESTED_GENE';
      },
    });
    await expect(
      tool('wheatomics_cross_species_homologs').run({ gene_id: 'TraesCS5A02G391700' }, ctx),
    ).rejects.toThrow(/身份不符/);
  });

  it('变异：坐标合法但 data.dataset 与请求不符 → 抛身份不符（不能用请求值覆盖回显）', async () => {
    const { ctx } = replay('variant-query.json', {
      mutate: (payload) => {
        (payload.data as Record<string, unknown>).dataset = 'UNREQUESTED_DATASET';
      },
    });
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' }, ctx),
    ).rejects.toThrow(/身份不符/);
  });

  it('变异：data.dataset 缺失 → 抛错，不假设就是请求的那个', async () => {
    const { ctx } = replay('variant-query.json', {
      mutate: (payload) => {
        delete (payload.data as Record<string, unknown>).dataset;
      },
    });
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' }, ctx),
    ).rejects.toThrow(/dataset/);
  });

  it('变异：data.region 与请求不符 → 抛身份不符', async () => {
    const { ctx } = replay('variant-query.json', {
      mutate: (payload) => {
        (payload.data as Record<string, unknown>).region = 'chr5B:1-100';
      },
    });
    await expect(
      tool('wheatomics_variant_query').run({ dataset: 'whealbi_minocc10', region: 'chr1A:1-200000' }, ctx),
    ).rejects.toThrow(/身份不符/);
  });
});

describe('WHT3-03 空结果的 raw 也必须走白名单', () => {
  it('变异空结果：上游附带 samples/genotypes/info_raw 时，raw 里一个都不许出现', async () => {
    const { ctx } = replay('variant-query-empty.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        data.samples = ['SAMPLE_SENTINEL'];
        (payload.data as Record<string, unknown>).genotypes = ['GENOTYPE_SENTINEL'];
        data.info_raw = 'RAW_SENTINEL';
        // 再塞进 records（空）同级位置也不该被带出
        data.extra = 'EXTRA_SENTINEL';
      },
    });
    const result = await tool('wheatomics_variant_query').run(
      { dataset: 'whealbi_minocc10', region: 'chr1A:1-100' },
      ctx,
    );

    const serialized = JSON.stringify(result.raw);
    expect(serialized).not.toContain('SAMPLE_SENTINEL');
    expect(serialized).not.toContain('GENOTYPE_SENTINEL');
    expect(serialized).not.toContain('RAW_SENTINEL');
    expect(serialized).not.toContain('EXTRA_SENTINEL');
    // 但仍要保留计数语义
    expect(serialized).toContain('"total":0');
  });

  it('同源空结果：raw 不得原样带出上游 data 整包', async () => {
    const { ctx } = replay('homologs-empty.json', {
      mutate: (payload) => {
        (payload.data as Record<string, unknown>).leak = 'LEAK_SENTINEL';
      },
    });
    const result = await tool('wheatomics_cross_species_homologs').run({ gene_id: 'TraesCS9Z99G999999' }, ctx);
    expect(JSON.stringify(result.raw)).not.toContain('LEAK_SENTINEL');
  });

  it('数据集目录：references=[] 时 raw 不带整包 data', async () => {
    const { ctx } = replay('variant-datasets.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        data.references = [];
        data.leak = 'LEAK_SENTINEL';
      },
    });
    const result = await tool('wheatomics_variant_datasets').run({}, ctx);
    expect(JSON.stringify(result.raw)).not.toContain('LEAK_SENTINEL');
  });
});

describe('WHT3-04 展示条数在首行、表格、尾行必须一致', () => {
  it('20 条记录放不下时：首行「正文展示 N」必须等于表格行数，且 N + 未展示 = 20', async () => {
    const { ctx } = replay('variant-query.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        const first = (data.records as Array<Record<string, unknown>>)[0]!;
        data.records = Array.from({ length: 20 }, (_, i) => ({
          ...first,
          pos: 168831,
          id: `variant_${i}`,
        }));
        data.total = 20;
        data.total_shown = 20;
      },
    });
    const result = await tool('wheatomics_variant_query').run(
      { dataset: 'whealbi_minocc10', region: 'chr1A:1-200000', limit: 20 },
      ctx,
    );

    const headMatch = /正文展示 (\d+) 条/.exec(result.text);
    expect(headMatch, '首行必须报告正文展示条数').not.toBeNull();
    const headShown = Number(headMatch![1]);

    // 表格实际数据行数
    const tableRows = result.text.split('\n').filter((line) => line.trim().startsWith('|')).length - 2;
    expect(tableRows).toBe(headShown);

    // 尾行口径一致
    const tailMatch = /本次正文展示 (\d+) 条，另有 (\d+) 条未展示/.exec(result.text);
    if (tailMatch) {
      expect(Number(tailMatch[1])).toBe(headShown);
      expect(Number(tailMatch[1]) + Number(tailMatch[2])).toBe(20);
    }

    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
    expect(result.text).not.toContain('另有 -');
  });

  it('同源：条数放不下时首行「本次正文展示 N」与表格行数一致', async () => {
    const { ctx } = replay('homologs.json', {
      mutate: (payload) => {
        const data = payload.data as Record<string, unknown>;
        const first = (data.hits as Array<Record<string, unknown>>)[0]!;
        data.hits = Array.from({ length: 30 }, (_, i) => ({
          ...first,
          target_gene: `TG_${i}`,
          description: 'x'.repeat(120),
        }));
        data.count = 30;
      },
    });
    const result = await tool('wheatomics_cross_species_homologs').run(
      { gene_id: 'TraesCS5A02G391700', max_targets: 3 },
      ctx,
    );

    const headMatch = /本次正文展示 (\d+) 条/.exec(result.text);
    const tableRows = result.text.split('\n').filter((line) => line.trim().startsWith('|')).length - 2;
    if (headMatch) expect(Number(headMatch[1])).toBe(tableRows);
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });
});



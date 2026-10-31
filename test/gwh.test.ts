import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, UpstreamShapeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import { invokeTool } from '../src/core/invoke.js';
import type { Fetcher } from '../src/core/types.js';
import { manifest } from '../src/sources/gwh/manifest.js';
import { validateProbe } from '../src/sources/gwh/probe.js';
import { tools } from '../src/sources/gwh/tools.js';

type Obj = Record<string, unknown>;
interface Capture {
  url: string;
  at: string;
  status: number;
  contentType: string;
  originalBytes: number;
  trimmed?: string;
  simulated?: boolean;
  note?: string;
}
function fixture(name: string): { capture: Capture; payload: Obj } {
  return JSON.parse(readFileSync(new URL(`../src/sources/gwh/fixtures/${name}.json`, import.meta.url), 'utf8'));
}
function def(name: string) {
  const tool = tools.find((item) => item.name === `gwh_${name}`);
  if (!tool) throw new Error(`Missing gwh_${name}`);
  return tool;
}
function replay(name: string, mutate?: (data: Obj) => void) {
  const { capture, payload } = fixture(name);
  mutate?.(payload);
  const urls: string[] = [];
  const http: Fetcher = async <T>(url: string) => {
    urls.push(url);
    return { data: payload as T, url, status: capture.status, contentType: capture.contentType, durationMs: 7, attempts: 1 };
  };
  return { ctx: { http }, urls, payload, capture };
}
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const BANNED = /全物种|源未提供物种清单|覆盖全部/;

describe('GWH fixture 隐私（真实件递归扫描）', () => {
  it('所有非 simulated 的真实 fixture 都不含邮箱；模拟件命中属预期', () => {
    const dir = new URL('../src/sources/gwh/fixtures/', import.meta.url);
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    const hits: string[] = [];
    let realFiles = 0;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const data = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as { capture?: { simulated?: boolean }; payload?: unknown };
      if (data.capture?.simulated === true) continue;
      realFiles += 1;
      const walk = (value: unknown, path: string): void => {
        if (typeof value === 'string') {
          if (email.test(value)) hits.push(`${file}:${path}`);
          return;
        }
        if (Array.isArray(value)) {
          value.forEach((item, index) => walk(item, `${path}[${index}]`));
          return;
        }
        if (value && typeof value === 'object') {
          for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, `${path}.${key}`);
        }
      };
      walk(data.payload, 'payload');
    }
    expect(realFiles).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });
});

describe('GWH 两工具契约（离线回放，不联网）', () => {
  it('工具名、参数形状与 T1 manifest 符合契约', () => {
    expect(tools.map((tool) => tool.name)).toEqual(['gwh_assembly_lookup', 'gwh_project_sample_lookup']);
    for (const tool of tools) {
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(50);
    }
    const lookup = def('assembly_lookup');
    expect(lookup.parameters.properties?.entity?.enum).toEqual(['genome', 'assembly']);
    expect(lookup.parameters.required).toEqual(['entity', 'id']);
    const projectSample = def('project_sample_lookup');
    expect(projectSample.parameters.properties?.entity?.enum).toEqual(['project', 'sample']);

    expect(manifest.tier).toBe('T1');
    expect(manifest.docs).toBe('https://ngdc.cncb.ac.cn/gwh/api_documents');
    expect(manifest.apiBase).toBe('https://ngdc.cncb.ac.cn/gwh/api/public');
    expect(manifest.probe.path).toBe('/genome/1');
    expect(manifest.lastProbe?.date).toBe('2026-10-28');
    // 覆盖只写“本仓未声明”；示例物种有实测出处
    expect(manifest.species).toEqual(['Taraxacum kok-saghyz']);
    for (const caveat of manifest.caveats ?? []) expect(caveat).not.toMatch(BANNED);
    expect((manifest.caveats ?? []).join('\n')).toContain('本仓未声明覆盖范围');
  });

  it('genome 正例：1 次请求、完整出处、身份对账、raw 为白名单投影', async () => {
    const run = replay('genome');
    const result = await invokeTool(def('assembly_lookup'), { entity: 'genome', id: '1' }, { http: run.ctx.http });
    expect(run.urls).toHaveLength(1);
    expect(run.urls[0]).toBe('https://ngdc.cncb.ac.cn/gwh/api/public/genome/1');
    expect(result.text).toContain('Taraxacum kok-saghyz');
    expect(result.text).toContain('GWHAAAA00000000');
    expect(result.text).toContain('entity=assembly');
    expect(result.text).toContain(`GET ${run.urls[0]}`);
    expect(result.text).toContain('HTTP 200');
    expect(result.text).toContain('7 ms');
    expect(result.text).toContain(result.meta.at);
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
    const raw = result.raw as Obj;
    expect(raw.id).toBe('1');
    expect(raw.representativeAssemblyLevel).toBe('Contig');
    // 投影里不出现未列入白名单的上游字段
    expect(raw).not.toHaveProperty('otherAssemblies');
    expect(raw).not.toHaveProperty('representativeAssemblyLink');
    expect(result.text).not.toContain('otherAssemblies:');
  });

  it('genome 查无：返回成功文本（不是异常），并说明 200 空结构语义', async () => {
    const run = replay('genome-missing');
    const result = await invokeTool(def('assembly_lookup'), { entity: 'genome', id: '999999999' }, { http: run.ctx.http });
    expect(result.text).toContain('未找到');
    expect(result.text).toContain('HTTP 200');
    expect(result.text).not.toContain('错误');
    expect(result.raw).toEqual({ id: null, organism: null });
    // 空输出必须带条件限定（2026-10-31 纪律）：说清"在什么形态下未命中"，且不做无条件断言
    expect(result.text).toContain('未命中');
    expect(result.text).toContain('这不等于');
    expect(result.text).not.toContain('没有记录');
  });

  it('四个查无文案都带条件限定（genome/assembly/project/sample 一处不漏）', async () => {
    // 这条盯的是"别只改一处"：四处文案各自由不同的空形态触发、分属两个工具，必须逐一核。
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ['genome-missing', { entity: 'genome', id: '999999999' }, 'genome_id', 'assembly_lookup'],
      ['assembly-missing', { entity: 'assembly', id: 'GWHZZZ00000000' }, '组装', 'assembly_lookup'],
      ['bioproject-missing', { entity: 'project', id: 'PRJCA999999999' }, '项目', 'project_sample_lookup'],
      ['biosample-missing', { entity: 'sample', id: 'SAMC999999999' }, '样本', 'project_sample_lookup'],
    ];
    for (const [fixture, args, label, toolName] of cases) {
      const run = replay(fixture);
      const result = await invokeTool(def(toolName), args, { http: run.ctx.http });
      expect(result.text, `${label}（${fixture}）`).toContain('未命中');
      expect(result.text, `${label}（${fixture}）`).toContain('这不等于');
      expect(result.text, `${label}（${fixture}）`).not.toContain('没有记录');
    }
  });

  it('genome 缺身份键 → 结构漂移，不折成查无', async () => {
    const run = replay('genome', (data) => {
      delete data.id;
    });
    await expect(def('assembly_lookup').run({ entity: 'genome', id: '1' }, run.ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('genome 身份字段一半为 null → 矛盾信封', async () => {
    const run = replay('genome', (data) => {
      data.organism = null;
    });
    await expect(def('assembly_lookup').run({ entity: 'genome', id: '1' }, run.ctx)).rejects.toThrow(/矛盾信封/);
  });

  it('genome 响应 id 与请求不一致 → 完整性失败（不是查无）', async () => {
    const run = replay('genome', (data) => {
      data.id = '2';
    });
    await expect(def('assembly_lookup').run({ entity: 'genome', id: '1' }, run.ctx)).rejects.toThrow(/响应与请求不一致/);
  });

  it('assembly 正例：六类路径 + 项目/样本 accession，且不输出 contacts/submitter', async () => {
    const run = replay('assembly');
    const result = await invokeTool(def('assembly_lookup'), { entity: 'assembly', id: 'GWHAAAA00000000' }, { http: run.ctx.http });
    expect(result.text).toContain('PRJCA000437');
    expect(result.text).toContain('SAMC012932');
    expect(result.text).toContain('.genome.fasta.gz');
    expect(result.text).toContain('.Protein.faa.gz');
    expect(result.text).toContain('不下载');
    expect(result.text).not.toContain('@');
    expect(result.text).not.toContain('submitterOrganization');
    const raw = result.raw as Obj;
    expect(raw).not.toHaveProperty('contacts');
    expect(raw).not.toHaveProperty('submitterOrganization');
  });

  it('assembly 模拟联系人反例：输出与 raw 都不含虚构邮箱', async () => {
    const run = replay('assembly-with-contact');
    expect(run.capture.simulated).toBe(true);
    const result = await invokeTool(def('assembly_lookup'), { entity: 'assembly', id: 'GWHAAAA00000000' }, { http: run.ctx.http });
    const rawText = JSON.stringify(result.raw);
    expect(result.text).not.toContain('example.org');
    expect(rawText).not.toContain('example.org');
    expect(rawText).not.toContain('Fake Person');
  });

  it('assembly 查无（GWH 形态但不存在）→ 成功文本，并提示 GCA/GCF 不在范围', async () => {
    const run = replay('assembly-missing');
    const result = await invokeTool(def('assembly_lookup'), { entity: 'assembly', id: 'GWHZZZ00000000' }, { http: run.ctx.http });
    expect(result.text).toContain('未找到');
    expect(result.text).toContain('GCA_/GCF_');
  });

  it('非 GWH 形态在本地拒绝：上游对该形态只回全 null（证据见 assembly-not-an-accession）', async () => {
    const run = replay('assembly-not-an-accession');
    expect(fixture('assembly-not-an-accession').capture.note).toContain('上游同样回全 null');
    await expect(def('assembly_lookup').run({ entity: 'assembly', id: 'NOT_AN_ACCESSION' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(run.urls).toHaveLength(0);
  });

  it('project 正例：描述截断标注、分类单元、数据类型、文献只报本次返回条数', async () => {
    const run = replay('bioproject');
    const result = await invokeTool(def('project_sample_lookup'), { entity: 'project', id: 'PRJCA000437' }, { http: run.ctx.http });
    expect(run.urls[0]).toBe('https://ngdc.cncb.ac.cn/gwh/api/public/bioProject/PRJCA000437');
    expect(result.text).toContain('Genomic sequence of Taraxacum kok-saghyz Rodin');
    expect(result.text).toContain('已截断');
    expect(result.text).toContain('Whole genome sequencing');
    expect(result.text).toContain('本次返回 2 条');
    expect(result.text).not.toContain('共 2 篇');
    expect(result.text).toContain('不返回样本列表');
    expect(result.text).not.toContain('@');
    const raw = result.raw as Obj;
    expect(raw).not.toHaveProperty('submitter');
    expect(raw.publicationReturned).toBe(2);
  });

  it('project 注入 submitter 反例：输出与 raw 都不含邮箱/姓名', async () => {
    const run = replay('bioproject', (data) => {
      data.submitter = { email: 'leak@example.org', firstName: 'Leak', lastName: 'Person' };
    });
    const result = await invokeTool(def('project_sample_lookup'), { entity: 'project', id: 'PRJCA000437' }, { http: run.ctx.http });
    expect(result.text).not.toContain('example.org');
    expect(JSON.stringify(result.raw)).not.toContain('example.org');
  });

  it('project 查无（Nonentity）→ 成功文本；Nonentity 但 title 非空 → 矛盾失败', async () => {
    const notFoundRun = replay('bioproject-missing');
    const result = await invokeTool(def('project_sample_lookup'), { entity: 'project', id: 'PRJCA999999999' }, { http: notFoundRun.ctx.http });
    expect(result.text).toContain('未找到');
    expect(result.text).toContain('平行入口');

    const contradictory = replay('bioproject-missing', (data) => {
      data.title = '不应出现的标题';
    });
    await expect(def('project_sample_lookup').run({ entity: 'project', id: 'PRJCA999999999' }, contradictory.ctx)).rejects.toThrow(/矛盾信封/);
  });

  it('project 响应 accession 与请求不一致 → 完整性失败', async () => {
    const run = replay('bioproject', (data) => {
      data.prjAccession = 'PRJCA000001';
    });
    await expect(def('project_sample_lookup').run({ entity: 'project', id: 'PRJCA000437' }, run.ctx)).rejects.toThrow(/响应与请求不一致/);
  });

  it('sample 正例：样本类型/组织/物种，且不输出 sampleId、userId、submitter', async () => {
    const run = replay('biosample');
    const result = await invokeTool(def('project_sample_lookup'), { entity: 'sample', id: 'SAMC012932' }, { http: run.ctx.http });
    expect(result.text).toContain('Plant sample');
    expect(result.text).toContain('leaf');
    expect(result.text).toContain('Taraxacum kok-saghyz');
    expect(result.text).toContain('不返回样本所属项目');
    expect(result.text).not.toContain('@');
    expect(result.text).not.toContain('sampleId');
    const raw = result.raw as Obj;
    expect(raw).not.toHaveProperty('submitter');
    expect(raw).not.toHaveProperty('userId');
    expect(raw).not.toHaveProperty('sampleId');
    const attributes = raw.sampleAttribute as Obj;
    expect(attributes.tissue).toBe('leaf');
    expect(attributes).not.toHaveProperty('sample');
    expect(attributes).not.toHaveProperty('biomaterialProvider');
  });

  it('sample 查无（Nonentity + accession null）', async () => {
    const run = replay('biosample-missing');
    const result = await invokeTool(def('project_sample_lookup'), { entity: 'sample', id: 'SAMC999999999' }, { http: run.ctx.http });
    expect(result.text).toContain('未找到');
  });

  it('参数拒绝：GCA/GCF、PRJNA、SAMN 在本地拒绝且一个请求都不发', async () => {
    const run = replay('genome');
    await expect(def('assembly_lookup').run({ entity: 'assembly', id: 'GCA_044057325.1' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('assembly_lookup').run({ entity: 'assembly', id: 'GCF_000001405.40' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('assembly_lookup').run({ entity: 'genome', id: 'GWHAAAA00000000' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('project_sample_lookup').run({ entity: 'project', id: 'PRJNA000001' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('project_sample_lookup').run({ entity: 'sample', id: 'SAMN00000000' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(run.urls).toHaveLength(0);
  });

  it('参数拒绝：未知 entity、空 id、控制字符', async () => {
    const run = replay('genome');
    await expect(def('assembly_lookup').run({ entity: 'phone', id: '1' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('assembly_lookup').run({ entity: 'genome', id: '   ' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('assembly_lookup').run({ entity: 'genome', id: '1\n2' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(run.urls).toHaveLength(0);
  });

  it('project 查无若回显 accession 与请求不符 → 完整性失败，不伪装成查无', async () => {
    const run = replay('bioproject-missing', (data) => {
      data.prjAccession = 'PRJCA000437';
    });
    await expect(def('project_sample_lookup').run({ entity: 'project', id: 'PRJCA999999999' }, run.ctx)).rejects.toThrow(/回显|不一致/);
  });

  it('标题/物种等自由文本含邮箱时：正文与 raw 都不输出该内容', async () => {
    const projectRun = replay('bioproject', (data) => {
      data.title = 'Genomic data, contact leak@example.org';
    });
    const project = await invokeTool(def('project_sample_lookup'), { entity: 'project', id: 'PRJCA000437' }, { http: projectRun.ctx.http });
    expect(project.text).not.toContain('example.org');
    expect(JSON.stringify(project.raw)).not.toContain('example.org');
    expect(project.text).toContain('已省略');

    const genomeRun = replay('genome', (data) => {
      data.organism = 'Fake species <leak@example.org>';
    });
    const genome = await invokeTool(def('assembly_lookup'), { entity: 'genome', id: '1' }, { http: genomeRun.ctx.http });
    expect(genome.text).not.toContain('example.org');
    expect(JSON.stringify(genome.raw)).not.toContain('example.org');
  });

  it('ID 不做 trim 改写：首尾空白在本地拒绝且零请求', async () => {
    const run = replay('genome');
    await expect(def('assembly_lookup').run({ entity: 'genome', id: ' 1' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('assembly_lookup').run({ entity: 'genome', id: '1 ' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('project_sample_lookup').run({ entity: 'project', id: ' PRJCA000437' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(run.urls).toHaveLength(0);
  });

  it('分类单元/数据类型只报本次返回条数（不把展示条数当返回条数）', async () => {
    const run = replay('bioproject');
    const result = await invokeTool(def('project_sample_lookup'), { entity: 'project', id: 'PRJCA000437' }, { http: run.ctx.http });
    expect(result.text).toContain('本次返回 1 项');
    expect(result.text).toContain('最多展示 10 项');
    const raw = result.raw as Obj;
    expect(raw.taxonReturned).toBe(1);
    expect(raw.dataTypeReturned).toBe(1);
  });

  it('源级 probe：正例通过，身份/类型不符与空对象都抛错', () => {
    const good = deepCopy(fixture('genome').payload);
    expect(() => validateProbe(good)).not.toThrow();
    expect(() => validateProbe({ ...good, id: '2' })).toThrow(/不一致/);
    expect(() => validateProbe({ ...good, organism: '' })).toThrow(/organism/);
    expect(() => validateProbe({})).toThrow(/身份字段/);
    expect(() => validateProbe(null)).toThrow(/顶层/);
  });
});

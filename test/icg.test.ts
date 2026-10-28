import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, UpstreamShapeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import { invokeTool } from '../src/core/invoke.js';
import type { Fetcher } from '../src/core/types.js';
import { manifest } from '../src/sources/icg/manifest.js';
import { validateProbe } from '../src/sources/icg/probe.js';
import { tools } from '../src/sources/icg/tools.js';

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
  return JSON.parse(readFileSync(new URL(`../src/sources/icg/fixtures/${name}.json`, import.meta.url), 'utf8'));
}
function def(name: string) {
  const tool = tools.find((item) => item.name === `icg_${name}`);
  if (!tool) throw new Error(`Missing icg_${name}`);
  return tool;
}
function replay(name: string, mutate?: (data: Obj) => void) {
  const { capture, payload } = fixture(name);
  mutate?.(payload);
  const urls: string[] = [];
  const http: Fetcher = async <T>(url: string) => {
    urls.push(url);
    return { data: payload as T, url, status: capture.status, contentType: capture.contentType, durationMs: 5, attempts: 1 };
  };
  return { ctx: { http }, urls, payload, capture };
}
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const BANNED = /全物种|源未提供物种清单|覆盖全部/;
const FORWARD = 'TGGGCCTACTGGTCTTACTACTGA';
const REVERSE = 'ACATACCCACGCTTCAGATCCT';

describe('ICG fixture 隐私（真实件递归扫描）', () => {
  it('所有非 simulated 的真实 fixture 都不含邮箱；模拟件命中属预期', () => {
    const dir = new URL('../src/sources/icg/fixtures/', import.meta.url);
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

describe('ICG 两工具契约（离线回放，不联网）', () => {
  it('工具名、参数形状与 T1 manifest 符合契约', () => {
    expect(tools.map((tool) => tool.name)).toEqual(['icg_lookup', 'icg_species_list']);
    for (const tool of tools) {
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(50);
    }
    expect(def('lookup').parameters.properties?.entity?.enum).toEqual(['species', 'project', 'gene', 'publication']);
    expect(manifest.tier).toBe('T1');
    expect(manifest.docs).toBe('https://ngdc.cncb.ac.cn/icg/api');
    expect(manifest.apiBase).toBe('https://ngdc.cncb.ac.cn/icg');
    expect(manifest.probe.path).toBe('/api/json/species/ICG00115');
    expect(manifest.lastProbe?.date).toBe('2026-10-28');
    expect(manifest.species).toEqual(['Zea mays']);
    for (const caveat of manifest.caveats ?? []) expect(caveat).not.toMatch(BANNED);
    expect((manifest.caveats ?? []).join('\n')).toContain('本仓未声明覆盖范围');
  });

  it('species 正例：1 次请求、研究列表与下一层提示，raw 不含联系人字段', async () => {
    const run = replay('species');
    const result = await invokeTool(def('lookup'), { entity: 'species', id: 'ICG00115' }, { http: run.ctx.http });
    expect(run.urls).toHaveLength(1);
    expect(run.urls[0]).toBe('https://ngdc.cncb.ac.cn/icg/api/json/species/ICG00115');
    expect(result.text).toContain('Zea mays');
    expect(result.text).toContain('ICG00115-1');
    expect(result.text).toContain('entity=project');
    expect(result.text).toContain('本次返回 2 条');
    expect(result.text).toContain(`GET ${run.urls[0]}`);
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
    const raw = result.raw as Obj;
    expect(raw.accession).toBe('ICG00115');
    expect(raw).not.toHaveProperty('contactName');
    expect(JSON.stringify(result.raw)).not.toMatch(/@/);
  });

  it('project 正例：引物逐字符完整、验证范围拆列表、不输出摘要与联系人', async () => {
    const run = replay('project');
    const result = await invokeTool(def('lookup'), { entity: 'project', id: 'ICG00115-1' }, { http: run.ctx.http });
    expect(result.text).toContain(FORWARD);
    expect(result.text).toContain(REVERSE);
    expect(result.text).toContain('High Temperature Condition');
    expect(result.text).toContain('不是通用推荐');
    expect(result.text).toContain('本次返回 2 条');
    expect(result.text).not.toContain('abst');
    expect(result.text).not.toMatch(/@/);
    const raw = result.raw as Obj;
    expect(raw).not.toHaveProperty('contactName');
    expect(raw).not.toHaveProperty('publication');
    const genes = raw.genes as Obj[];
    expect(genes[0]?.primersForward).toBe(FORWARD);
  });

  it('project 模拟联系人反例：输出与 raw 都不含虚构邮箱', async () => {
    const run = replay('project-with-contact');
    expect(run.capture.simulated).toBe(true);
    const result = await invokeTool(def('lookup'), { entity: 'project', id: 'ICG00115-1' }, { http: run.ctx.http });
    expect(result.text).not.toContain('example.org');
    expect(JSON.stringify(result.raw)).not.toContain('example.org');
    expect(result.text).not.toContain('Fake Person');
  });

  it('project 身份不一致时，错误文本也不含联系方式', async () => {
    const run = replay('project-with-contact', (data) => {
      (data.result as Obj).accession = 'ICG99999-9';
    });
    let message = '';
    try {
      await def('lookup').run({ entity: 'project', id: 'ICG00115-1' }, run.ctx);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('响应与请求不一致');
    expect(message).not.toContain('example.org');
  });

  it('gene 正例：引物完整、研究 accession 用平铺字段', async () => {
    const run = replay('gene');
    const result = await invokeTool(def('lookup'), { entity: 'gene', id: 'ICG00115-1-EF1a' }, { http: run.ctx.http });
    expect(result.text).toContain(FORWARD);
    expect(result.text).toContain(REVERSE);
    expect(result.text).toContain('ICG00115-1');
    expect(result.text).toContain('引物整条输出');
    const raw = result.raw as Obj;
    expect(raw.projectAccession).toBe('ICG00115-1');
    expect(raw).not.toHaveProperty('project');
  });

  it('gene 引物缺失 → 不抛错、明确缺项，不误称查无', async () => {
    const run = replay('gene', (data) => {
      (data.result as Obj).primersForward = null;
    });
    const result = await invokeTool(def('lookup'), { entity: 'gene', id: 'ICG00115-1-EF1a' }, { http: run.ctx.http });
    expect(result.text).toContain('未提供正向引物');
    expect(result.text).not.toContain('未找到');
    expect(result.text).toContain(REVERSE);
  });

  it('gene 引物类型漂移（数字）→ 结构错误', async () => {
    const run = replay('gene', (data) => {
      (data.result as Obj).primersForward = 123;
    });
    await expect(def('lookup').run({ entity: 'gene', id: 'ICG00115-1-EF1a' }, run.ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('publication 正例：题录字段输出、摘要不输出、研究列表分页标注', async () => {
    const run = replay('publication');
    const result = await invokeTool(def('lookup'), { entity: 'publication', id: '24810581' }, { http: run.ctx.http });
    expect(result.text).toContain('24810581');
    expect(result.text).toContain('PloS one');
    expect(result.text).toContain('10.1371/journal.pone.0095445');
    expect(result.text).toContain('本次返回 1 条');
    expect(result.text).not.toContain('abst');
  });

  it('publication 非数字 ID 本地拒绝且零请求；数字字符串原样进 URL（不转 Number）', async () => {
    const run = replay('publication');
    await expect(def('lookup').run({ entity: 'publication', id: 'PMID:24810581' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('lookup').run({ entity: 'publication', id: 'abc' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(run.urls).toHaveLength(0);

    const padded = replay('publication');
    await expect(def('lookup').run({ entity: 'publication', id: '0012345' }, padded.ctx)).rejects.toThrow(/响应与请求不一致/);
    expect(padded.urls).toHaveLength(1);
    expect(padded.urls[0]).toContain('/publication/0012345');
  });

  it('查无（真实 55 B 负例）：成功文本、不抛错', async () => {
    const run = replay('not-found');
    const result = await invokeTool(def('lookup'), { entity: 'project', id: 'ICG00115-Pro-1' }, { http: run.ctx.http });
    expect(result.text).toContain('未找到');
    expect(result.text).toContain('code="300"');
    expect(result.raw).toEqual({ code: '300', result: null });
  });

  it('矛盾信封与错误码：code=300 但 result 非 null、code 非字符串、code=500 都明确失败', async () => {
    const bad300 = replay('not-found', (data) => {
      data.result = { anything: true };
    });
    await expect(def('lookup').run({ entity: 'project', id: 'ICG00115-Pro-1' }, bad300.ctx)).rejects.toThrow(/矛盾信封/);

    const numericCode = replay('not-found', (data) => {
      data.code = 300;
    });
    await expect(def('lookup').run({ entity: 'project', id: 'ICG00115-Pro-1' }, numericCode.ctx)).rejects.toThrow(/不是字符串/);

    const serverError = replay('not-found', (data) => {
      data.code = '500';
      data.message = 'java.lang.NullPointerException: boom';
    });
    await expect(def('lookup').run({ entity: 'project', id: 'ICG00115-Pro-1' }, serverError.ctx)).rejects.toThrow(/未预期的 code/);
    try {
      await def('lookup').run({ entity: 'project', id: 'ICG00115-Pro-1' }, replay('not-found', (data) => {
        data.code = '500';
        data.message = 'java.lang.NullPointerException: boom';
      }).ctx);
    } catch (error) {
      expect((error as Error).message).not.toContain('NullPointerException');
    }
  });

  it('code=200 但 result 非对象 → 结构错误', async () => {
    const run = replay('species', (data) => {
      data.result = [];
    });
    await expect(def('lookup').run({ entity: 'species', id: 'ICG00115' }, run.ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('species_list 正例：上游 recordsTotal 与本次返回分开报，表格行数与返回一致', async () => {
    const run = replay('species-list');
    const result = await invokeTool(def('species_list'), { offset: 0, limit: 3 }, { http: run.ctx.http });
    expect(run.urls[0]).toContain('start=0');
    expect(run.urls[0]).toContain('length=3');
    expect(result.text).toContain('recordsTotal=540');
    expect(result.text).toContain('本次返回 3 条');
    expect(result.text).toContain('不能按名称搜索');
    const raw = result.raw as Obj;
    expect(raw.recordsTotal).toBe(540);
    expect(raw.returned).toBe(3);
    const tableRows = result.text.split('\n').filter((line) => line.startsWith('|')).length - 2;
    expect(tableRows).toBe(3);
  });

  it('species_list：recordsTotal>0 但本页为空 → 说明是 offset 越界，不是空库', async () => {
    const run = replay('species-list', (data) => {
      data.data = [];
    });
    const result = await invokeTool(def('species_list'), { offset: 500, limit: 50 }, { http: run.ctx.http });
    expect(result.text).toContain('offset 超出可返回范围');
    expect(result.text).not.toContain('空库');
  });

  it('species_list：recordsTotal=0 → 结构错误（空库形态未实测）', async () => {
    const run = replay('species-list', (data) => {
      data.recordsTotal = 0;
    });
    await expect(def('species_list').run({}, run.ctx)).rejects.toThrow(/空库形态未实测/);
  });

  it('species_list：越界参数本地拒绝且零请求（不静默夹取）', async () => {
    const run = replay('species-list');
    await expect(def('species_list').run({ offset: 521 }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('species_list').run({ limit: 0 }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('species_list').run({ limit: 51 }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(run.urls).toHaveLength(0);
  });

  it('ID 长度与预算预检是两道检查：129 码点被长度拒绝，128 个 emoji 被完整请求预算拒绝，且都零请求', async () => {
    const tooLong = replay('species');
    await expect(def('lookup').run({ entity: 'species', id: 'a'.repeat(129) }, tooLong.ctx)).rejects.toThrow(/码点上限/);
    expect(tooLong.urls).toHaveLength(0);

    const emoji = replay('species');
    await expect(def('lookup').run({ entity: 'species', id: '😀'.repeat(128) }, emoji.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(emoji.urls).toHaveLength(0);

    const boundary = replay('species');
    await expect(def('lookup').run({ entity: 'species', id: 'a'.repeat(128) }, boundary.ctx)).rejects.toThrow(/响应与请求不一致/);
    expect(boundary.urls).toHaveLength(1);

    // 中文 128 码点：完整请求实测 1198 B，能过预检（不能笼统说“中文必然超限”）
    const chinese = replay('species');
    await expect(def('lookup').run({ entity: 'species', id: '中'.repeat(128) }, chinese.ctx)).rejects.toThrow(/响应与请求不一致/);
    expect(chinese.urls).toHaveLength(1);
    expect(chinese.urls[0]!.length).toBeGreaterThan(1000);
  });

  it('gene 引物超预算 → 整块省略并说明，绝不出现半条序列', async () => {
    const run = replay('gene', (data) => {
      const result = data.result as Obj;
      result.primersForward = 'A'.repeat(700);
      result.primersReverse = 'C'.repeat(700);
      result.applicationScope = 'Condition@@'.repeat(30);
    });
    const result = await invokeTool(def('lookup'), { entity: 'gene', id: 'ICG00115-1-EF1a' }, { http: run.ctx.http });
    const raw = result.raw as Obj;
    expect(Number(raw.droppedBlocks)).toBeGreaterThan(0);
    const forward = 'A'.repeat(700);
    const reverse = 'C'.repeat(700);
    // 每条序列：要么完整出现，要么连前缀都不出现——不允许半条
    expect(result.text.includes(forward) || !result.text.includes(forward.slice(0, 40))).toBe(true);
    expect(result.text.includes(reverse) || !result.text.includes(reverse.slice(0, 40))).toBe(true);
    expect(result.text).not.toContain(reverse);
    expect(result.text).toContain('未展示');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });

  it('未知 code 含联系方式时，错误文本不回显该内容', async () => {
    const run = replay('not-found', (data) => {
      data.code = 'ops@example.org';
    });
    let message = '';
    try {
      await def('lookup').run({ entity: 'project', id: 'ICG00115-Pro-1' }, run.ctx);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('未预期的 code');
    expect(message).not.toContain('example.org');
  });

  it('ID 不做 trim 改写：首尾空白在本地拒绝且零请求', async () => {
    const run = replay('species');
    await expect(def('lookup').run({ entity: 'species', id: ' ICG00115' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('lookup').run({ entity: 'species', id: 'ICG00115 ' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('lookup').run({ entity: 'publication', id: ' 24810581' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('lookup').run({ entity: 'species', id: '   ' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(run.urls).toHaveLength(0);
  });

  it('源级 probe：正例通过，空对象/查无/错码/身份不符/latinName 缺失都抛错', () => {
    const good = deepCopy(fixture('species').payload);
    expect(() => validateProbe(good)).not.toThrow();
    expect(() => validateProbe({ code: '200', result: {} })).toThrow(/空对象|accession/);
    expect(() => validateProbe({ code: '300', result: null })).toThrow(/code/);
    expect(() => validateProbe({ code: 200, result: (good as Obj).result })).toThrow(/字符串/);
    const wrongId = deepCopy(good);
    (wrongId.result as Obj).accession = 'ICG99999';
    expect(() => validateProbe(wrongId)).toThrow(/不一致/);
    const noLatin = deepCopy(good);
    delete (noLatin.result as Obj).latinName;
    expect(() => validateProbe(noLatin)).toThrow(/latinName/);
  });
});

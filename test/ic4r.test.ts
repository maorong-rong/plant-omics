import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import { invokeTool } from '../src/core/invoke.js';
import type { Fetcher } from '../src/core/types.js';
import { manifest } from '../src/sources/ic4r/manifest.js';
import { validateProbe } from '../src/sources/ic4r/probe.js';
import { tools } from '../src/sources/ic4r/tools.js';

type Obj = Record<string, unknown>;
interface Capture {
  url: string;
  at: string;
  status: number;
  contentType: string;
  originalBytes: number;
  bodyBytes?: number;
  bodyKind?: 'empty' | 'json';
  simulated?: boolean;
  note?: string;
}
interface Fixture {
  capture: Capture;
  payload?: unknown;
}
function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`../src/sources/ic4r/fixtures/${name}.json`, import.meta.url), 'utf8'));
}
function def(name: string) {
  const tool = tools.find((item) => item.name === `ic4r_${name}`);
  if (!tool) throw new Error(`Missing ic4r_${name}`);
  return tool;
}
function replay(name: string, options: { mutate?: (payload: unknown) => void; bodyKind?: 'empty' | 'json' | null } = {}) {
  const data = fixture(name);
  if (options.mutate && data.payload !== undefined) options.mutate(data.payload);
  const bodyKind = options.bodyKind === undefined ? (data.capture.bodyKind ?? (data.payload === undefined ? 'empty' : 'json')) : options.bodyKind;
  const urls: string[] = [];
  const http: Fetcher = async <T>(url: string) => {
    urls.push(url);
    return {
      data: (data.payload ?? {}) as T,
      url,
      status: data.capture.status,
      contentType: data.capture.contentType,
      durationMs: 6,
      attempts: 1,
      ...(bodyKind === null ? {} : { bodyKind }),
    };
  };
  return { ctx: { http }, urls, data, payload: data.payload };
}
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const BANNED = /全物种|源未提供物种清单|覆盖全部/;

describe('IC4R 五工具契约（离线回放，不联网）', () => {
  it('工具名、参数按 ID 空间分开、T1 manifest 符合契约', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'ic4r_gene',
      'ic4r_annotation',
      'ic4r_circrna',
      'ic4r_lncrna',
      'ic4r_id_convert',
      'ic4r_gene_list',
    ]);
    for (const tool of tools) {
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(50);
    }
    // 基因类用 locus；非编码 RNA 用 accession，且描述写明不是同一 ID 空间
    for (const name of ['gene', 'annotation', 'id_convert']) {
      expect(Object.keys(def(name).parameters.properties ?? {})).toEqual(['locus']);
    }
    for (const name of ['circrna', 'lncrna']) {
      expect(Object.keys(def(name).parameters.properties ?? {})).toEqual(['accession']);
      expect(def(name).description).toContain('不是基因 locus');
    }
    // P2 文案三条一起钉住：gene_list 描述（上游零记录 + 产品层约束）、gene 描述指向 gene_list、caveat 同口径
    expect(def('gene_list').description).toContain('产品层白名单约束');
    expect(def('gene_list').description).toContain('recordsTotal=0');
    expect(def('gene_list').description).toContain('不是上游限制');
    expect(def('gene').description).toContain('按染色体浏览请用 ic4r_gene_list');
    const caveatText = (manifest.caveats ?? []).join('\n');
    expect(caveatText).toContain('产品层白名单约束');
    expect(caveatText).toContain('recordsTotal=0');
    expect(manifest.tier).toBe('T1');
    expect(manifest.docs).toBe('https://ngdc.cncb.ac.cn/ic4r/api');
    expect(manifest.apiBase).toBe('https://ngdc.cncb.ac.cn/ic4r/api/json');
    expect(manifest.probe.path).toBe('/gene/IC4R-OSJ01G000600');
    expect(manifest.lastProbe?.date).toBe('2026-10-28');
    expect(manifest.species).toEqual(['Oryza sativa']);
    for (const caveat of manifest.caveats ?? []) expect(caveat).not.toMatch(BANNED);
    expect((manifest.caveats ?? []).join('\n')).toContain('无法确认是否存在');
  });

  it('gene 正例：1 次请求、身份对账、字段与出处、raw 为白名单投影', async () => {
    const run = replay('gene');
    const result = await invokeTool(def('gene'), { locus: 'IC4R-OSJ01G000600' }, { http: run.ctx.http });
    expect(run.urls).toHaveLength(1);
    expect(run.urls[0]).toBe('https://ngdc.cncb.ac.cn/ic4r/api/json/gene/IC4R-OSJ01G000600');
    expect(result.text).toContain('40S Ribosomal Protein S5');
    expect(result.text).toContain('LOC_Os01g01060');
    expect(result.text).toContain('Os01g0100700');
    expect(result.text).toContain(`GET ${run.urls[0]}`);
    expect(result.text).toContain('HTTP 200');
    expect(result.text).toContain('6 ms');
    expect(result.text).toContain(result.meta.at);
    expect(result.text).toContain('2018-');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
    const raw = result.raw as Obj;
    expect(raw.locus).toBe('IC4R-OSJ01G000600');
    expect(raw).not.toHaveProperty('synonym');
  });

  it('annotation 正例：按类别分组、每组最多 2 条、报本次返回条数与类别数', async () => {
    const run = replay('annotation');
    const result = await invokeTool(def('annotation'), { locus: 'IC4R-OSJ01G000600' }, { http: run.ctx.http });
    expect(result.text).toContain('本次返回 8 条');
    expect(result.text).toContain('5 个类别');
    expect(result.text).toContain('【InterPro】4 条');
    expect(result.text).toContain('另有 2 条未展示');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
    const raw = result.raw as Obj;
    expect(raw.returned).toBe(8);
    expect(raw.categoryCount).toBe(5);
  });

  it('annotation 的 [] = 本次未返回注释，不判不存在', async () => {
    const run = replay('annotation-empty');
    const result = await invokeTool(def('annotation'), { locus: 'IC4R-OSJ01G999999' }, { http: run.ctx.http });
    expect(result.text).toContain('本次未返回功能注释');
    expect(result.text).toContain('不表示该基因没有注释');
    expect(result.text).not.toContain('不存在');
  });

  it('annotation 返回对象 → 结构漂移（模拟反例）', async () => {
    const run = replay('annotation-object');
    expect(run.data.capture.simulated).toBe(true);
    await expect(def('annotation').run({ locus: 'IC4R-OSJ01G000600' }, run.ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('circRNA 正例：真实 182 bp 序列必须完整出现（V13）', async () => {
    const run = replay('circrna');
    const result = await invokeTool(def('circrna'), { accession: 'IC4R-OSJ01Circ057100' }, { http: run.ctx.http });
    const sequence = (run.payload as Obj).sequence as string;
    expect(sequence.length).toBe(182);
    expect(result.text).toContain(sequence);
    expect(result.text).toContain('序列（182 bp）');
    expect(result.text).toContain('Calreticulin Precursor Protein');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });

  it('lncRNA 正例：1,639 bp 序列因预算整条不展示，且明确不是“上游没有序列”', async () => {
    const run = replay('lncrna');
    const result = await invokeTool(def('lncrna'), { accession: 'IC4R-OSJ01Lnc000600.1' }, { http: run.ctx.http });
    const sequence = (run.payload as Obj).sequence as string;
    expect(sequence.length).toBe(1639);
    expect(result.text).toContain('1639 bp');
    expect(result.text).toContain('整条未展示');
    expect(result.text).toContain('不是上游没有序列');
    expect(result.text).not.toContain(sequence.slice(0, 200));
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
    const raw = result.raw as Obj;
    expect(raw.sequenceLength).toBe(1639);
    expect(raw.sequenceShown).toBe(false);
  });

  it('idConversion 正例：只承诺已测方向', async () => {
    const run = replay('id-conversion');
    const result = await invokeTool(def('id_convert'), { locus: 'IC4R-OSJ01G000600' }, { http: run.ctx.http });
    expect(result.text).toContain('LOC_Os01g01060');
    expect(result.text).toContain('Os01g0100700');
    expect(result.text).toContain('反向映射未测');
  });

  it('空响应（bodyKind=empty）→ 报“无法确认”，不判不存在、不抛错（V2）', async () => {
    const run = replay('gene-empty');
    const result = await invokeTool(def('gene'), { locus: 'IC4R-OSJ01G999999' }, { http: run.ctx.http });
    expect(result.text).toContain('HTTP 200、0 字节');
    expect(result.text).toContain('无法确认');
    expect(result.text).not.toContain('未找到');
    expect(result.text).not.toContain('不存在');
    expect(result.raw).toEqual({ kind: 'empty', bodyBytes: 0 });
  });

  it('真实 JSON 空对象（bodyKind=json）→ 结构漂移，不解释为查无（V3）', async () => {
    const run = replay('gene-empty-object');
    await expect(def('gene').run({ locus: 'IC4R-OSJ01G000600' }, run.ctx)).rejects.toThrow(/空对象/);
  });

  it('bodyKind 缺失且正文 {} → 响应类型未知，不判查无也不判正常（V6）', async () => {
    const run = replay('gene', { mutate: () => undefined, bodyKind: null });
    // 用真实空对象 + 缺 bodyKind 的组合表达“类型未知”
    const empty: Fetcher = async <T>(url: string) => ({ data: {} as T, url, status: 200, contentType: 'application/json', durationMs: 3, attempts: 1 });
    void run;
    const result = await invokeTool(def('gene'), { locus: 'IC4R-OSJ01G000600' }, { http: empty });
    expect(result.text).toContain('响应类型未知（bodyKind 缺失）');
    expect(result.text).not.toContain('0 字节');
    expect(result.text).toContain('无法确认');
  });

  it('单对象端点返回数组 → 结构漂移', async () => {
    const run = replay('gene', { mutate: () => undefined });
    const arrayFetcher: Fetcher = async <T>(url: string) => ({ data: [{}] as unknown as T, url, status: 200, contentType: 'application/json', durationMs: 3, attempts: 1, bodyKind: 'json' });
    void run;
    await expect(def('gene').run({ locus: 'IC4R-OSJ01G000600' }, { http: arrayFetcher })).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('上游 404 → UpstreamError，不当业务空结果（V7）', async () => {
    const notFound: Fetcher = async <T>(url: string) => {
      void url;
      throw new UpstreamError('上游404 HTML兜底：未找到或路径不支持，无法据此判断基因是否存在', { url, status: 404, contentType: 'text/html' });
    };
    await expect(def('gene').run({ locus: 'IC4R-OSJ01G000600' }, { http: notFound })).rejects.toBeInstanceOf(UpstreamError);
  });

  it('长序列（5,000 bp 构造）整条省略，不出现半条（V9）', async () => {
    const run = replay('circrna', {
      mutate: (payload) => {
        (payload as Obj).sequence = 'A'.repeat(5000);
      },
    });
    const result = await invokeTool(def('circrna'), { accession: 'IC4R-OSJ01Circ057100' }, { http: run.ctx.http });
    expect(result.text).toContain('整条未展示');
    expect(result.text).not.toContain('A'.repeat(100));
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });

  it('annotation 分组块预算：放不下的整组省略，末尾报告类别数', async () => {
    const run = replay('annotation', {
      mutate: (payload) => {
        const rows = payload as Obj[];
        const template = rows[0]!;
        const expanded: Obj[] = [];
        for (let index = 0; index < 12; index += 1) {
          expanded.push({ ...template, functionalCategory: `CATEGORY_${index}_${'x'.repeat(80)}`, functionalId: `ID_${index}`, description: 'y'.repeat(120) });
        }
        rows.length = 0;
        rows.push(...expanded);
      },
    });
    const result = await invokeTool(def('annotation'), { locus: 'IC4R-OSJ01G000600' }, { http: run.ctx.http });
    expect(result.text).toContain('12 个类别');
    expect(result.text).toContain('整组省略');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
    const raw = result.raw as Obj;
    expect(Number(raw.droppedCategories)).toBeGreaterThan(0);
  });

  it('ID 校验：不改写输入、拒绝首尾空白/控制字符/点段/超长，且零请求（V8）', async () => {
    const run = replay('gene');
    for (const bad of ['', '   ', ' IC4R-OSJ01G000600', 'IC4R-OSJ01G000600 ', '.', '..', 'a\nb', 'a'.repeat(129)]) {
      await expect(def('gene').run({ locus: bad }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    expect(run.urls).toHaveLength(0);
  });

  it('128 码点中文通过长度检查（完整请求 1198 B 级别能进预算），128 emoji 被共享预算拒绝（V10）', async () => {
    const chinese = replay('gene');
    await expect(def('gene').run({ locus: '中'.repeat(128) }, chinese.ctx)).rejects.toThrow(/响应与请求不一致/);
    expect(chinese.urls).toHaveLength(1);

    const emoji = replay('gene');
    await expect(def('gene').run({ locus: '😀'.repeat(128) }, emoji.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(emoji.urls).toHaveLength(0);
  });

  it('源级 probe：正例通过，身份不符/空对象/数组/缺字段都抛错（V11）', () => {
    const good = deepCopy(fixture('gene').payload) as Obj;
    expect(() => validateProbe(good)).not.toThrow();
    expect(() => validateProbe({ ...good, locus: 'IC4R-OSJ01G999999' })).toThrow(/不一致/);
    expect(() => validateProbe({})).toThrow(/locus/);
    expect(() => validateProbe([])).toThrow(/非数组对象/);
    const noChromosome = deepCopy(good);
    delete noChromosome.chromosome;
    expect(() => validateProbe(noChromosome)).toThrow(/chromosome/);
  });

  it('gene_list 正例：1 次请求、recordsTotal 与本次返回分开报、locus 可用（ID 发现入口）', async () => {
    const run = replay('gene-list');
    const result = await invokeTool(def('gene_list'), { chromosome: '1', start: 0, length: 2 }, { http: run.ctx.http });
    expect(run.urls).toHaveLength(1);
    expect(run.urls[0]).toBe('https://ngdc.cncb.ac.cn/ic4r/genes/view?chromosome=1&draw=1&start=0&length=2');
    expect(result.text).toContain('上游 recordsTotal=6534');
    expect(result.text).toContain('recordsFiltered=6534');
    expect(result.text).toContain('本次返回 2 条');
    expect(result.text).toContain('IC4R-OSJ01G000100');
    expect(result.text).toContain('ic4r_gene');
    expect(result.text).not.toContain('共 6534');
    const raw = result.raw as Obj;
    expect(raw.recordsTotal).toBe(6534);
    expect(raw.returned).toBe(2);
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });

  it('gene_list：Sy 染色体可用（recordsTotal=140），不是只限 1–12', async () => {
    const run = replay('gene-list-sy');
    const result = await invokeTool(def('gene_list'), { chromosome: 'Sy', start: 0, length: 2 }, { http: run.ctx.http });
    expect(result.text).toContain('上游 recordsTotal=140');
    expect(result.text).toContain('IC4R-OSJSyG000100');
  });

  it('gene_list：recordsTotal=0（模拟：真实件里没有合法染色体为 0 的样本）→ 报“上游记录数为 0”', async () => {
    const run = replay('gene-list-empty');
    // 合法染色体已由白名单保证，这里用 chr1 的真实结构改造成 0 记录，标注为模拟
    const mutate = replay('gene-list', {
      mutate: (payload) => {
        const envelope = payload as Obj;
        envelope.recordsTotal = 0;
        envelope.recordsFiltered = 0;
        envelope.data = [];
      },
    });
    expect(Array.isArray(run.payload)).toBe(false);
    const result = await invokeTool(def('gene_list'), { chromosome: '1', start: 0, length: 2 }, { http: mutate.ctx.http });
    expect(result.text).toContain('上游 recordsTotal=0');
    expect(result.text).toContain('上游记录数为 0');
    expect(result.text).toContain('1–12、Sy、Un');
    expect(result.raw).toMatchObject({ recordsTotal: 0, returned: 0 });
  });

  it('gene_list：start 越过末页 → 报“分页越界”，不当“无基因”（模拟）', async () => {
    const run = replay('gene-list', {
      mutate: (payload) => {
        (payload as Obj).data = [];
      },
    });
    const result = await invokeTool(def('gene_list'), { chromosome: '1', start: 7000, length: 2 }, { http: run.ctx.http });
    expect(result.text).toContain('已越过末页');
    expect(result.text).toContain('recordsTotal=6534');
    expect(result.text).not.toContain('没有基因');
  });

  it('gene_list：data 为空但 start 在范围内 → 未测形态，按结构漂移（模拟）', async () => {
    const run = replay('gene-list', {
      mutate: (payload) => {
        (payload as Obj).data = [];
      },
    });
    await expect(def('gene_list').run({ chromosome: '1', start: 0 }, run.ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('gene_list：单元素数组包裹 → 显式解包并记录信封形态（防御性，非本仓实测）', async () => {
    const run = replay('gene-list-array-wrap');
    expect(run.data.capture.simulated).toBe(true);
    const result = await invokeTool(def('gene_list'), { chromosome: '1', start: 0, length: 2 }, { http: run.ctx.http });
    expect(result.text).toContain('上游 recordsTotal=6534');
    expect(result.text).toContain('IC4R-OSJ01G000100');
    expect((result.raw as Obj).envelopeForm).toBe('array-wrap');
  });

  it('gene_list：多元素数组 / null 信封 → 结构漂移，不静默归一', async () => {
    const twoElements: Fetcher = async <T>(url: string) => ({
      data: [{ draw: 1, recordsTotal: 0, recordsFiltered: 0, data: [], error: null }, { draw: 2 }] as unknown as T,
      url,
      status: 200,
      contentType: 'application/json',
      durationMs: 3,
      attempts: 1,
      bodyKind: 'json',
    });
    await expect(def('gene_list').run({ chromosome: '1' }, { http: twoElements })).rejects.toBeInstanceOf(UpstreamShapeError);

    const nullEnvelope: Fetcher = async <T>(url: string) => ({
      data: null as unknown as T,
      url,
      status: 200,
      contentType: 'application/json',
      durationMs: 3,
      attempts: 1,
      bodyKind: 'json',
    });
    await expect(def('gene_list').run({ chromosome: '1' }, { http: nullEnvelope })).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('gene_list 参数：chromosome 空白/保留字符/超长、start 与 length 越界 → 本地拒绝且零请求', async () => {
    const run = replay('gene-list');
    for (const bad of [{ chromosome: '' }, { chromosome: '   ' }, { chromosome: ' 1' }, { chromosome: '99' }, { chromosome: '13' }, { chromosome: 'sy' }, { chromosome: 'a?b' }]) {
      await expect(def('gene_list').run(bad, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    // 拒绝时必须列出合法取值
    await expect(def('gene_list').run({ chromosome: '99' }, run.ctx)).rejects.toThrow(/1、2、3、4、5、6、7、8、9、10、11、12、Sy、Un/);
    await expect(def('gene_list').run({ chromosome: '1', start: -1 }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('gene_list').run({ chromosome: '1', start: 1_000_001 }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('gene_list').run({ chromosome: '1', length: 0 }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('gene_list').run({ chromosome: '1', length: 51 }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(run.urls).toHaveLength(0);
  });

  it('gene_list：行数超预算时逐行裁剪并报告展示数（不虚报返回数）', async () => {
    const run = replay('gene-list', {
      mutate: (payload) => {
        const envelope = payload as Obj;
        const template = (envelope.data as Obj[])[0]!;
        const rows: Obj[] = [];
        for (let index = 0; index < 50; index += 1) {
          rows.push({ ...template, locus: `IC4R-OSJ01G${String(900000 + index)}`, description: 'x'.repeat(60) });
        }
        envelope.data = rows;
        envelope.recordsTotal = 6534;
      },
    });
    const result = await invokeTool(def('gene_list'), { chromosome: '1', length: 50 }, { http: run.ctx.http });
    const raw = result.raw as Obj;
    expect(raw.returned).toBe(50);
    expect(Number(raw.shown)).toBeLessThan(50);
    expect(Number(raw.shown)).toBeGreaterThan(0);
    expect(result.text).toContain(`实际展示 ${String(raw.shown)} 条`);
    expect(result.text).toContain('另有');
    expect(result.text).not.toMatch(/共 \d+ 条/);
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });

  it('fixture 隐私：全部非 simulated 真实件递归无邮箱（V12）', () => {
    const dir = new URL('../src/sources/ic4r/fixtures/', import.meta.url);
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    const hits: string[] = [];
    let realFiles = 0;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const data = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Fixture;
      if (data.capture.simulated === true) continue;
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
          for (const [key, item] of Object.entries(value as Obj)) walk(item, `${path}.${key}`);
        }
      };
      walk(data.payload, 'payload');
    }
    expect(realFiles).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });
});

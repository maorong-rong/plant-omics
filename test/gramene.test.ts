import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, UpstreamError, UpstreamShapeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import { invokeTool } from '../src/core/invoke.js';
import type { Fetcher } from '../src/core/types.js';
import { manifest } from '../src/sources/gramene/manifest.js';
import { validateProbe } from '../src/sources/gramene/probe.js';
import { tools } from '../src/sources/gramene/tools.js';

type Obj = Record<string, unknown>;
interface Capture {
  url: string;
  at: string;
  status: number;
  contentType?: string;
  originalBytes: number;
  trimmed?: string;
  simulated?: boolean;
  note?: string;
}
function fixture(name: string): { capture: Capture; payload: unknown } {
  return JSON.parse(readFileSync(new URL(`../src/sources/gramene/fixtures/${name}.json`, import.meta.url), 'utf8'));
}
function def(name: string) {
  const tool = tools.find((item) => item.name === `gramene_${name}`);
  if (!tool) throw new Error(`Missing gramene_${name}`);
  return tool;
}
function replay(name: string, options: { mutate?: (payload: unknown) => void; status?: number } = {}) {
  const data = fixture(name);
  if (options.mutate) options.mutate(data.payload);
  const urls: string[] = [];
  const http: Fetcher = async <T>(url: string) => {
    urls.push(url);
    return {
      data: data.payload as T,
      url,
      status: options.status ?? 200,
      contentType: data.capture.contentType ?? 'application/json',
      durationMs: 9,
      attempts: 1,
      bodyKind: 'json',
    };
  };
  return { ctx: { http }, urls, data };
}
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const BANNED = /全物种|源未提供物种清单|覆盖全部|覆盖禾本科/;

describe('Gramene 四工具契约（离线回放，不联网）', () => {
  it('工具名、参数形状与 T1 manifest 符合契约', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'gramene_search',
      'gramene_gene',
      'gramene_expression',
      'gramene_taxonomy',
    ]);
    for (const tool of tools) {
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(50);
    }
    expect(Object.keys(def('search').parameters.properties ?? {})).toEqual(['q', 'rows', 'start']);
    for (const name of ['gene', 'expression', 'taxonomy']) {
      expect(Object.keys(def(name).parameters.properties ?? {})).toEqual(['ids']);
    }
    expect(manifest.tier).toBe('T1');
    expect(manifest.docs).toBe('https://data.gramene.org/v69/swagger');
    expect(manifest.apiBase).toBe('https://data.gramene.org/v69');
    expect(manifest.probe.path).toBe('/genes?idList=BGIOSGA001967');
    expect(manifest.species).toEqual(['Oryza sativa', 'Oryza sativa Indica Group']);
    for (const caveat of manifest.caveats ?? []) expect(caveat).not.toMatch(BANNED);
    expect((manifest.caveats ?? []).join('\n')).toContain('不把覆盖范围外推到整个禾本科');
  });

  it('search 正例：text/plain 正文按 JSON 解析，numFound 与本次返回分开报', async () => {
    const run = replay('search');
    expect(run.data.capture.contentType).toBe('text/plain');
    const result = await invokeTool(def('search'), { q: 'Oryza', rows: 2 }, { http: run.ctx.http });
    expect(run.urls[0]).toBe('https://data.gramene.org/v69/search?q=Oryza&rows=2&start=0');
    expect(result.text).toContain('上游 numFound=87462');
    expect(result.text).toContain('本次返回 2 条');
    expect(result.text).not.toMatch(/共 87462 条/);
    expect(result.text).toContain('BGIOSGA001967');
    expect(result.text).toContain('不声称覆盖全部禾本科');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
    expect((result.raw as Obj).numFound).toBe(87462);
  });

  it('search 查无：numFound=0 是合法空结果，不报错', async () => {
    const run = replay('search-empty');
    const result = await invokeTool(def('search'), { q: 'NOT_A_REAL_THING_XYZ', rows: 2 }, { http: run.ctx.http });
    expect(result.text).toContain('上游 numFound=0');
    expect(result.text).toContain('本次没有匹配结果');
    expect(result.text).not.toContain('上游错误');
  });

  it('search 结构漂移：缺少 response / docs 非数组 → 结构错误', async () => {
    const noResponse = replay('search', {
      mutate: (payload) => {
        delete (payload as Obj).response;
      },
    });
    await expect(def('search').run({ q: 'Oryza' }, noResponse.ctx)).rejects.toBeInstanceOf(UpstreamShapeError);

    const badDocs = replay('search', {
      mutate: (payload) => {
        ((payload as Obj).response as Obj).docs = 'x';
      },
    });
    await expect(def('search').run({ q: 'Oryza' }, badDocs.ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('gene 正例：请求发 idList、输出裁剪字段且不含 xrefs', async () => {
    const run = replay('genes');
    const result = await invokeTool(def('gene'), { ids: 'BGIOSGA001967' }, { http: run.ctx.http });
    expect(run.urls[0]).toBe('https://data.gramene.org/v69/genes?idList=BGIOSGA001967&idList=BGIOSGA001967');
    expect(result.text).toContain('BGIOSGA001967');
    expect(result.text).toContain('protein_coding');
    expect(result.text).toContain('oryza_indica');
    expect(result.text).toContain('本次返回 1 条');
    expect(result.text).not.toContain('BGI_EST_Cluster');
    expect(result.raw).not.toHaveProperty('xrefs');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });

  it('单个字符串 ID 也按数组语义重复发送（不靠“字符串能过”的巧合）', async () => {
    const run = replay('genes');
    const result = await invokeTool(def('gene'), { ids: 'BGIOSGA001967' }, { http: run.ctx.http });
    const params = new URL(run.urls[0]).searchParams.getAll('idList');
    expect(params).toEqual(['BGIOSGA001967', 'BGIOSGA001967']);
    expect((result.raw as Obj).duplicatedForNumericSingle).toBe(true);
    expect((result.raw as Obj).returned).toBe(1);
  });

  it('text/plain 但正文不是 JSON → 结构漂移，不当空结果', async () => {
    const htmlFetcher: Fetcher = async <T>(url: string) => ({
      data: '<html>not json</html>' as unknown as T,
      url,
      status: 200,
      contentType: 'text/plain',
      durationMs: 3,
      attempts: 1,
      bodyKind: 'json',
    });
    await expect(def('search').run({ q: 'Oryza' }, { http: htmlFetcher })).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('空结果的正文都写明“本次返回 0 条”', async () => {
    for (const [name, args, httpName] of [
      ['gene', { ids: 'NOT_A_REAL_ID' }, 'genes-empty'],
      ['expression', { ids: 'NOT_A_REAL_ID' }, 'expression-empty'],
    ] as const) {
      const run = replay(httpName);
      const result = await invokeTool(def(name), args, { http: run.ctx.http });
      expect(result.text).toContain('本次返回 0 条');
    }
  });

  it('gene 数值型单 ID → 重复一次发送（规避上游校验器），并按 _id 去重', async () => {
    const run = replay('genes', {
      mutate: (payload) => {
        (payload as Obj[])[0]!._id = '12345';
      },
    });
    const result = await invokeTool(def('gene'), { ids: '12345' }, { http: run.ctx.http });
    expect(run.urls[0]).toContain('idList=12345&idList=12345');
    expect(result.text).toContain('重复发送一次');
    expect((result.raw as Obj).duplicatedForNumericSingle).toBe(true);
  });

  it('gene 多个 ID → 每个一个 idList 参数', async () => {
    const run = replay('genes');
    void invokeTool(def('gene'), { ids: 'A1,B2' }, { http: run.ctx.http }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run.urls[0]).toContain('idList=A1&idList=B2');
  });

  it('gene 查无：空数组 → 说“本次未返回”，不断言 ID 不存在', async () => {
    const run = replay('genes-empty');
    const result = await invokeTool(def('gene'), { ids: 'NOT_A_REAL_ID' }, { http: run.ctx.http });
    expect(result.text).toContain('本次未返回基因记录');
    expect(result.text).toContain('不能断言该 ID 不存在');
  });

  it('gene 结构漂移：返回对象而非数组 → 结构错误', async () => {
    const run = replay('genes', { mutate: () => undefined });
    const objectFetcher: Fetcher = async <T>(url: string) => ({ data: {} as T, url, status: 200, contentType: 'application/json', durationMs: 3, attempts: 1, bodyKind: 'json' });
    void run;
    await expect(def('gene').run({ ids: 'BGIOSGA001967' }, { http: objectFetcher })).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('expression 正例：按实验展示 p_value/l2fc，注明不做显著性判定', async () => {
    const run = replay('expression');
    const result = await invokeTool(def('expression'), { ids: 'BGIOSGA001967' }, { http: run.ctx.http });
    expect(result.text).toContain('E-GEOD-116422');
    expect(result.text).toContain('p_value');
    expect(result.text).toContain('l2fc');
    expect(result.text).toContain('不做显著性判定');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });

  it('expression 查无：空数组 → 本次未返回表达记录', async () => {
    const run = replay('expression-empty');
    const result = await invokeTool(def('expression'), { ids: 'NOT_A_REAL_ID' }, { http: run.ctx.http });
    expect(result.text).toContain('本次未返回表达记录');
  });

  it('expression 结构漂移：实验值不是数组 → 结构错误', async () => {
    const run = replay('expression', {
      mutate: (payload) => {
        const doc = (payload as Obj[])[0]!;
        doc['E-GEOD-116422'] = { not: 'array' };
      },
    });
    await expect(def('expression').run({ ids: 'BGIOSGA001967' }, run.ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('taxonomy 正例：多 ID 用重复参数，输出名称/rank/基因数/祖先链长度', async () => {
    const run = replay('taxonomy');
    const result = await invokeTool(def('taxonomy'), { ids: '39946001,4530' }, { http: run.ctx.http });
    expect(run.urls[0]).toContain('idList=39946001&idList=4530');
    expect(result.text).toContain('Oryza sativa');
    expect(result.text).toContain('species');
    expect(result.text).toContain('639732');
    expect(result.text).toContain('祖先链长度');
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(4096);
  });

  it('taxonomy 数值型单 ID：重复一次发送，响应 1 条不重复展示', async () => {
    const run = replay('taxonomy-dup-single');
    const result = await invokeTool(def('taxonomy'), { ids: '4530' }, { http: run.ctx.http });
    expect(run.urls[0]).toContain('idList=4530&idList=4530');
    expect(result.text).toContain('重复发送一次');
    expect((result.raw as Obj).returned).toBe(1);
    expect(result.text.match(/- 4530｜/g)?.length).toBe(1);
  });

  it('taxonomy 前导零 taxid 按数值归一，不会被身份对账误判', async () => {
    const run = replay('taxonomy-dup-single');
    const result = await invokeTool(def('taxonomy'), { ids: '04530' }, { http: run.ctx.http });
    const params = new URL(run.urls[0]).searchParams.getAll('idList');
    expect(params).toEqual(['4530', '4530']);
    expect(result.text).toContain('本次返回 1 条');
    expect((result.raw as Obj).missingIds).toEqual([]);
  });

  it('search：首行就放不进正文时 shown=0，尾部“另有 N 条”不少算也不多算', async () => {
    const run = replay('search', {
      mutate: (payload) => {
        const response = (payload as Obj).response as Obj;
        const template = (response.docs as Obj[])[0]!;
        response.docs = [
          { ...template, name: 'x'.repeat(2000) },
          { ...template, name: 'y'.repeat(2000) },
        ];
      },
    });
    const result = await invokeTool(def('search'), { q: 'Oryza', rows: 2 }, { http: run.ctx.http });
    const raw = result.raw as Obj;
    expect(raw.shown).toBe(0);
    expect(result.text).toContain('另有 2 条本次未展示');
    expect(result.text).not.toContain('另有 -1');
  });

  it('taxonomy 非数字 taxid → 本地拒绝且零请求（上游只实测数字型）', async () => {
    const run = replay('taxonomy');
    await expect(def('taxonomy').run({ ids: 'Oryza sativa' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(run.urls).toHaveLength(0);
  });

  it('taxonomy 查无：空数组 → 本次未返回分类单元记录', async () => {
    const run = replay('genes-empty');
    const result = await invokeTool(def('taxonomy'), { ids: '999999' }, { http: run.ctx.http });
    expect(result.text).toContain('本次未返回分类单元记录');
  });

  it('search：numFound>0 但 start 越过末页 → 报“分页越界”，不写成 numFound=0', async () => {
    const run = replay('search', {
      mutate: (payload) => {
        ((payload as Obj).response as Obj).docs = [];
      },
    });
    const result = await invokeTool(def('search'), { q: 'Oryza', rows: 2, start: 90000 }, { http: run.ctx.http });
    expect(result.text).toContain('已越过末页');
    expect(result.text).toContain('numFound=87462');
    expect(result.text).not.toContain('numFound=0');
  });

  it('search：docs 为空但 start 在范围内 → 未测形态，按结构漂移', async () => {
    const run = replay('search', {
      mutate: (payload) => {
        ((payload as Obj).response as Obj).docs = [];
      },
    });
    await expect(def('search').run({ q: 'Oryza', rows: 2, start: 0 }, run.ctx)).rejects.toBeInstanceOf(UpstreamShapeError);
  });

  it('gene：返回的 _id 不在请求集合内 → 身份不符，抛错', async () => {
    const run = replay('genes', {
      mutate: (payload) => {
        (payload as Obj[])[0]!._id = 'SOME_OTHER_GENE';
      },
    });
    await expect(def('gene').run({ ids: 'BGIOSGA001967' }, run.ctx)).rejects.toThrow(/身份不符[\s\S]*请检查 ID 的大小写与形式/);
  });

  it('gene：部分请求 ID 未返回 → 逐个列出，不把无关记录当结果', async () => {
    const run = replay('genes');
    const result = await invokeTool(def('gene'), { ids: 'BGIOSGA001967,OTHER_GENE' }, { http: run.ctx.http });
    expect(result.text).toContain('未返回的 ID');
    expect(result.text).toContain('OTHER_GENE');
    expect(result.text).toContain('本次返回 1 条');
    expect((result.raw as Obj).missingIds).toEqual(['OTHER_GENE']);
  });

  it('上游 400 校验错误 → UpstreamError，不折成空结果', async () => {
    const run = replay('taxonomy-single-numeric-error', { status: 400 });
    await expect(def('taxonomy').run({ ids: '4530' }, run.ctx)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('ids 参数：空、首尾空白、控制字符、超过 10 个 → 本地拒绝且零请求', async () => {
    const run = replay('genes');
    for (const bad of ['', '  ', ' A1', 'A1 ', 'A1\nB2']) {
      await expect(def('gene').run({ ids: bad }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    await expect(def('gene').run({ ids: Array.from({ length: 11 }, (_, index) => `ID${index}`).join(',') }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(run.urls).toHaveLength(0);
  });

  it('search 参数：空 q、首尾空白、控制字符、rows/start 越界 → 本地拒绝且零请求', async () => {
    const run = replay('search');
    await expect(def('search').run({ q: '' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('search').run({ q: ' Oryza' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('search').run({ q: 'a\nb' }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('search').run({ q: 'Oryza', rows: 0 }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('search').run({ q: 'Oryza', rows: 51 }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(def('search').run({ q: 'Oryza', start: -1 }, run.ctx)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(run.urls).toHaveLength(0);
  });

  it('源级 probe：正例通过；空数组、_id 不符、非数组都抛错', () => {
    const good = deepCopy(fixture('genes').payload) as Obj[];
    expect(() => validateProbe(good)).not.toThrow();
    expect(() => validateProbe([])).toThrow(/空数组/);
    const wrong = deepCopy(good);
    wrong[0]!._id = 'OTHER';
    expect(() => validateProbe(wrong)).toThrow(/不一致/);
    expect(() => validateProbe({})).toThrow(/数组/);
  });

  it('fixture 隐私：全部非 simulated 真实件递归无邮箱', () => {
    const dir = new URL('../src/sources/gramene/fixtures/', import.meta.url);
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    const hits: string[] = [];
    let realFiles = 0;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const data = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as { capture: Capture; payload?: unknown };
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

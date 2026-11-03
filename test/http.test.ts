import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { describeError } from '../src/core/errors.js';
import { utf8Bytes } from '../src/core/format.js';
import { RAW_BODY_LIMIT_BYTES, createFetcher, retryDelayMs } from '../src/core/http.js';
import type { HttpResult } from '../src/core/types.js';

/**
 * 用 TypeScript AST 扫"到底有哪些地方在读响应头"。
 *
 * 为什么不用正则（R12-C2 实测）：正则既**看不见**合法写法 `res.headers?.["x-…"]`
 * （可选链里的点被漏掉），又会**误报**注释里的 `// headers["x-…"]`——
 * 一头漏一头多，两个方向都能让白名单闸门失灵。AST 天然不含注释，
 * 也让"不是字面量的头名"能被单独抓出来（不许静默漏）。
 */
interface HeaderReads { names: string[]; dynamic: string[] }

function scanHeaderReads(fileName: string, text: string): HeaderReads {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const names = new Set<string>();
  const dynamic: string[] = [];
  const add = (raw: string): void => {
    const name = raw.toLowerCase();
    if (name.startsWith('x-')) names.add(name);
  };
  const literal = (node: ts.Node | undefined): string | null => {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return null;
  };
  const noteDynamic = (node: ts.Node): void => { dynamic.push(node.getText(sf).slice(0, 100)); };
  /** 类型位置里的 `headers`（如 `res: { headers?: Record<string,string> }`）不是读取，别误报。 */
  const inTypeContext = (node: ts.Node): boolean => {
    for (let cursor: ts.Node | undefined = node.parent; cursor; cursor = cursor.parent) {
      if (ts.isTypeNode(cursor)) return true;
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    // ① 调用形式：header(res, 'x-…')；第二参不是字面量就记动态——
    //    `header(res, key)` 是已支持调用模式里的失败关闭缺口（R12 二轮实测）。
    //    只认**两参及以上**：源层里还有同名的本地排版助手 `header(0)` / `header(title)`，
    //    那是标题渲染，不是读响应头（实测误报，2026-11-03）。
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'header'
      && node.arguments.length >= 2) {
      const name = literal(node.arguments[1]);
      if (name !== null) add(name);
      else noteDynamic(node);
    }

    // ② headers 容器的**任何**用法：只有"字面量下标直接取名"算正常读取，其余一律记动态。
    //    这一条是"拒绝而不是猜"：别名（const h = res.headers）、对象解构
    //    （const { 'x-…': v } = res.headers）、遍历（Object.entries(res.headers)）、
    //    方法调用、当值传出去——全都静态核不了白名单，必须报出来而不是静默漏。
    //    容器有三种写法：`res.headers`、`res["headers"]`、裸 `headers`（参数或解构所得）。
    if (!inTypeContext(node)) {
      const isHeadersProperty =
        ts.isPropertyAccessExpression(node) && node.name.getText(sf) === 'headers';
      const isHeadersIndex =
        ts.isElementAccessExpression(node) && literal(node.argumentExpression) === 'headers';
      const isBareHeaders =
        ts.isIdentifier(node) && node.text === 'headers'
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node);

      const container = isHeadersProperty || isHeadersIndex || isBareHeaders;
      if (container) {
        const parent = node.parent;
        // 容器外面再套一个「字面量下标」才是读头：res.headers['x-a']、res["headers"]["x-a"]
        if (ts.isElementAccessExpression(parent) && parent.expression === node) {
          const name = literal(parent.argumentExpression);
          if (name !== null) add(name);
          else noteDynamic(parent);
        } else {
          noteDynamic(node);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { names: [...names], dynamic };
}

/**
 * HTTP 层的单元测试。
 *
 * 审查 R08 点名的空白：这个文件是全仓最容易出错的（重试/超时/取消/限流），
 * 却一行测试都没有。下面每条都对应一个**具体会误导用户的行为**。
 */

const response = (status: number, body = '{}', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

describe('retryDelayMs（纯函数，避免用墙钟断言延迟）', () => {
  it('无 Retry-After 时用确定性退避：第 1 次 400 ms，第 2 次 1200 ms', () => {
    expect(retryDelayMs(1)).toBe(400);
    expect(retryDelayMs(2)).toBe(1_200);
    expect(retryDelayMs(3)).toBe(1_200); // 封顶
  });

  it('429/503 优先服从 Retry-After（秒 → 毫秒）', () => {
    expect(retryDelayMs(1, 429, '2')).toBe(2_000);
    expect(retryDelayMs(1, 503, '1')).toBe(1_000);
  });

  it('Retry-After 再长也不超过 10 s 上限（否则一次工具调用能挂死会话）', () => {
    expect(retryDelayMs(1, 429, '60')).toBe(10_000);
  });

  it('非 429/503 时忽略 Retry-After', () => {
    expect(retryDelayMs(1, 500, '30')).toBe(400);
  });
});

describe('createFetcher', () => {
  it('5xx 会重试，成功后返回真实尝试次数', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 3 ? response(503, 'down') : response(200, '{"ok":true}');
    }) as unknown as typeof fetch;

    const fetchJson = createFetcher({ timeoutMs: 500, retries: 2 }, fetchImpl);
    const result = await fetchJson<{ ok: boolean }>('https://example.org/x');

    expect(result.status).toBe(200);
    expect(result.data.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it('4xx 不重试：只发一次请求就抛', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(404, 'not found');
    }) as unknown as typeof fetch;

    const fetchJson = createFetcher({ timeoutMs: 500, retries: 2 }, fetchImpl);
    await expect(fetchJson('https://example.org/x')).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it('超时抛「上游请求超时」，不是「无法连接」', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    const fetchJson = createFetcher({ timeoutMs: 30, retries: 0 }, fetchImpl);
    await expect(fetchJson('https://example.org/x')).rejects.toThrow(/超时/);
  });

  it('调用方取消时报「已取消」，且不再重试', async () => {
    let calls = 0;
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        calls += 1;
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    const controller = new AbortController();
    const fetchJson = createFetcher({ timeoutMs: 5_000, retries: 2 }, fetchImpl);
    const pending = fetchJson('https://example.org/x', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/取消/);
    expect(calls).toBe(1);
  });

  it('返回非 JSON 时明确说是「不是合法 JSON」，而不是当成空数据', async () => {
    const fetchImpl = (async () => response(200, '<html>oops</html>')) as unknown as typeof fetch;
    const fetchJson = createFetcher({ timeoutMs: 500, retries: 0 }, fetchImpl);
    await expect(fetchJson('https://example.org/x')).rejects.toThrow(/不是合法 JSON/);
  });

  it('总时长上限真的生效：剩余预算不够退避时不再硬等', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(503, 'down');
    }) as unknown as typeof fetch;

    // 单次 30 ms 超时、总上限 50 ms：第 2 次要等 400 ms，必然超预算
    const fetchJson = createFetcher({ timeoutMs: 30, retries: 2, maxTotalMs: 50 }, fetchImpl);
    await expect(fetchJson('https://example.org/x')).rejects.toThrow(/上限/);
    expect(calls).toBe(1);
  });
});

describe('响应头透出（白名单 x-*，2026-11-01 后端负责人裁定）', () => {
  it('x-* 头被透出；缺头与「头值为 0」必须能分开', async () => {
    // 这两条是同一个字段的两种状态，源层靠它区分"真 0 条"与"上游没给计数"
    const withZero = (async () => response(200, '{"results":[]}', { 'x-total-results': '0' })) as unknown as typeof fetch;
    const without = (async () => response(200, '{"results":[]}')) as unknown as typeof fetch;

    const a = await createFetcher({ timeoutMs: 500, retries: 0 }, withZero)('https://example.org/x');
    const b = await createFetcher({ timeoutMs: 500, retries: 0 }, without)('https://example.org/x');

    expect(a.headers?.['x-total-results']).toBe('0');     // 给了 0
    expect(b.headers?.['x-total-results']).toBeUndefined(); // 没给 —— 不许被读成 0
    expect(b.headers).toBeUndefined();
  });

  it('非 x-* 头不外泄（set-cookie / authorization 之类不许进工具输出）', async () => {
    const fetchImpl = (async () => response(200, '{"ok":true}', {
      'set-cookie': 'session=SECRET',
      authorization: 'Bearer SECRET',
      'content-type': 'application/json',
      'x-uniprot-release': '2026_03',
    })) as unknown as typeof fetch;
    const result = await createFetcher({ timeoutMs: 500, retries: 0 }, fetchImpl)('https://example.org/x');
    expect(result.headers).toEqual({ 'x-uniprot-release': '2026_03' });
    expect(JSON.stringify(result.headers)).not.toContain('SECRET');
  });

  it('凭据类 x-* 头一律不透出（x-api-key / x-auth-token 也是 x-*）', async () => {
    // 泛收 x-* 的致命处：x-api-key、x-auth-token、x-access-token 全是 x-* 且全是凭据。
    const fetchImpl = (async () => response(200, '{}', {
      'x-api-key': 'SECRET-KEY',
      'x-auth-token': 'SECRET-TOKEN',
      'x-access-token': 'SECRET-ACCESS',
      'x-total-results': '1',
    })) as unknown as typeof fetch;
    const result = await createFetcher({ timeoutMs: 500, retries: 0 }, fetchImpl)('https://example.org/x');
    expect(result.headers).toEqual({ 'x-total-results': '1' });
    expect(JSON.stringify(result.headers)).not.toContain('SECRET');
  });

  it('白名单外的 x-* 头不透出（泛收会把上游任意自定义头带进模型上下文）', async () => {
    const fetchImpl = (async () => response(200, '{}', { 'x-session-trace': 'abc', 'x-total-results': '3' })) as unknown as typeof fetch;
    const result = await createFetcher({ timeoutMs: 500, retries: 0 }, fetchImpl)('https://example.org/x');
    expect(result.headers).toEqual({ 'x-total-results': '3' });
  });

  it('头名统一小写，取值原样保留（不去空格、不解析数字）', async () => {
    const fetchImpl = (async () => response(200, '{}', { 'X-Total-Results': '  12 ' })) as unknown as typeof fetch;
    const result = await createFetcher({ timeoutMs: 500, retries: 0 }, fetchImpl)('https://example.org/x');
    expect(result.headers?.['x-total-results']).toBe('12'); // Headers 会 trim，此处只验证键名小写
  });
});

describe('白名单与源层读取项必须对齐（2026-11-01 后端负责人）', () => {
  /**
   * 白名单里暂时没有读取者的头：必须**显式登记**，不许靠"反正没人管"放过。
   * 现在只有 UniProt 一对（R11 未过审、未提交，源没进注册表）。
   *
   * 登记是有代价的：一个头一旦真有已注册的源在读，它就必须从这里删掉（见 stale 断言）。
   * 这就是"先声明再接线"的反向闸门——清单不会自己过期。
   */
  const PENDING_READERS: Readonly<Record<string, string>> = {
    'x-total-results': 'UniProt（R11 未过审、未提交；接入时从此表删掉）',
    'x-uniprot-release': '同上：UniProt 的数据版本头',
  };

  it('已注册源读到的头必须在白名单里；白名单里也不许有没人读的头', async () => {
    // 防的是：源层要读某个头，白名单里没它 → 能力白加，且没人发现。
    // 做法：扫**已注册源**目录下的 .ts，找 header(res, 'x-…') 与 headers['x-…'] 两种写法。
    const { readdirSync, readFileSync: rf, statSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { join } = await import('node:path');
    const { RESPONSE_HEADER_ALLOWLIST } = await import('../src/core/http.js');
    const { registry } = await import('../src/sources/index.js');

    // 2026-11-03 后端负责人裁定：只扫**已注册**的源。未接线但躺在工作区里的源（UniProt）
    // 不算数——白名单的语义是"给已接入能力用的"，不是"预留给将来"。
    // 也随之撤掉原来那条「至少应扫到 UniProt 的计数头」：UniProt 未提交，要求它出现
    // 等于让任何干净检出 / 公开仓的 npm test 必红；红线应该钉在"真实存在的源"上。
    const sourcesRoot = fileURLToPath(new URL('../src/sources', import.meta.url));
    const registered: string[] = registry.listSources().map((bundle) => bundle.manifest.id as string).sort();
    expect(registered.length, '注册表为空：先看 src/sources/index.ts').toBeGreaterThan(0);

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    // 用 fileURLToPath：pathname 不解码，中文路径会变成 %E4%BD%99… 导致 scandir 失败
    for (const id of registered) walk(join(sourcesRoot, id));
    // 扫到 0 个文件 = 注册 id 与目录对不上；这条比"必须扫到某个源的头"更早暴露问题
    expect(files.length, `按注册表扫到 ${files.length} 个源文件：注册 id 与目录对不上`).toBeGreaterThan(0);

    const used = new Map<string, string[]>();
    const dynamic: string[] = [];
    for (const file of files) {
      const rel = file.replace(/.*src[\\/]sources[\\/]/, '');
      // 走 AST：注释天然不算，可选链也算（R12-C2 实测：正则两个方向都会错）
      const reads = scanHeaderReads(file, rf(file, 'utf8'));
      for (const name of reads.names) used.set(name, [...(used.get(name) ?? []), rel]);
      for (const snippet of reads.dynamic) dynamic.push(`${rel}: ${snippet}`);
    }
    // 头名不是字面量（res.headers[key]）时，静态核对无法保证它在白名单里——
    // 宁可红，也不许"看起来扫过了"。真需要动态取头时，改成字面量或在这里显式放开。
    expect(dynamic, `这些地方的头名不是字面量，无法核对白名单：${dynamic.join(' | ')}`).toEqual([]);

    const orphans = Object.keys(PENDING_READERS).filter((name) => !RESPONSE_HEADER_ALLOWLIST.has(name));
    const missing = [...used.keys()].filter((name) => !RESPONSE_HEADER_ALLOWLIST.has(name));
    // 反向：白名单里没有读取者的项 = 死条目（声明了没用，以后没人会删）。
    // 没有这条，x-uniprot-release-date 能白挂一辈子而测试一直绿（后端负责人 2026-11-01）。
    // 例外只有一个：PENDING_READERS 里显式登记过的待接入头。
    const dead = [...RESPONSE_HEADER_ALLOWLIST].filter((name) => !used.has(name) && !(name in PENDING_READERS));
    const stale = Object.keys(PENDING_READERS).filter((name) => used.has(name));
    // R12：孤儿登记。登记一个白名单里根本没有的头，它既不参与 missing 也不参与 dead，
    // 等于在闸门旁边开一格没人看的抽屉——写错了永远不响。所以登记必须是白名单的子集。
    expect(orphans, `PENDING_READERS 登记了白名单里没有的头：${orphans.join(', ')}——要么补白名单，要么删掉登记`)
      .toEqual([]);
    expect(dead, `这些头在白名单里但没有任何已注册源读取（死条目）：${dead.join(', ')}`).toEqual([]);
    expect(stale, '这些头已经有已注册的源在读，把登记从 PENDING_READERS 里删掉（过期登记同样是 bug）').toEqual([]);
    expect(missing, `这些头被源层读取但不在白名单里（读到的永远是 undefined）：${missing.join(', ')}`).toEqual([]);
  });
});

/**
 * 扫描器自身的正负控（R12-C2）。这些用例不看仓库现状，只看"扫描器会不会瞎"——
 * 上面那条对齐断言的可信度全部建立在它身上。
 */
describe('响应头读取扫描：注释不算、可选链要算、动态头名要报（R12-C2）', () => {
  it('注释里的读取不算——否则会凭空冒出 stale/dead 误报', () => {
    expect(scanHeaderReads('c.ts', '// headers["x-total-results"]\nconst a = 1;').names).toEqual([]);
    expect(scanHeaderReads('c.ts', '/* header(res, "x-uniprot-release") */').names).toEqual([]);
  });

  it('可选链 res.headers?.["x-…"] 与下标 res.headers["x-…"] 都要算', () => {
    const optional = scanHeaderReads(
      'a.ts',
      'export function f(res: { headers?: Record<string, string> }) { return res.headers?.["x-qq-probe"]; }',
    );
    expect(optional.names, '可选链漏检 = 换个写法就能绕过白名单').toEqual(['x-qq-probe']);
    const index = scanHeaderReads('a.ts', 'const v = res.headers["x-total-results"];');
    expect(index.names).toEqual(['x-total-results']);
  });

  it('header() 的单引号、双引号、无插值模板串都算', () => {
    const reads = scanHeaderReads('b.ts', "const a = header(res, 'x-a'); const b = header(res, \"x-b\"); const c = header(res, `x-c`);");
    expect(reads.names).toEqual(['x-a', 'x-b', 'x-c']);
  });

  it('非字面量的头名必须被单独报出来，不许静默漏', () => {
    const reads = scanHeaderReads('d.ts', "const key = 'x-a'; const v = res.headers[key];");
    expect(reads.names).toEqual([]);
    expect(reads.dynamic.length, '动态头名要交给调用方判红').toBe(1);
  });

  // R12 二轮列出的四种"合法但静态核不了"的读法：一律记动态（拒绝），不许静默漏。
  it.each([
    ['header(res, key) 非字面参数', 'const key = "x-qq-probe"; const v = header(res, key);'],
    ['对象解构', 'const { "x-qq-probe": v } = res.headers;'],
    ['遍历 Object.entries', 'const v = Object.entries(res.headers).filter(([k]) => k.startsWith("x-"));'],
    ['转交别名', 'const h = res.headers; const v = h["x-qq-probe"];'],
    ['下标形式转交别名', 'const h = res["headers"]; const v = h["x-qq-probe"];'],
    ['下标形式解构', 'const { "x-qq-probe": v } = res["headers"];'],
  ])('%s → 必须记动态', (_label, code) => {
    const reads = scanHeaderReads('e.ts', code);
    expect(reads.names, '这些写法认不出具体头名，names 必须为空').toEqual([]);
    expect(reads.dynamic.length, '认不出就必须报动态，不许当没看见').toBeGreaterThan(0);
  });

  it('res["headers"]["x-…"] 这种下标容器也要能读出具体头名', () => {
    const reads = scanHeaderReads('g.ts', 'const v = res["headers"]["x-qq-probe"];');
    expect(reads.names).toEqual(['x-qq-probe']);
    expect(reads.dynamic).toEqual([]);
  });

  it('类型注解里的 headers 不算读取（否则每条签名都误报）', () => {
    const reads = scanHeaderReads(
      'f.ts',
      'export function f(res: { headers?: Record<string, string> }): { headers: Record<string, string> } { return res as never; }',
    );
    expect(reads.dynamic).toEqual([]);
    expect(reads.names).toEqual([]);
  });
});

describe('正文分类（均为模拟响应，非真实上游证据）', () => {
  it('零长度正文与空对象可区分，保持原有data兼容行为', async () => {
    const empty = await createFetcher({}, (async () => response(200, '')) as typeof fetch)('https://example.org/x');
    const object = await createFetcher({}, (async () => response(200, '{}')) as typeof fetch)('https://example.org/x');
    expect(empty).toMatchObject({ data: {}, bodyKind: 'empty', status: 200 });
    expect(object).toMatchObject({ data: {}, bodyKind: 'json', status: 200 });
  });

  it.each(['{}', '[]', 'null', '0', 'false', '""'])('合法JSON %s 保持解析值并标记json', async (body) => {
    const result = await createFetcher({}, (async () => response(200, body)) as typeof fetch)('https://example.org/x');
    expect(result.bodyKind).toBe('json');
    expect(result.data).toEqual(JSON.parse(body));
  });

  it.each([' ', '\n\t', '<html>oops</html>', '{'])('非空无效JSON %j 失败且不重试', async (body) => {
    let calls = 0;
    const fake = (async () => { calls++; return response(200, body); }) as typeof fetch;
    await expect(createFetcher({ retries: 2 }, fake)('https://example.org/x')).rejects.toThrow(/不是合法 JSON/);
    expect(calls).toBe(1);
  });

  it.each([404, 429, 503])('空体HTTP %i 仍失败，不进入成功分类', async (status) => {
    let calls = 0;
    const fake = (async () => { calls++; return response(status, ''); }) as typeof fetch;
    await expect(createFetcher({ retries: 0 }, fake)('https://example.org/x'))
      .rejects.toMatchObject({ meta: { status, attempts: 1 } });
    expect(calls).toBe(1);
  });

  it('旧fixture缺标记保持未知，不等于empty', () => {
    const legacy: HttpResult = { data: {}, url: 'https://example.org/x', status: 200, durationMs: 0, attempts: 1 };
    expect(legacy.bodyKind).toBeUndefined();
    expect(legacy.bodyKind === 'empty').toBe(false);
  });
});

describe('响应类型及模拟429（非真实上游证据）', () => {
  it('GET成功响应保留content-type', async () => {
    const fake = (async () => response(200, '{"ok":true}', { 'content-type': 'application/json' })) as typeof fetch;
    expect((await createFetcher({}, fake)('https://example.org/x')).contentType).toBe('application/json');
  });
  it('HTML404不能解释为生物学不存在', async () => {
    const fake = (async () => response(404, '<html>fallback</html>', { 'content-type': 'text/html' })) as typeof fetch;
    await expect(createFetcher({}, fake)('https://example.org/x')).rejects.toMatchObject({
      meta: { status: 404, contentType: 'text/html' },
    });
    await expect(createFetcher({}, fake)('https://example.org/x')).rejects.toThrow(/无法据此判断基因是否存在/);
  });
  it('模拟429超过总预算时不重复请求并保留限流状态', async () => {
    let calls = 0;
    const fake = (async () => { calls++; return response(429, '{"message":"slow"}', { 'retry-after': '60' }); }) as typeof fetch;
    await expect(createFetcher({ maxTotalMs: 100, retries: 2 }, fake)('https://example.org/x'))
      .rejects.toMatchObject({ meta: { status: 429, attempts: 1, retryAfter: '60' } });
    expect(calls).toBe(1);
  });
});

/**
 * 上游原文不得进入模型可见的错误文本。
 *
 * 为什么需要这条：`describeError()` 是把 `error.message` 直接拼给模型的唯一出口
 * （两个出口都用它：`src/mcp/server.ts`、`src/service/http.ts`）。因此「错误消息由谁生成」
 * 直接决定上游正文会不会进上下文——若有人图省事写成
 * `new UpstreamError(上游原文, …)`，上游的整页 HTML 就会原样进上下文。
 *
 * 每条用例都**先证明哨兵真的在响应里**：`bodySnippet` 必须含哨兵。
 * 少了这半句，断言就是空转——响应里没有哨兵时，怎么拼都不会出现，
 * 测试会一直绿，等于没测。
 *
 * 2026-10-30 止血：本组用例覆盖的五条路径，上游可控文本**全部**不进模型可见文本。
 * 此前唯一例外（400 + JSON 的 `message`）已按负责人决定去掉，理由见最后一个用例的注释。
 * 注意 `AGENTS.md` 的规则文本尚未随之更新，规则变更单独走授权。
 */
describe('错误文本不得带出上游原文（哨兵断言）', () => {
  const SENTINEL = '哨兵_SENTINEL_ZZZ9';

  /** 造一个固定返回某状态与正文的 fetcher；retries=0 保证只发一次。 */
  const failingWith = (status: number, body: string, contentType: string) =>
    createFetcher({ timeoutMs: 500, retries: 0 }, (async () =>
      response(status, body, { 'content-type': contentType })) as typeof fetch);

  const captureError = async (fetchJson: ReturnType<typeof createFetcher>) => {
    try {
      await fetchJson('https://example.org/x');
    } catch (error) {
      return error as { message: string; meta: { bodySnippet?: string; rawBody?: string; rawBodyTruncated?: boolean } };
    }
    throw new Error('本用例要求上游失败，但 fetchJson 没有抛错');
  };

  /**
   * 断言分两半，缺一不可：
   *   ① 哨兵确实被收进了 `bodySnippet` 与 `rawBody`（证明这次响应里真有哨兵）；
   *   ② 模型可见的错误文本里没有哨兵。
   *
   * 2026-10-30 起 `rawBody` 也进 `meta`（给源层做严格结构判定）。它携带**完整**上游正文，
   * 所以"不进模型可见文本"这条比只靠 `bodySnippet` 时更值得钉：唯一出口 `describeError()`
   * 只拼 message 与元数据，不拼 `rawBody`。
   */
  const expectLeakFree = async (status: number, body: string, contentType: string) => {
    const error = await captureError(failingWith(status, body, contentType));
    expect(error.meta.bodySnippet, `HTTP ${status} 的响应正文应被收进 bodySnippet`).toContain(SENTINEL);
    expect(error.meta.rawBody, `HTTP ${status} 的响应正文应被原样收进 rawBody`).toContain(SENTINEL);
    expect(describeError(error)).not.toContain(SENTINEL);
    return error;
  };

  it('502 纯文本正文含哨兵：错误文本只有分类文案，不带正文', async () => {
    const error = await expectLeakFree(502, `upstream said ${SENTINEL}`, 'text/plain');
    expect(error.message).toMatch(/上游后端暂时不可用/);
  });

  /**
   * 5xx 文案不许替上游下结论（2026-10-30，ENSP-04）。
   *
   * 旧文案写「通常是对面接口服务在重启或过载，不是本工具配置问题」——两半都观测不到：
   * 重启/过载是本机看不到的因果，而"不是本工具配置问题"是排除性结论。
   * 同一份规则见 AGENTS §十一（HTTP 5xx/DNS/代理错误不足以确定"上游重启"或排除本机配置原因）。
   */
  it('5xx 文案只写观测到的状态与"未验证"，不断言上游原因', async () => {
    const error = await expectLeakFree(503, `upstream said ${SENTINEL}`, 'text/plain');
    expect(error.message).toMatch(/上游后端暂时不可用（HTTP 503/);
    expect(error.message).toMatch(/未验证/);
    expect(error.message).not.toMatch(/重启|过载|不是本工具配置问题|与本工具无关/);
  });

  it('500 HTML 错误页含哨兵：不带出 HTML', async () => {
    await expectLeakFree(500, `<html><body>${SENTINEL}</body></html>`, 'text/html');
  });

  it('404 HTML 兜底页含哨兵：不带出页面内容', async () => {
    await expectLeakFree(404, `<html>${SENTINEL}</html>`, 'text/html');
  });

  it('400 的 JSON 里非 message 字段含哨兵：不带出该字段', async () => {
    await expectLeakFree(400, JSON.stringify({ error: SENTINEL, detail: SENTINEL }), 'application/json');
  });

  /**
   * 400 + JSON 里的 `message` 字段**也不进错误文本**（2026-10-30 止血后的口径）。
   *
   * 历史：这里曾有一条已知例外——上游 `message` 截 180 字符进错误文本，理由是
   * 「参数哪里不对只有对面知道」。该例外已按负责人决定去掉：上游可控文本进模型上下文
   * 就是注入面，对面可以往 `message` 里塞指令。上游原文仍在 `meta.bodySnippet`，只给程序看。
   *
   * 本用例现在钉两件事，都是**上界**：
   *   ① 上游 message 的**开头**（旧例外会带出来的那一段）不得出现在模型可见文本里；
   *   ② 正文**深处**的哨兵同样不得出现（除非有人把窗口扩成整段正文，否则不会红）。
   * 也就是说：例外被去掉它照样通过；谁把 `message` 或整段正文重新接回错误文本，它才会红。
   *
   * 有效性验证（隔离副本，未改共享工作区）：正常实现下整个文件 33/33 通过；
   * 把 `error.meta.bodySnippet` 故意拼进 `describeError()` 后，本组 5 例全部失败。
   */
  it('400 的 JSON message 也不进错误文本：开头与深处都不出现', async () => {
    const head = '参数错误：';
    const deepSentinel = '深处哨兵_DEEP_SENTINEL';
    // 位置为什么是这里：哨兵要落在 `bodySnippet` 的 300 字符窗口内（否则上一行断言
    // 会空转），同时落在**旧例外**取不到的深处（旧的只取前 180 字符）。
    // `{"message":"` 占 12 字符，故正文偏移 = 12 + 188 = 200，既 < 300 也 > 180。
    // 注意：旧例外的 180 字符窗口**今天已不存在**（已按负责人决定去掉），
    // 「200 > 180」只是历史位置说明；本用例现在钉的两件事都只是上界。
    const padding = 'x'.repeat(188);
    const error = await captureError(
      failingWith(400, JSON.stringify({ message: `${head}${padding}${deepSentinel}` }), 'application/json'),
    );
    expect(error.meta.bodySnippet).toContain(deepSentinel);
    const visible = describeError(error);
    expect(visible).not.toContain(deepSentinel);
    expect(visible, '上游 message 的开头（旧例外会带出的那段）也不得进模型可见文本').not.toContain(head);
    expect(visible).toMatch(/上游返回 HTTP 400/);
  });
});

/**
 * `rawBody`：给源层做**严格结构判定**用的未经处理原体（2026-10-30，ENSP-02）。
 *
 * 为什么必须与 `bodySnippet` 并存：`snippet()` 会把空白压平成一行，上游若在 JSON 字符串里
 * 塞了非法换行，压平后反而合法化，源层就会把畸形响应读成"查无"。只有未处理的原体才能
 * 严格 `JSON.parse`。
 *
 * 为什么必须有上限与截断标记：上游正文实测可达 1.9 MB（Ensembl Plants variation 50 kb 区间）。
 * 截断后**必须**置 `rawBodyTruncated`，源层见到它要放弃判定——不能只靠"截断后恰好解析失败"兜住。
 */
describe('上游响应原体（rawBody）', () => {
  const failingWith = (status: number, body: string, contentType = 'application/json') =>
    createFetcher({ timeoutMs: 500, retries: 0 }, (async () =>
      response(status, body, { 'content-type': contentType })) as typeof fetch);

  const captureError = async (fetchJson: ReturnType<typeof createFetcher>) => {
    try {
      await fetchJson('https://example.org/x');
    } catch (error) {
      return error as { message: string; meta: { bodySnippet?: string; rawBody?: string; rawBodyTruncated?: boolean } };
    }
    throw new Error('本用例要求上游失败，但 fetchJson 没有抛错');
  };

  it('小正文原样保留：不压平、不裁掉换行（snippet 会压平，rawBody 不会）', async () => {
    const raw = '{\n  "error": "No valid lookup found for symbol NO_SUCH_GENE_ZZZ\\n"\n}';
    const error = await captureError(failingWith(400, raw));
    // 逐字符相等 = 未经处理。若有人把这里改成 `snippet(body)`，本断言立刻红。
    expect(error.meta.rawBody).toBe(raw);
    expect(error.meta.rawBodyTruncated).toBeUndefined();
    // 对照：片段是压平过的，正是它会把畸形 JSON"洗"成合法。
    expect(error.meta.bodySnippet).not.toContain('\n');
  });

  it('超 4 KB 截断并显式标记，落下的部分不超字节上限', async () => {
    const raw = `{"error":"${'A'.repeat(6_000)}"}`;
    const error = await captureError(failingWith(400, raw));
    expect(error.meta.rawBodyTruncated).toBe(true);
    expect(utf8Bytes(error.meta.rawBody!)).toBeLessThanOrEqual(RAW_BODY_LIMIT_BYTES);
    expect(raw.startsWith(error.meta.rawBody!)).toBe(true);
  });

  it('截断按字符边界：不切出坏编码，也不多截', async () => {
    const raw = `{"error":"${'中'.repeat(2_000)}"}`; // 3 字节/字，远超 4 KB
    const error = await captureError(failingWith(400, raw));
    expect(error.meta.rawBodyTruncated).toBe(true);
    expect(error.meta.rawBody).not.toContain('\uFFFD');
    expect(raw.startsWith(error.meta.rawBody!)).toBe(true);
    // 边界效率：4291 → 4288 字节（4096 向下取到 3 的倍数 + 11 字节头部），不该退到 4000 以下。
    expect(utf8Bytes(error.meta.rawBody!)).toBeGreaterThan(RAW_BODY_LIMIT_BYTES - 4);
  });

  it('重试后仍失败：原体随最后一次尝试交给调用方', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(503, `{"try":${calls}}`);
    }) as typeof fetch;
    const error = await captureError(createFetcher({ timeoutMs: 500, retries: 1 }, fetchImpl));
    expect(calls).toBe(2);
    expect(error.meta.rawBody).toBe('{"try":2}');
  });
});

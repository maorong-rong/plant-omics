#!/usr/bin/env node
/**
 * 检索层自测（AGENTS.md v2.2 §10.2 三条验收标准）。
 *
 * 为什么合成一个入口：此前是 `%TEMP%` 下六个散件（selftest/mcp-list/mcp-call/probe-range/
 * combine/selftest-v22），既不能当长期证据，也无法复现"用的是哪一版脚本"。
 * 现在一入口三模式，题集在 `scripts/retrieval-cases.json`：
 *
 *   node scripts/retrieval-selftest.mjs                  # judge（默认）：跑全部题，逐题七项检查
 *   node scripts/retrieval-selftest.mjs --list-tools     # 打印真实 MCP 出口的 tools/list
 *   node scripts/retrieval-selftest.mjs --call "问题"     # 经真实 MCP stdio 调 hub_find_sources
 *
 * **零上游边界**：本脚本只走本地目录与本地 MCP 子进程，不发任何上游请求（judge 里注入的
 * `http` 一被调用就抛错，作为"检索层不该联网"的硬断言）。上游是否可达由 `npm run probe`
 * 单独回答——两件事的红必须能一眼分开（AGENTS §四）。
 *
 * 判据（v2.2）：
 *   ① 返回**全部命中源**的候选 + 各自工具名；命中 = 物种覆盖 ∧ 意图能力，双命中；
 *      不为凑数量把只满足单条件的源降级计入；正文装不下时正文必须明说"另有 N 个命中源未展示"。
 *   ② 命中不足（含 0 个）如实说"没有覆盖"，不拿不相干的源凑数；物种在目录时必须区分
 *      "有源覆盖但能力缺口"与"物种没人接"。
 *   ③ 返回的工具名必须在真实 MCP 出口的 tools/list 里，且带非空 parameters。
 *
 * 退出码：任一检查 FAIL → 1（断言铁律：不许只告警）。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const argOf = (name, fallback = undefined) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};

const repoRoot = resolve(argOf('--repo', REPO_ROOT));
// 默认写系统临时目录：这是本机复算产物，不是交付物（同 probe-report.json 的口径）。
// 要当长期证据时显式 `--out <仓内或记录目录路径>`，由调用方决定入库位置。
const outPath = resolve(argOf('--out', join(tmpdir(), 'retrieval-selftest-report.json')));
const casesPath = resolve(argOf('--cases', join(repoRoot, 'scripts', 'retrieval-cases.json')));

/* ─────────────── 真实 MCP stdio 出口（③ 的协议层核对） ─────────────── */

/**
 * 起一个本地 MCP 子进程，按需发一条请求。
 *
 * 只在本机 spawn `dist/mcp/cli.js`，**不联网**：hub_find_sources 与 tools/list 都不发上游请求。
 * `stdio: 'pipe'` 在这里是必需的（要读 JSON-RPC 回包）；它只连本机子进程，不是上游连接。
 */
async function mcpRequest(method, params) {
  const child = spawn(process.execPath, [join(repoRoot, 'dist', 'mcp', 'cli.js')], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        replies.push(JSON.parse(line));
      } catch {
        replies.push({ __unparsed: line });
      }
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });

  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'retrieval-selftest', version: '2.2' } },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  send({ jsonrpc: '2.0', id: 2, method, params });

  const waitFor = (id, ms = 20_000) => new Promise((res) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const hit = replies.find((r) => r.id === id);
      if (hit || Date.now() - t0 > ms) {
        clearInterval(tick);
        res(hit ?? null);
      }
    }, 50);
  });

  const init = await waitFor(1);
  const reply = await waitFor(2);
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 150));
  child.kill();
  return { init, reply, stderr };
}

async function listMcpTools() {
  const { init, reply, stderr } = await mcpRequest('tools/list', {});
  const tools = (reply?.result?.tools ?? []).map((t) => t.name);
  if (tools.length === 0) {
    throw new Error(`MCP 出口没有返回工具（stderr 尾部：${stderr.slice(-300)}）`);
  }
  return { tools, serverInfo: init?.result?.serverInfo ?? null, protocolVersion: init?.result?.protocolVersion ?? null };
}

/* ─────────────── 模式：--list-tools ─────────────── */

async function modeListTools() {
  const { tools, serverInfo, protocolVersion } = await listMcpTools();
  console.log(`MCP 出口 tools/list = ${tools.length} 个｜server=${JSON.stringify(serverInfo)}｜protocol=${protocolVersion}`);
  console.log(tools.join('\n'));
  return 0;
}

/* ─────────────── 模式：--call ─────────────── */

async function modeCall(question) {
  const { reply, stderr } = await mcpRequest('tools/call', { name: 'hub_find_sources', arguments: { question } });
  const content = reply?.result?.content ?? [];
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`isError=${reply?.result?.isError ?? 'null'}｜text ${Buffer.byteLength(text, 'utf8')} B｜content=${content.map((c) => c.type).join(',')}`);
  console.log(text);
  writeFileSync(outPath, JSON.stringify({
    ranAt: new Date().toISOString(), question, isError: reply?.result?.isError ?? null,
    contentTypes: content.map((c) => c.type), textBytes: Buffer.byteLength(text, 'utf8'), text,
    stderrTail: stderr.slice(-300),
  }, null, 2), 'utf8');
  console.log(`\nsaved ${outPath}`);
  return reply ? 0 : 1;
}

/* ─────────────── 模式：judge（默认） ─────────────── */

async function modeJudge() {
  const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
  const mod = await import(pathToFileURL(join(repoRoot, 'dist', 'sources', 'index.js')).href);
  const cat = await import(pathToFileURL(join(repoRoot, 'dist', 'retrieval', 'capability-catalog.js')).href);
  const registry = mod.createRegistry();
  const findTool = registry.listMetaTools().find((t) => t.name === 'hub_find_sources');
  if (!findTool) throw new Error('注册表里没有 hub_find_sources');

  const { tools: mcpTools } = await listMcpTools();
  const mcpSet = new Set(mcpTools);
  const allNames = new Set(registry.listTools().map((t) => t.name));

  const CAPS = cat.TOOL_CAPABILITIES;
  const SEM = cat.SOURCE_SEMANTICS;
  const satisfies = cat.speciesSatisfies;
  const known = cat.speciesKnownInCatalog ?? ((sp) => CAPS.some((c) => (c.speciesScope.query ?? [])
    .some((sc) => sc !== '不限物种（按精确 ID）' && satisfies(sp, sc))));

  // 零上游硬断言：检索层一旦发请求就抛错，题集里不该出现任何上游流量。
  let upstreamAttempts = 0;
  const ctx = {
    http: async () => {
      upstreamAttempts += 1;
      throw new Error('hub_find_sources 不应发上游请求（零上游边界）');
    },
  };

  /** 独立的双命中判定：不调用被测实现，只读能力目录。 */
  const doubleHit = (toolName, recognized) => {
    const cap = CAPS.find((c) => c.tool === toolName);
    if (!cap) return { ok: false, why: 'not-in-catalog' };
    if (!cap.intents.some((id) => recognized.intents.includes(id))) return { ok: false, why: 'intent-miss' };
    const species = recognized.species;
    if (species.length === 0) return { ok: true, why: 'no-species' };
    const sem = SEM[cap.sourceId];
    const scope = cap.speciesScope.query ?? [];
    if (species.some((sp) => scope.some((sc) => satisfies(sp, sc)))) return { ok: true, why: 'species-hit' };
    if (sem?.policy === 'any-by-id') return { ok: true, why: 'any-by-id' };
    if (sem?.policy === 'example-only') {
      return species.some((sp) => (sem.example ?? []).includes(sp))
        ? { ok: true, why: 'example-hit' }
        : { ok: false, why: 'example-miss' };
    }
    return { ok: false, why: 'species-miss' };
  };

  const rows = [];
  for (const c of cases.cases ?? cases) {
    const res = await findTool.run({ question: c.q }, ctx);
    const text = res.text ?? '';
    const raw = res.raw ?? {};
    const recognized = raw.recognized ?? { species: [], intents: [], sources: [], clauses: [] };
    const candidates = (raw.candidates ?? []).map((g) => ({ sourceId: g.sourceId, tools: g.tools ?? [] }));
    const returnedTools = candidates.flatMap((g) => g.tools);

    // ③ 可调用性
    const notInMcp = returnedTools.filter((n) => !mcpSet.has(n));
    const noSchema = returnedTools.filter((n) => {
      const t = registry.getTool(n);
      return !t || !t.parameters || typeof t.parameters !== 'object';
    });

    // ①-a 双命中
    const doubleHitMiss = returnedTools
      .map((name) => ({ tool: name, ...doubleHit(name, recognized) }))
      .filter((v) => !v.ok);
    const eachSourceHasTool = candidates.every((g) => g.tools.length > 0);

    // ①-b 完整命中集（只在"无点名源、无未覆盖物种、无分句"时判，避免拿猜的口径去判）
    //
    // v2.2 的①是「返回**全部命中源**」——判的是**源**，不是"每个双命中工具都出现"。
    // 单源内部选哪些工具属工具设计层面（一源多意图时不必全上），拿工具全集去判会把
    // 正常裁剪误判成漏源（2026-10-30 自测 L1/L2 就踩过这个坑）。
    const unknownSpecies = recognized.species.filter((sp) => !known(sp));
    // 多物种题也不判：方向门与目标端门没建模，「小麦同源基因对应玉米」这种题
    // 按目录重算会把 wheatomics 算成"该给却没给"（缺源 wheatomics），而实现拒绝它是对的
    // （该工具 target 只有水稻/拟南芥）。多物种的方向/target 由题集里两条单向断言覆盖。
    const guardOk = recognized.sources.length === 0 && unknownSpecies.length === 0
      && (recognized.clauses ?? []).length === 0 && recognized.species.length <= 1;
    const expectedSources = guardOk
      ? [...new Set(CAPS.filter((cap) => doubleHit(cap.tool, recognized).ok).map((cap) => cap.sourceId))]
      : null;
    const returnedSources = new Set(candidates.map((g) => g.sourceId));
    const missing = expectedSources ? expectedSources.filter((s) => !returnedSources.has(s)) : null;
    // 参考信息：命中源齐全、但某源的双命中工具没出现（不算 FAIL，随报告一起给出便于审查）
    const expectedToolsAll = guardOk
      ? CAPS.filter((cap) => doubleHit(cap.tool, recognized).ok).map((cap) => cap.tool)
      : null;
    const toolsNotOffered = expectedToolsAll ? expectedToolsAll.filter((n) => !returnedTools.includes(n)) : null;

    // ② 如实说没有覆盖 / 区分两种缺口
    const zero = candidates.length === 0;
    // 仅物种命中：物种识别成功、意图为空。这类必须直接拒答（state=B、候选 0），
    // 否则"物种接得住"会被误读成"能力也接得住"，模型会照着候选去调不该调的源。
    const speciesOnly = recognized.species.length > 0 && (recognized.intents ?? []).length === 0;
    const saysNoCover = /没有覆盖|未覆盖|不在本服务目录/.test(text);
    const contradiction = zero && /没能识别出可用意图/.test(text) && recognized.sources.length > 0;
    const coverageBothKinds = !zero || recognized.species.length === 0 || unknownSpecies.length > 0
      || /有源覆盖|能力缺口|点名了/.test(text);

    // ①-c 预算截断时正文必须明说"另有 N 个命中源未展示"
    const renderedCount = new Set([...text.matchAll(/^([\u2460-\u2473]) ([a-z0-9]+)｜/gmu)].map((m) => m[2])).size;
    const omittedNote = /另有 (\d+) 个命中源未展示/.test(text);
    const omittedCount = Number((text.match(/另有 (\d+) 个命中源未展示/) ?? [])[1] ?? 0);
    const dropConsistent = renderedCount === candidates.length
      || (omittedNote && omittedCount === candidates.length - renderedCount);

    /**
     * 逐物种交代（2026-10-31 负责人口径）：**识别到的物种集合 ⊆ 已交代物种集合**，差一个即 FAIL。
     *
     * 交代 = `raw.speciesVerdicts` 里该物种有一条判定（结构化，不靠解析正文猜）；
     * 缺口态还必须在正文有一行同时点名该物种、并说明缺口,否则就是"物种凭空消失"——
     * 旧实现正是这样丢掉「小麦、玉米的表达与变异都要」里的玉米。
     * `out-of-scope` 是题级拒答（分析/计算），不假装做过覆盖判定，因此不要求正文交代。
     */
    const verdicts = Array.isArray(raw.speciesVerdicts) ? raw.speciesVerdicts : null;
    const verdictSpecies = new Set((verdicts ?? []).map((v) => v.species));
    const unaccounted = recognized.species.filter((sp) => !verdictSpecies.has(sp));
    const gapVerdicts = (verdicts ?? []).filter((v) => v.status !== 'candidate' && v.status !== 'out-of-scope');
    const textLines = text.split('\n');
    /**
     * 判 M-1 时只看**正文**：首行「识别：物种=…」本来就会把所有物种列一遍（旧实现正是靠它
     * 看起来"交代过"），尾注还会原样回显 question——两者都不算交代，必须排除。
     */
    const bodyLines = textLines.filter((line) => !/^识别：/.test(line) && !/^源：/.test(line) && !/^目录快照：/.test(line));
    const undocumented = gapVerdicts.filter((v) => !bodyLines.some(
      (line) => line.includes(v.species) && /不在|没有|未覆盖|不覆盖|缺/.test(line)));
    const speciesAccounting = recognized.species.length === 0
      ? 'n/a'
      : verdicts === null ? 'FAIL 缺 raw.speciesVerdicts'
        : unaccounted.length > 0 ? `FAIL 缺交代 ${unaccounted.join('、')}`
          : undocumented.length > 0 ? `FAIL 正文未交代 ${undocumented.map((v) => `${v.species}(${v.status})`).join('、')}`
            : 'PASS';

    /**
     * M-2 / M-3（检索负责人 2026-10-31 定）——两个方向的防作弊。
     *
     * M-2 **不得自相矛盾/不得整题拒答假修复**：
     *     (a) 有候选却判 state=B 是自相矛盾；
     *     (b) 已有物种拿到双命中候选却把整题拒成 0 候选，等于没修。
     * M-3 **不得凑数**：识别到的物种**按目录**全部没有源覆盖时，必须 state=B 且候选 0。
     *
     * M-3 的判据**不能读 `raw.speciesVerdicts`**——那是被测实现自己的说法。漏候选时它会把物种
     * 标成 `candidate`（gwh「不限物种（按精确 ID）」一放行就会这样），于是"全部无覆盖"这个前提
     * 自己就不成立了，判据永远绿。所以 M-3 直接用能力目录独立重算 `known()`（本轮负控实测：
     * 抽掉 veto 后 N1「大豆的基因组组装」漏出 gwh，靠 verdicts 的旧写法判不出来，改目录判据后报红）。
     *
     * M-4（每个候选工具至少对一个识别物种双命中）与 ①-a 是同一条判据、同一个谓词
     * （`doubleHit()` 里就是 `recognized.species.some(...)`），不再复制一份——
     * 同一个事实只留一处判据，改口径时才不会两边不同步。
     */
    const candidateVerdicts = (verdicts ?? []).filter((v) => v.status === 'candidate');
    const allUnknownToCatalog = recognized.species.length > 0 && recognized.species.every((sp) => !known(sp));
    const m2 = (candidates.length > 0 && raw.state === 'B')
      ? `FAIL state=B 却有 ${candidates.length} 个候选（自相矛盾）`
      : (candidateVerdicts.length === 0
        ? 'n/a'
        : (raw.state === 'ok' && candidates.length > 0
          ? 'PASS'
          : `FAIL state=${raw.state ?? '(缺)'} 候选=${candidates.length}（有物种已命中却整题拒答）`));
    const m3 = recognized.species.length === 0
      ? 'n/a'
      : (allUnknownToCatalog
        ? (raw.state === 'B' && candidates.length === 0 ? 'PASS' : `FAIL state=${raw.state ?? '(缺)'} 候选=${candidates.length}（全部物种无覆盖却给了候选）`)
        : 'n/a');

    /**
     * 题级期望（`expect`）：意图识别、必须给出/不得给出的工具。
     *
     * `intents` 钉的是"意图兜底不误伤"——`基因` 兜底只在整句零意图时触发，
     * 「水稻的同源基因」必须恰好是 `['homolog']`，不能因为含"基因"多出 gene-search。
     * `tools`/`notTools` 是**两条单向断言**：方向门/目标端门不建完整重算模型
     * （2026-10-30 已知：完整重算在多物种题上会把正常裁剪判成漏源），
     * 只钉"该给的一定给、不该给的一定不给"这一对反例。
     */
    const expect = c.expect ?? {};
    const expectIntents = expect.intents ?? null;
    const sameSet = (want, got) => want.length === got.length && want.every((x) => got.includes(x));
    const intentMismatch = expectIntents === null
      ? null
      : (sameSet(expectIntents, recognized.intents) ? null : `期望 [${expectIntents.join(',')}] 实为 [${recognized.intents.join(',')}]`);
    const missingTool = (expect.tools ?? []).filter((n) => !returnedTools.includes(n));
    const forbiddenTool = (expect.notTools ?? []).filter((n) => returnedTools.includes(n));

    const checks = {
      '①-a 候选全部双命中': zero ? 'n/a' : (doubleHitMiss.length === 0 && eachSourceHasTool ? 'PASS' : 'FAIL'),
      // 仅物种命中（物种识别成功、意图为空）→ 必须直接拒答：state=B 且候选 0。
      // 这类题最容易出的事故是"物种接得住"被当成"能力也接得住"，于是给出候选让模型照着调。
      '仅物种命中→state B 且候选 0': speciesOnly
        ? (raw.state === 'B' && candidates.length === 0
          ? 'PASS'
          : `FAIL state=${raw.state ?? '(缺)'} 候选=${candidates.length}`)
        : 'n/a',
      '①-b 全部命中源': expectedSources === null
        ? '不判（含点名源/未覆盖物种/分句/多物种）'
        : (missing.length === 0 ? 'PASS' : `FAIL 缺源 ${missing.join(',')}`),
      '①-c 未展示源必须明说': zero ? 'n/a' : (dropConsistent ? 'PASS' : `FAIL 渲染 ${renderedCount} / 命中 ${candidates.length}`),
      'M-1 逐物种交代（识别物种 ⊆ 交代物种）': speciesAccounting,
      'M-2 有候选不得整题拒答': m2,
      'M-3 全部无覆盖必须拒答且候选 0': m3,
      '意图识别（与题集期望一致）': expectIntents === null ? 'n/a' : (intentMismatch === null ? 'PASS' : `FAIL ${intentMismatch}`),
      '定向断言（必给/不得给工具）': (expect.tools ?? []).length === 0 && (expect.notTools ?? []).length === 0
        ? 'n/a'
        : missingTool.length > 0 ? `FAIL 缺工具 ${missingTool.join(',')}`
          : forbiddenTool.length > 0 ? `FAIL 不该给 ${forbiddenTool.join(',')}` : 'PASS',
      '② 零候选如实说不覆盖': zero ? (saysNoCover ? 'PASS' : 'FAIL 没写没有覆盖') : 'n/a',
      '② 不把能力缺口写成物种没人接': coverageBothKinds ? 'PASS' : 'FAIL 只有物种不覆盖的解释',
      '② 点名源不得与"没能识别出可用意图"并存': contradiction ? 'FAIL' : 'PASS',
      '③ 工具名在 MCP 清单内': returnedTools.length === 0 ? 'n/a' : (notInMcp.length === 0 ? 'PASS' : `FAIL ${notInMcp.join(',')}`),
      '③ 工具带 parameters': noSchema.length === 0 ? 'PASS' : `FAIL ${noSchema.join(',')}`,
      '零上游（检索层不该联网）': upstreamAttempts === 0 ? 'PASS' : `FAIL 发了 ${upstreamAttempts} 次`,
    };

    rows.push({
      id: c.id, question: c.q, state: raw.state,
      species: recognized.species, intents: recognized.intents, namedSources: recognized.sources,
      candidateCount: candidates.length, renderedCount, candidates, returnedTools,
      speciesVerdicts: verdicts,
      doubleHitMiss, expectedSources, expectedTools: expectedToolsAll, missingSources: missing, toolsNotOffered,
      checks, textBytes: Buffer.byteLength(text, 'utf8'), text,
    });
  }

  const fails = rows.flatMap((r) => Object.entries(r.checks)
    .filter(([, v]) => String(v).startsWith('FAIL'))
    .map(([k, v]) => `${r.id} ${k}: ${v}`));

  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
  const summary = {
    ranAt: new Date().toISOString(), node: process.version, rule: cases.rule ?? 'AGENTS.md v2.2 §10.2',
    casesFile: { path: casesPath, sha256: sha(casesPath) },
    script: { path: fileURLToPath(import.meta.url), sha256: sha(fileURLToPath(import.meta.url)) },
    // 预算数字必须绑定"本次构建"：这里记录被加载的 dist 产物哈希（先 npm run build 再跑）
    dist: {
      'sources/index.js': sha(join(repoRoot, 'dist/sources/index.js')),
      'retrieval/find-sources.js': sha(join(repoRoot, 'dist/retrieval/find-sources.js')),
      'retrieval/capability-catalog.js': sha(join(repoRoot, 'dist/retrieval/capability-catalog.js')),
    },
    registry: {
      sourceCount: registry.listSources().length,
      toolCount: allNames.size,
      mcpToolCount: mcpTools.length,
      upstreamAttempts,
    },
    rows, failCount: fails.length, fails,
  };
  writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');

  for (const r of rows) {
    const flag = Object.values(r.checks).some((v) => String(v).startsWith('FAIL')) ? 'FAIL' : 'PASS';
    console.log(`${flag} ${r.id} 候选=${r.candidateCount} 工具=${r.returnedTools.length} 意图=[${r.intents.join(',')}] `
      + Object.entries(r.checks).map(([k, v]) => `${k}=${v}`).join(' | '));
  }
  console.log(`\n合计 ${rows.length} 题，FAIL 项 ${fails.length}；零上游尝试 ${upstreamAttempts} 次；saved ${outPath}`);
  if (fails.length) console.log(fails.join('\n'));
  return fails.length === 0 ? 0 : 1;
}

/* ─────────────── 入口 ─────────────── */

const callIndex = process.argv.indexOf('--call');
let code;
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('用法：node scripts/retrieval-selftest.mjs [--repo <root>] [--out <json>] [--cases <json>]');
  console.log('      node scripts/retrieval-selftest.mjs --list-tools');
  console.log('      node scripts/retrieval-selftest.mjs --call "问题"');
  code = 0;
} else if (process.argv.includes('--list-tools')) {
  code = await modeListTools();
} else if (callIndex >= 0) {
  const question = process.argv[callIndex + 1];
  if (!question || question.startsWith('--')) {
    console.error('--call 需要一个自然语言问题（加引号）');
    code = 2;
  } else {
    code = await modeCall(question);
  }
} else {
  code = await modeJudge();
}
process.exit(code);

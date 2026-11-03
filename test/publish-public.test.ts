import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error 独立 CLI 脚本，无声明文件
import { EXCLUDED_PATHS, resolveRemote, whitelist } from '../scripts/publish-public.mjs';

/**
 * 公开仓导出白名单（PUB-01，2026-10-31）。
 *
 * 背景：白名单来源是 `git ls-tree HEAD`，所以**只要内部文件被 commit，它就会进公开快照**。
 * `docs/任务看板.md` 含内部卡点、Bot 名称与人员分工——今天没泄漏，纯粹因为它还没被提交。
 *
 * 两条断言各管一半：
 *   ① 正控：真实配置下，看板、`eval/` 私有产物、`论文/` 都不进公开树；`eval-public/` 放行。
 *   ② 负控：把两处排除**真的去掉**再跑同一份判断，看板必须**出现**——
 *      这才证明"排除项是承重的"，而不是别处偷偷硬编码了同样的事。
 */

const SAMPLE = [
  'src/core/http.ts',
  'docs/架构.md',
  'docs/协作分工.md',
  'docs/任务看板.md',
  '记录/20261031-某记录.md',
  '论文/正文.md',
  'eval/r1b-20261031/tasks.txt',
  'eval/r1b-20261031/tasks.json',
  'eval-public/scorer.mjs',
  'eval-public/README.md',
  'deploy/nginx.conf',
  'deploy/waivers.conf',
  'deploy/服务器现状.md',
  'AGENTS.md',
  '00_工作区总览.md',
];

describe('publish-public 白名单：内部看板与评测私有产物不进公开树', () => {
  it('正控：看板 / eval 私有件 / 论文 / 记录 / 运维物料都不进，eval-public 放行', () => {
    const { kept, skipped } = whitelist(SAMPLE) as { kept: string[]; skipped: string[] };

    expect(kept).toContain('src/core/http.ts');
    expect(kept).toContain('eval-public/scorer.mjs');
    expect(kept).toContain('eval-public/README.md');
    // 相邻目录名最容易漏一层：eval/ 私有不放行，eval-public/ 必须放行
    expect(kept.some((p: string) => p.startsWith('eval/'))).toBe(false);
    // deploy/ 整类不进（内网拓扑、主机地址、真名豁免清单，2026-11-02）
    expect(kept.some((p: string) => p.startsWith('deploy/'))).toBe(false);

    for (const forbidden of [
      'docs/任务看板.md',
      'docs/协作分工.md',
      '记录/20261031-某记录.md',
      '论文/正文.md',
      'eval/r1b-20261031/tasks.txt',
      'eval/r1b-20261031/tasks.json',
      'deploy/nginx.conf',
      'deploy/waivers.conf',
      'deploy/服务器现状.md',
      'AGENTS.md',
      '00_工作区总览.md',
    ]) {
      expect(skipped, `${forbidden} 应被排除`).toContain(forbidden);
      expect(kept, `${forbidden} 不许进公开树`).not.toContain(forbidden);
    }
  });

  /** 把源码里两处排除真的删掉后加载：负控靠它证明"排除项是承重的"。 */
  async function loadPatched(source: string, tag: string) {
    const dir = mkdtempSync(join(tmpdir(), `po-pub-${tag}-`));
    try {
      const file = join(dir, 'publish-public.patched.mjs');
      writeFileSync(file, source, 'utf8');
      return await import(pathToFileURL(file).href) as { whitelist: (p: string[]) => { kept: string[] } };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('负控：真的去掉两处排除后，同一份判断必须把看板放进来', async () => {
    // 为什么要这样验：只断言"不含"是不够的——如果有人把过滤写死在别处，第一条仍然会绿，
    // 而排除项已经成了摆设。这里把排除项真的删掉再跑，看板必须出现；
    // 若不出现，说明别处还有一条隐藏的硬编码逻辑，负控失败。
    const source = readFileSync(new URL('../scripts/publish-public.mjs', import.meta.url), 'utf8');
    const patched = source
      .replace(/export const EXCLUDED_PATHS = \[[^\]]*\];/, 'export const EXCLUDED_PATHS = [];')
      .replace(/\s*'docs\/任务看板\.md',/g, '');
    expect(patched, '负控：EXCLUDED_PATHS 必须真的被清空（否则负控空转）').toContain('EXCLUDED_PATHS = [];');
    expect(patched, '负控：FORBIDDEN_PREFIXES 里那条也必须去掉').not.toContain("'docs/任务看板.md',");

    const mod = await loadPatched(patched, 'neg-kanban');
    const { kept } = mod.whitelist(SAMPLE);
    expect(kept, '去掉排除后看板必须出现——否则说明别处有硬编码兜底，排除项不是承重的')
      .toContain('docs/任务看板.md');
  });

  it('负控：去掉 deploy/ 前缀后，运维物料必须重新出现（证明排除不是空转）', async () => {
    const source = readFileSync(new URL('../scripts/publish-public.mjs', import.meta.url), 'utf8');
    const patched = source.replace(/\s*'deploy\/',/g, '');
    expect(patched, '负控：deploy/ 前缀必须真的被删掉').not.toContain("'deploy/',");

    const mod = await loadPatched(patched, 'neg-deploy');
    const { kept } = mod.whitelist(SAMPLE);
    expect(kept, '去掉 deploy/ 排除后必须看到运维物料——否则排除项没起作用')
      .toContain('deploy/waivers.conf');
  });

  it('排除清单里同时有路径与防御前缀：删掉一处仍被另一处挡住', () => {
    // 两处都列是有意的（一处按精确路径、一处按前缀兜底）。这里只核"两处都真的写着"，
    // 因为上一条负控已经证明两处都是承重的。
    expect(EXCLUDED_PATHS).toContain('docs/任务看板.md');
    const source = readFileSync(new URL('../scripts/publish-public.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/FORBIDDEN_PREFIXES\s*=\s*\[[^\]]*'docs\/任务看板\.md'/);
    expect(source).toMatch(/FORBIDDEN_PREFIXES\s*=\s*\[[^\]]*'deploy\/'/);
    expect(source).toMatch(/INTERNAL_LINK\s*=.*docs\\\/任务看板\\\.md/);
    // deploy/ 既然不发布，指向它的链接也必须能被降级/拦截，否则公开仓 404
    expect(source).toMatch(/INTERNAL_LINK\s*=.*deploy\\\//);
    expect(source).toMatch(/id: 'dangling-internal-link'[\s\S]{0,400}deploy\\\//);
  });
});

/**
 * 传输切换（2026-11-02）。背景：本机到 github.com:22 时通时断，HTTPS 443 正常。
 * 写死 SSH 会让发布在**最后一步推送**才失败——所以传输必须可切，且切了只换协议、
 * 不换主机与仓库路径（目标仍是同一个公开仓）。
 */
describe('publish-public 传输切换：ssh ⇄ https 只换协议不换目标', () => {
  it('scp 写法转 HTTPS：主机与仓库路径必须逐字保留', () => {
    expect(resolveRemote('git@github.com:maorong-rong/plant-omics.git', 'https'))
      .toBe('https://github.com/maorong-rong/plant-omics.git');
  });

  it('ssh:// URL 也转得动，不是只认 scp 一种写法', () => {
    expect(resolveRemote('ssh://git@github.com/maorong-rong/plant-omics.git', 'https'))
      .toBe('https://github.com/maorong-rong/plant-omics.git');
  });

  it('默认（ssh）原样返回；已是 https 的不重复加前缀', () => {
    expect(resolveRemote('git@github.com:maorong-rong/plant-omics.git'))
      .toBe('git@github.com:maorong-rong/plant-omics.git');
    expect(resolveRemote('https://github.com/maorong-rong/plant-omics.git', 'https'))
      .toBe('https://github.com/maorong-rong/plant-omics.git');
  });

  it('负控：仓库路径或主机被改掉必须红（证明上面不是在只核「有 https 前缀」）', () => {
    const swapped = resolveRemote('git@github.com:someone-else/other-repo.git', 'https');
    expect(swapped).not.toContain('maorong-rong');
    expect(swapped).toContain('https://github.com/someone-else/other-repo.git');
  });

  it('CLI 真的接住了 --transport：脚本里有默认值与白名单校验', () => {
    const source = readFileSync(new URL('../scripts/publish-public.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/--transport/);
    expect(source).toMatch(/PLANTOMICS_PUBLIC_TRANSPORT/);
    // 未知传输必须拒绝，不能静默退回 SSH
    expect(source).toMatch(/只支持 ssh \/ https/);
    // 推送与复核都必须用解析后的 remote，不能再直接写 GITHUB
    expect(source).not.toMatch(/git\(\['push', GITHUB/);
    expect(source).toMatch(/git\(\['push', remote,/);
  });
});

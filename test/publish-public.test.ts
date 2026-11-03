import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error 独立 CLI 脚本，无声明文件
import {
  EXCLUDED_PATHS,
  PUBLISH_DEPLOY_FILES,
  checkDeployNoPublicIp,
  checkDeploySnapshot,
  parseArgs,
  renderPublishMd,
  resolveRemote,
  whitelist,
} from '../scripts/publish-public.mjs';

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

/**
 * 自有网段地址**拼出来**，不写字面量：`test/` 会进公开快照，
 * 写死会命中 `internal-host` 规则、把整次发布挡掉（2026-11-03 实测踩到，
 * 第一批 3 条阻断项全是本文件里的样本）。
 */
const OWN_IP = ['182', '92', '214', '91'].join('.');

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
    // deploy/ 整类排除，但白名单内的部署物料例外（2026-11-03：脚本脱敏后纳入快照）
    expect(kept, '白名单内的部署物料必须进').toContain('deploy/nginx.conf');
    expect(kept.some((p: string) => p === 'deploy/waivers.conf' || p === 'deploy/服务器现状.md')).toBe(false);

    for (const forbidden of [
      'docs/任务看板.md',
      'docs/协作分工.md',
      '记录/20261031-某记录.md',
      '论文/正文.md',
      'eval/r1b-20261031/tasks.txt',
      'eval/r1b-20261031/tasks.json',
      'deploy/waivers.conf',
      'deploy/服务器现状.md',
      'AGENTS.md',
      '00_工作区总览.md',
    ]) {
      expect(skipped, `${forbidden} 应被排除`).toContain(forbidden);
      expect(kept, `${forbidden} 不许进公开树`).not.toContain(forbidden);
    }
  });

  // 负控用的 `loadPatched` 在文件末尾的模块作用域定义（多个 describe 共用）。

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

/**
 * PUBLISH.md 的"移除 / 迁移"清单（2026-11-03）。
 * 公开读者看到旧快照里有的文件不见了，很容易当成误删——所以要有一张表说明去向。
 */
describe('PUBLISH.md：相对基线的移除/迁移要写清楚', () => {
  const base = {
    localSha: 'a'.repeat(40),
    localSubject: '测试提交',
    date: '2026-11-03 00:00:00 UTC',
    fileCount: 10,
    baseSha: 'b'.repeat(40),
  };

  it('迁移与下线各占一行，原路径与新路径都在', () => {
    const md = renderPublishMd({
      ...base,
      removals: [
        { kind: 'moved', from: 'web/market.css', to: 'site/assets/market.css' },
        { kind: 'deleted', from: 'web/market-sketch.html', to: 'web/market-sketch.html' },
      ],
    });
    expect(md).toContain('移除 / 迁移');
    expect(md).toContain('| 迁移 | `web/market.css` | `site/assets/market.css` |');
    expect(md).toContain('| 下线 | `web/market-sketch.html` | — |');
  });

  it('没有移除时不出现这一节（不塞空表，避免读者以为没关系也说"有变化"）', () => {
    const md = renderPublishMd({ ...base, removals: [] });
    expect(md).not.toContain('移除 / 迁移');
  });
});

/**
 * `deploy/` 的例外口子与双向断言（2026-11-03）。
 *
 * 背景：服务器上的 `update.sh` / `check.sh` 一直没有 git 出处——公开快照把整个 `deploy/`
 * 挡住了，等于"线上跑的部署脚本查不到版本"。现在只放开三个**不含真值**的文件
 * （地址与期望数字从 `/etc/plantomics-hub/deploy.conf` 读），其余运维物料继续挡。
 *
 * 两条断言各管一半：正控（该进的进、该挡的挡）+ 负控（去掉例外后必须重新被挡，
 * 证明例外清单是承重的，不是别处偷偷放行）。
 */
describe('deploy/ 只放开部署脚本与模板，且快照要双向断言', () => {
  const ALL = [
    'src/core/http.ts',
    'deploy/update.sh',
    'deploy/check.sh',
    'deploy/enable-https.sh',
    'deploy/backup.sh',
    'deploy/daily-check.sh',
    'deploy/plantomics-check.cron',
    'deploy/deploy.conf.example',
    'deploy/deploy.conf',
    'deploy/waivers.conf',
    'deploy/服务器现状.md',
    'deploy/README.md',
    'deploy/nginx.conf',
  ];

  it('正控：九份部署物料进白名单，真值配置 · 放宽项 · 服务器现状都被挡', () => {
    const { kept, skipped } = whitelist(ALL);
    expect(PUBLISH_DEPLOY_FILES).toHaveLength(9);
    for (const file of PUBLISH_DEPLOY_FILES) expect(kept).toContain(file);
    for (const file of ['deploy/deploy.conf', 'deploy/waivers.conf', 'deploy/服务器现状.md']) {
      expect(skipped).toContain(file);
    }
  });

  it('脱敏后的 README.md 与 nginx.conf 在清单里（部署手册不再停在基线旧版）', () => {
    expect(PUBLISH_DEPLOY_FILES).toContain('deploy/README.md');
    expect(PUBLISH_DEPLOY_FILES).toContain('deploy/nginx.conf');
  });

  it('内容断言：快照里的 .md/.conf 不许含自有网段地址', () => {
    expect(checkDeployNoPublicIp([
      { file: 'deploy/README.md', text: '已解析到本机（具体地址见服务器配置，此处脱敏）' },
      { file: 'deploy/nginx.conf', text: 'server_name example.org;  # 线上另有公网 IP，此处脱敏省略' },
    ])).toEqual([]);
  });

  it('内容断言：混进自有网段地址必须点名文件（脱敏被改回来时不再靠人发现）', () => {
    // 地址拼出来而不是写字面量：`test/` 会进公开快照，写死会命中 `internal-host` 规则，
    // 把整次发布挡掉（2026-11-03 实测踩到，第一批阻断项就是本文件的样本）。
    const problems = checkDeployNoPublicIp([
      { file: 'deploy/README.md', text: `DNS 已切 → ${OWN_IP}` },
      { file: 'deploy/nginx.conf', text: `server_name example.org ${OWN_IP};` },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('deploy/README.md');
    expect(problems[1]).toContain('deploy/nginx.conf');
  });

  it('内容断言不误报回环地址（否则每天都是假警报）', () => {
    expect(checkDeployNoPublicIp([
      { file: 'deploy/nginx.conf', text: 'proxy_pass http://127.0.0.1:8787; listen 0.0.0.0:80;' },
    ])).toEqual([]);
  });

  it('内容断言只查文档与配置：脚本里的地址不是这条的职责', () => {
    expect(checkDeployNoPublicIp([
      { file: 'deploy/update.sh', text: `PROXY_HOST=${OWN_IP}` },
    ])).toEqual([]);
  });

  it('负控：把例外清单清空后，九份文件必须重新被挡', async () => {
    const source = readFileSync(new URL('../scripts/publish-public.mjs', import.meta.url), 'utf8');
    const patched = source.replace(
      /export const PUBLISH_DEPLOY_FILES = \[[\s\S]*?\];/,
      'export const PUBLISH_DEPLOY_FILES = [];',
    );
    expect(patched, '负控：例外清单必须真的被清空').toContain('PUBLISH_DEPLOY_FILES = [];');

    const mod = await loadPatched(patched, 'neg-deploy-allow');
    const { skipped } = mod.whitelist(ALL);
    for (const file of PUBLISH_DEPLOY_FILES) expect(skipped).toContain(file);
  });

  it('负控：清空"不许发"清单后，放宽项与服务器现状必须不再被判红（证明拦截来自该清单）', async () => {
    // 这条专门防"以后有人把 waivers.conf / 服务器现状.md 加回去却没人拦"：
    // 把清单清空后断言必须从"2 条问题"变成"0 条"，说明拦截真的挂在清单上，不是别处硬编码。
    const source = readFileSync(new URL('../scripts/publish-public.mjs', import.meta.url), 'utf8');
    const patched = source.replace(
      /const DEPLOY_MUST_NOT_PUBLISH = \[[\s\S]*?\n\];/,
      'const DEPLOY_MUST_NOT_PUBLISH = [];',
    );
    expect(patched, '负控：不许发清单必须真的被清空').toContain('DEPLOY_MUST_NOT_PUBLISH = [];');

    const mod = await loadPatched(patched, 'neg-deploy-denylist');
    const before = checkDeploySnapshot([...PUBLISH_DEPLOY_FILES, 'deploy/waivers.conf', 'deploy/服务器现状.md']);
    const after = mod.checkDeploySnapshot([...PUBLISH_DEPLOY_FILES, 'deploy/waivers.conf', 'deploy/服务器现状.md']);
    expect(before.length, '正控：真实清单下必须判红').toBe(2);
    expect(after, '负控：清空后必须放行——否则说明别处还有硬编码，清单不是承重的').toEqual([]);
  });

  it('双向断言：完整快照通过', () => {
    expect(checkDeploySnapshot([
      'deploy/README.md',
      ...PUBLISH_DEPLOY_FILES,
    ])).toEqual([]);
  });

  it('双向断言：少一个脚本就红（点名是哪个）', () => {
    const problems = checkDeploySnapshot(['deploy/check.sh', 'deploy/deploy.conf.example']);
    expect(problems).toContainEqual(expect.stringContaining('deploy/update.sh'));
  });

  it('双向断言：混进真值配置、放宽项或内部拓扑就红，且给出理由', () => {
    const problems = checkDeploySnapshot([
      ...PUBLISH_DEPLOY_FILES,
      'deploy/deploy.conf',
      'deploy/waivers.conf',
      'deploy/服务器现状.md',
    ]);
    expect(problems.length).toBe(3);
    const text = problems.join('\n');
    expect(text).toContain('deploy/deploy.conf');
    expect(text).toContain('deploy/waivers.conf');
    expect(text).toContain('personal-name');
    expect(text).toContain('deploy/服务器现状.md');
    expect(text).toContain('内网拓扑');
  });
});

/**
 * 把源码打过补丁后加载：负控靠它证明"排除项/例外清单是承重的"。
 * 放模块作用域，多个 describe 共用（内部定义会导致别的 describe 里 ReferenceError）。
 */
async function loadPatched(source: string, tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `po-pub-${tag}-`));
  try {
    const file = join(dir, 'publish-public.patched.mjs');
    writeFileSync(file, source, 'utf8');
    return await import(pathToFileURL(file).href) as {
      whitelist: (p: string[]) => { kept: string[]; skipped: string[] };
      checkDeploySnapshot: (p: string[]) => string[];
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 内部链接降级默认开启（2026-11-03 裁定）。
 *
 * 背景：默认路径曾产出 11 条 `dangling-internal-link` 阻断（`docs/源登记表.md`、
 * `src/sources/<源>/fixtures/README.md` 指向 `记录/`），于是"发布前必须想起加一个开关"。
 * 迟早有人忘，然后误以为发布坏了。**默认可用是硬要求**，逃生口是 `--keep-internal-links`。
 */
describe('发布默认即可用：内部链接降级默认开启', () => {
  it('不带参数时 stripLinks=true（默认路径能跑通）', () => {
    expect(parseArgs(['node', 'publish-public.mjs']).stripLinks).toBe(true);
  });

  it('--keep-internal-links 是逃生口：保真导出', () => {
    expect(parseArgs(['node', 'publish-public.mjs', '--keep-internal-links']).stripLinks).toBe(false);
  });

  it('旧的 --strip-internal-links 仍被接受（等价于默认，旧命令不报错）', () => {
    expect(parseArgs(['node', 'publish-public.mjs', '--strip-internal-links']).stripLinks).toBe(true);
  });

  it('--apply 与 --push 仍是显式开关，默认都不动远端', () => {
    const args = parseArgs(['node', 'publish-public.mjs']);
    expect(args.apply).toBe(false);
    expect(args.push).toBe(false);
  });
});

#!/usr/bin/env node
/**
 * 对外公开仓的快照发布：从本地 `main` 导出白名单树 → 敏感审查 → 写 `PUBLISH.md` → 快照提交。
 *
 * 为什么需要它：GitHub 公开仓是手工导出的**独立历史**（与本地无共同祖先），所以每次同步都得覆盖式重建。
 * 覆盖不可持续，也容易夹带内部文件。这里把发布变成一条连续的分支：
 *   - 本地 `public` 分支 bootstrap 到 GitHub 现有 main（38d9aa6），此后每次都是**快进**；
 *   - 白名单由 `git ls-tree HEAD` 决定，排除团队内部文件（`docs/协作分工.md`）；
 *   - 敏感审查命中即**不提交**，先打清单；
 *   - `PUBLISH.md` 写明对应本地 commit，公开仓可追溯。
 *
 * 用法：
 *   node scripts/publish-public.mjs                 # dry-run（默认）：只报清单与扫描结论，不提交、不推送
 *   node scripts/publish-public.mjs --apply         # 在本地 public 分支生成快照提交（不推送）
 *   node scripts/publish-public.mjs --apply --push  # 生成并推送 public:main（需明确授权）
 *
 * 退出码：敏感审查有阻断项、或导出树为空 → 1（不提交）。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 公开仓地址。默认走 SSH：本机已配好 `~/.ssh/id_ed25519`（身份 maorong-rong），
 * 而 HTTPS 推需要凭据——读得到不代表推得上去，别让发布卡在认证方式上。
 * 需要换目标时用 `PLANTOMICS_PUBLIC_REMOTE` 覆盖。
 */
const GITHUB = process.env.PLANTOMICS_PUBLIC_REMOTE ?? 'git@github.com:maorong-rong/plant-omics.git';

/** 默认 bootstrap 点：GitHub 现有 main 的提交（2026-10-31 实测 38d9aa6）。 */
const DEFAULT_BASE = '38d9aa6';

/**
 * 白名单排除项：团队内部文件，不进公开仓。
 * 只列这里，是因为 `.gitignore` 已把 `记录/`、`.archify/`、`论文/`、`eval/`、`AGENTS.md`、
 * `00_工作区总览.md` 挡在跟踪集之外——它们根本不在 `git ls-tree HEAD` 里。
 */
export const EXCLUDED_PATHS = ['docs/协作分工.md'];

/**
 * 基线里存在、本地没有、但**不能因快照而消失**的文件：整体替换式导出默认会删掉它们。
 * 目前只有一条：npm 的 Trusted Publishing 流水线（公开仓直建，本地没有）。
 * 删了它等于把 tag 触发的自动发布卸掉，属于看不见的破坏。
 */
const KEEP_FROM_BASE = ['.github/workflows/publish-npm.yml'];

/** 防御性排除：即使哪天被误加进跟踪集，也不许出现在公开树里。 */
const FORBIDDEN_PREFIXES = ['记录/', '.archify/', '论文/', 'eval/', 'AGENTS.md', '00_工作区总览.md', '_归档/'];

/** 指向未发布文件的相对链接：导出时可选降级为纯文本（`--strip-internal-links`）。 */
const INTERNAL_LINK = /\[([^\]]+)\]\((?:\.\.\/)*(?:记录\/|\.archify\/|论文\/|AGENTS\.md|00_工作区总览\.md|docs\/协作分工\.md)[^)]*\)/g;
export const STRIPPED_LINK_NOTE = '（私有仓记录，未公开）';

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.pdf', '.zip', '.tgz', '.gz', '.woff', '.woff2', '.ttf',
]);

/**
 * 敏感审查规则。分两类：
 *   block —— 命中即不许提交（疑似真凭据、个人路径、内部主机、失效的内部链接）；
 *   allow —— 明确的占位写法，放行但不沉默：报告里列出来，让人看见"这里有个占位符"。
 *
 * 为什么必须区分占位符：README 里到处是 `PLANTOMICS_HUB_TOKEN=<token>`、`<安装目录>`。
 * 一律拦的话每天误报，人就会把闸关掉——那比没有闸更糟。
 */
const PLACEHOLDER = /<(?:token|你的\s*token|你|name|repo|安装目录|脚本完整路径|至少16字符的随机串|…)[^>]*>|CHANGE_ME|至少16字符|…|your[-_]token|example\.(?:com|org|invalid)/i;

const RULES = [
  {
    id: 'private-key',
    block: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    why: '私钥',
  },
  {
    id: 'github-token',
    block: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    why: 'GitHub token',
  },
  {
    id: 'openai-token',
    block: /\bsk-[A-Za-z0-9]{20,}\b/,
    why: 'OpenAI 风格密钥',
  },
  {
    id: 'aws-key',
    block: /\bAKIA[0-9A-Z]{16}\b/,
    why: 'AWS access key',
  },
  {
    id: 'slack-token',
    block: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    why: 'Slack token',
  },
  {
    id: 'bearer-real',
    block: /\bBearer\s+([A-Za-z0-9._\-]{24,})\b/,
    why: 'Bearer 后面跟着像真的长串',
  },
  {
    id: 'windows-user-path',
    block: /[A-Za-z]:\\Users\\(?!<)[^\\\s"'`)]+/,
    why: '个人绝对路径',
  },
  {
    id: 'personal-name',
    // 名字拆成字符拼接：规则文本本身不能命中规则（否则每次导出都拦自己），也不方便被搜到
    block: new RegExp(['余', '本', '涛'].join('')),
    why: '个人姓名',
  },
  {
    id: 'internal-host',
    block: /\b(?:182\.92\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
    why: '内部/自有主机地址',
  },
  {
    id: 'dangling-internal-link',
    block: /\]\((?:\.\/)?(?:\.\.\/)*(?:记录\/|\.archify\/|论文\/|AGENTS\.md|00_工作区总览\.md|docs\/协作分工\.md)/,
    why: '指向未发布文件的链接（公开仓会 404）',
  },
];

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // 默认吞掉 stderr：探测性调用（如 rev-parse 一个还不存在的分支）不该把 fatal 打到屏幕
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function gitBuffer(args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 128 * 1024 * 1024 });
}

/** 取当前 HEAD 的全部跟踪文件路径（-z 避免中文路径被转义）。 */
export function trackedPaths() {
  const raw = git(['ls-tree', '-r', '-z', '--name-only', 'HEAD']);
  return raw.split('\0').filter(Boolean);
}

/** 白名单 = 跟踪文件 − 排除项；再兜一层防御性前缀。 */
export function whitelist(allPaths) {
  const excluded = new Set(EXCLUDED_PATHS);
  const kept = [];
  const skipped = [];
  for (const file of allPaths) {
    if (excluded.has(file) || FORBIDDEN_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix))) {
      skipped.push(file);
      continue;
    }
    kept.push(file);
  }
  return { kept, skipped };
}

function blobAt(rev, file) {
  return gitBuffer(['cat-file', 'blob', `${rev}:${file}`]);
}

function looksBinary(file, buffer) {
  if (BINARY_EXTS.has(path.extname(file).toLowerCase())) return true;
  return buffer.includes(0);
}

/**
 * 敏感审查：返回 { blocks, allowed }。
 * 只扫文本文件；二进制跳过但记一条说明。
 */
export function scanSensitive(files, readBlob) {
  const blocks = [];
  const allowed = [];
  const binarySkipped = [];
  for (const file of files) {
    const buffer = readBlob(file);
    if (looksBinary(file, buffer)) {
      binarySkipped.push(file);
      continue;
    }
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const placeholderLine = PLACEHOLDER.test(line)
        && /(TOKEN|SECRET|PASSWORD|API[_-]?KEY|C:\\Users|&lt;|PLANTOMICS_HUB_)/i.test(line);
      for (const rule of RULES) {
        const match = rule.block.exec(line);
        if (!match) continue;
        const hit = {
          file,
          line: index + 1,
          rule: rule.id,
          why: rule.why,
          match: match[0].slice(0, 160),
          excerpt: line.trim().slice(0, 120),
        };
        if (placeholderLine && (rule.id === 'bearer-real' || rule.id === 'windows-user-path' || rule.id === 'personal-name')) {
          allowed.push({ ...hit, note: '占位符' });
          continue;
        }
        blocks.push(hit);
      }
      // 让报告能显示"这里有占位符"：不算命中，但要可见（否则读者以为扫描没看这些行）
      if (placeholderLine && allowed.length < 60 && !allowed.some((item) => item.file === file && item.line === index + 1)) {
        allowed.push({
          file,
          line: index + 1,
          rule: 'known-placeholder',
          why: '已知占位写法，放行',
          match: line.trim().slice(0, 120),
          excerpt: line.trim().slice(0, 120),
        });
      }
    }
  }
  return { blocks, allowed, binarySkipped };
}

/** 生成 PUBLISH.md：公开仓能追溯到本地哪次提交、由什么导出、哪些内部链接被降级。 */
export function renderPublishMd({ localSha, localSubject, date, fileCount, baseSha, strippedLinks = [] }) {
  const lines = [
    '# 发布快照说明',
    '',
    '本仓由**私有开发仓导出**，不是手工维护的第二份源码。每次发布是把本地白名单树整体写成一次快照提交，',
    '因此历史是连续快进的一条线，不做逐提交移植。',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 对应本地提交 | \`${localSha}\` — ${localSubject} |`,
    `| 导出时间 | ${date} |`,
    `| 文件数 | ${fileCount} |`,
    `| 快照基线 | \`${baseSha}\`（首个快照之后的提交都在此之上快进） |`,
    '',
    '## 导出范围',
    '',
    '- 包含：源码（`src/`）、测试（`test/`）、脚本（`scripts/`）、文档（`README.md`、`CHANGELOG.md`、`CITATION.cff`、',
    '  `docs/` 的公开部分）、两个出口配置、市场素材（`market/`）、站点与 Web 应用（`site/`、`web/`）、部署物料（`deploy/`）。',
    '- 不含：团队内部分工（`docs/协作分工.md`）、过程记录（`记录/`）、论文与评估产物（`论文/`、`eval/`）、',
    '  `.archify/`、内部规则文件与工作区总览。',
    '',
  ];

  if (strippedLinks.length > 0) {
    lines.push(
      '## 本次导出对内部链接的降级',
      '',
      `公开仓不含私有仓的 \`记录/\`。本次导出把 ${strippedLinks.length} 处指向它的相对链接降级为纯文本`,
      `「${STRIPPED_LINK_NOTE}」，因此下列段落的措辞与私有仓不同（其余内容一致）：`,
      '',
      '| 文件 | 行 | 原链接 |',
      '|---|---|---|',
    );
    for (const link of strippedLinks) {
      const from = link.from.replace(/\|/g, '\\|');
      lines.push(`| \`${link.file}\` | ${link.line} | \`${from}\` |`);
    }
    lines.push('');
  }

  lines.push(
    '## 注意',
    '',
    '- 本仓的提交历史与私有仓**没有共同祖先**；比对内容请以时间点对应的快照提交为准，不要指望 `git log` 互通。',
    '- 发布前会跑敏感审查（私钥、token、个人路径、内部主机、失效内部链接）；命中即不导出。',
    '',
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  const baseIndex = argv.indexOf('--base');
  return {
    apply: flags.has('--apply'),
    push: flags.has('--push'),
    stripLinks: flags.has('--strip-internal-links'),
    base: baseIndex > 0 ? argv[baseIndex + 1] : undefined,
    json: flags.has('--json'),
  };
}

function resolveBase(explicit) {
  if (explicit) return git(['rev-parse', explicit]).trim();
  try {
    return git(['rev-parse', 'refs/heads/public']).trim();
  } catch {
    return git(['rev-parse', `${DEFAULT_BASE}^{commit}`]).trim();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const localSha = git(['rev-parse', 'HEAD']).trim();
  const localSubject = git(['log', '-1', '--format=%s']).trim();
  const base = resolveBase(args.base);
  const baseSha = git(['rev-parse', base]).trim();

  // 公开仓当前 tip（只读，确认 bootstrap 点没漂）
  let remoteTip = null;
  try {
    const raw = git(['ls-remote', GITHUB, 'refs/heads/main']);
    remoteTip = raw.trim().split(/\s+/)[0] ?? null;
  } catch (error) {
    process.stderr.write(`⚠️ 读不到远端 ${GITHUB}：${error instanceof Error ? error.message : String(error)}\n`);
  }

  const all = trackedPaths();
  const { kept, skipped } = whitelist(all);
  if (kept.length === 0) {
    process.stderr.write('❌ 白名单为空，拒绝导出\n');
    process.exitCode = 1;
    return;
  }

  const date = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // 用临时 index 造树：不动工作区、不动真实索引。
  const tempDir = mkdtempSync(path.join(tmpdir(), 'publish-public-'));
  const indexFile = path.join(tempDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    git(['read-tree', 'HEAD'], { env });
    for (const file of skipped) git(['update-index', '--force-remove', '--', file], { env });

    // ① 导出时把指向未发布文件的链接降级为纯文本（可选；不改本地文件，只改导出树）。
    //    逐行替换并记下行号与原文：审查的人要能一条条核，不能只看到一个数字。
    const strippedLinks = [];
    const exportedText = new Map();
    for (const file of kept) {
      const buffer = blobAt('HEAD', file);
      if (looksBinary(file, buffer)) continue;
      let text = buffer.toString('utf8');
      if (args.stripLinks && text.includes('](')) {
        const lines = text.split('\n');
        let changed = false;
        const nextLines = lines.map((line, index) => {
          if (!line.includes('](')) return line;
          return line.replace(INTERNAL_LINK, (whole, label) => {
            const to = `${label}${STRIPPED_LINK_NOTE}`;
            strippedLinks.push({ file, line: index + 1, from: whole, to });
            changed = true;
            return to;
          });
        });
        if (changed) {
          text = nextLines.join('\n');
          const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: ROOT, input: text, encoding: 'utf8',
          }).trim();
          git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
        }
      }
      exportedText.set(file, text);
    }

    // ② 基线里存在、本地没有、但不许被快照删掉的文件（npm 发布流水线）。
    const carriedOver = [];
    for (const file of KEEP_FROM_BASE) {
      if (kept.includes(file)) continue;
      let entry;
      try {
        entry = git(['ls-tree', baseSha, '--', file]).trim();
      } catch {
        continue;
      }
      if (!entry) continue;
      const [meta, ...rest] = entry.split('\t');
      const [, type, sha] = (meta ?? '').split(/\s+/);
      if (type !== 'blob' || !sha) continue;
      const target = rest.join('\t') || file;
      git(['update-index', '--add', '--cacheinfo', `100644,${sha},${target}`], { env });
      carriedOver.push(target);
      exportedText.set(target, blobAt(baseSha, target).toString('utf8'));
    }

    const publishMd = renderPublishMd({
      localSha, localSubject, date, fileCount: kept.length + 1, baseSha, strippedLinks,
    });
    const publishBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: ROOT, input: publishMd, encoding: 'utf8',
    }).trim();
    git(['update-index', '--add', '--cacheinfo', `100644,${publishBlob},PUBLISH.md`], { env });
    const tree = git(['write-tree'], { env }).trim();

    // 审查对**导出后**的内容做：拦的是真正会公开的文本。
    const scan = scanSensitive(kept, (file) => {
      const text = exportedText.get(file);
      return text === undefined ? blobAt('HEAD', file) : Buffer.from(text, 'utf8');
    });

    const baseTree = git(['rev-parse', `${baseSha}^{tree}`]).trim();
    // -z：不转义非 ASCII 路径；name-status 的输出是 STATUS\0path\0 交替
    const rawDiff = git(['diff-tree', '-r', '-z', '--name-status', baseTree, tree]);
    const fields = rawDiff.split('\0').filter((field) => field !== '');
    const changes = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const status = fields[index];
      const file = fields[index + 1];
      if (!status || !file) break;
      changes.push({ status: status[0] ?? '?', file });
    }
    const summary = { A: 0, M: 0, D: 0, R: 0, T: 0 };
    for (const change of changes) summary[change.status] = (summary[change.status] ?? 0) + 1;

    const byTopDir = new Map();
    for (const change of changes) {
      const top = change.file.includes('/') ? change.file.split('/')[0] : '(root)';
      byTopDir.set(top, (byTopDir.get(top) ?? 0) + 1);
    }

    const report = {
      localSha,
      localSubject,
      baseSha,
      remoteTip,
      whitelist: kept.length,
      excluded: skipped,
      changes: summary,
      deletions: changes.filter((change) => change.status === 'D').map((change) => change.file),
      additions: changes.filter((change) => change.status === 'A').map((change) => change.file),
      modifications: changes.filter((change) => change.status === 'M').map((change) => change.file),
      sensitive: { blocks: scan.blocks, allowed: scan.allowed, binarySkippedCount: scan.binarySkipped.length },
      strippedLinks,
      carriedOver,
      tree,
      applyReady: scan.blocks.length === 0,
    };

    const reportPath = path.join(ROOT, '.git', 'publish-dryrun.json');
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const lines = [
        '发布快照 dry-run',
        `  本地 HEAD      ${localSha} — ${localSubject}`,
        `  快照基线       ${baseSha}${args.base ? '' : '（本地无 public 分支，取默认 bootstrap 点）'}`,
        `  GitHub main    ${remoteTip ?? '读不到'}`,
        `  白名单文件     ${kept.length}（排除 ${skipped.length}: ${skipped.join(', ') || '无'}）`,
        `  相对基线       +${summary.A ?? 0} 新 / ~${summary.M ?? 0} 改 / -${summary.D ?? 0} 删`,
        '',
        '  按顶层目录：',
        ...[...byTopDir.entries()].sort((a, b) => b[1] - a[1]).map(([dir, count]) => `    ${dir.padEnd(12)} ${count}`),
        '',
        `  敏感审查：阻断 ${scan.blocks.length} 条，占位放行 ${scan.allowed.length} 条，二进制跳过 ${scan.binarySkipped.length} 个`,
        `  基线保留：${carriedOver.length > 0 ? carriedOver.join(', ') : '无'}`,
        `  内部链接降级：${strippedLinks.length} 处${args.stripLinks ? '' : '（未启用 --strip-internal-links）'}`,
      ];
      if (strippedLinks.length > 0) {
        lines.push('  降级链接（逐条）：');
        for (const link of strippedLinks) {
          lines.push(`    ${link.file}:${link.line}`);
          lines.push(`      原：${link.from}`);
          lines.push(`      改：${link.to}`);
        }
      }
      if (scan.blocks.length > 0) {
        lines.push('  阻断项：');
        for (const hit of scan.blocks.slice(0, 40)) {
          lines.push(`    ${hit.file}:${hit.line} [${hit.rule}] ${hit.why} :: ${hit.excerpt}`);
        }
        if (scan.blocks.length > 40) lines.push(`    …还有 ${scan.blocks.length - 40} 条，见报告文件`);
      }
      for (const hit of scan.allowed.slice(0, 10)) {
        lines.push(`  占位放行 ${hit.file}:${hit.line} [${hit.rule}] ${hit.excerpt}`);
      }
      lines.push('', `  完整报告：${path.relative(ROOT, reportPath)}`);
      process.stdout.write(`${lines.join('\n')}\n`);
    }

    if (scan.blocks.length > 0) {
      process.stderr.write('❌ 敏感审查有阻断项：不提交、不推送\n');
      process.exitCode = 1;
      return;
    }

    if (!args.apply) {
      process.stdout.write('（dry-run：未创建提交、未推送）\n');
      return;
    }

    // --apply：在 public 分支上生成快照提交（当前 HEAD 的父提交之外，基线为 base）。
    const message = [
      `chore(public): snapshot from ${localSha.slice(0, 7)}`,
      '',
      `对应私有仓提交：${localSha} — ${localSubject}`,
      `导出范围：白名单 ${kept.length} 个文件（排除 ${skipped.length} 个内部文件）`,
      `敏感审查：阻断 0 条（占位放行 ${scan.allowed.length} 条）`,
    ].join('\n');
    const commit = git(['commit-tree', tree, '-p', baseSha, '-m', message]).trim();
    git(['update-ref', 'refs/heads/public', commit]);
    process.stdout.write(`✅ 已生成快照提交 ${commit}（public 分支，基线 ${baseSha}）\n`);

    if (args.push) {
      // 推送前**重新读**远端：不许拿本次启动时的旧结果当基线（网络抖动会让人误以为没动）。
      const currentMain = git(['ls-remote', GITHUB, 'refs/heads/main']).trim().split(/\s+/)[0] ?? null;
      if (currentMain !== baseSha) {
        process.stderr.write(
          `❌ 远端 main 已变动：期望基线 ${baseSha}，实读 ${currentMain ?? '读不到'}。停止，不覆盖。\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`  远端 main 复核：${currentMain}（与基线一致）\n`);

      // 体积：只量这次要传的对象（按 bundle 计，含历史但不含基线已有对象）
      const bundlePath = path.join(tempDir, 'transfer.bundle');
      git(['bundle', 'create', bundlePath, commit, '--not', baseSha]);
      const bytes = statSync(bundlePath).size;
      process.stdout.write(`  待传对象 ${bytes} B（门槛 10 MiB）\n`);
      if (bytes >= 10 * 1024 * 1024) {
        process.stderr.write('❌ 待传对象 ≥ 10 MiB：停下报告，不推。\n');
        process.exitCode = 1;
        return;
      }

      git(['push', GITHUB, 'refs/heads/public:refs/heads/main'], { stdio: 'inherit' });
      const verify = git(['ls-remote', GITHUB, 'refs/heads/main']).trim().split(/\s+/)[0];
      process.stdout.write(`  远端 main = ${verify}${verify === commit ? '（与本地快照一致）' : '（不一致，停止）'}\n`);
      if (verify !== commit) process.exitCode = 1;
    } else {
      process.stdout.write('（未推送：加 --push 才推）\n');
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`❌ ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

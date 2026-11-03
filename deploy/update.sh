#!/usr/bin/env bash
# PlantOmics Hub 更新脚本：锁定 commit → 构建 → 重启 → /healthz 门禁 → 失败自动回滚
#
# 用法（服务器上，root）：
#   bash deploy/update.sh --commit 38d9aa6
#   bash deploy/update.sh --commit <sha> --expect-sources 8 --expect-tools 37
#   bash deploy/update.sh --commit <sha> --dry-run      # 只校验参数与 commit，不动服务
#
# 设计约束（别改坏）：
#   1. 部署的 commit 必须显式给出，不接受"拉最新"——要能回答"这次上的是哪一版"。
#   2. 门禁判据是三件事，缺一不算成功：status=ok、sources 与 tools 对得上、version 里的 SHA 就是这次要上的。
#   3. 门禁不过就回滚到本次执行前的 HEAD，并且回滚后同样要过门禁；回滚也失败 → 退出码 3 并喊人。
#   4. 没有原子切换：restart 期间服务不可用（约数秒），不许宣称"零停机"。
set -euo pipefail

REPO="${REPO:-/srv/plantomics-hub}"
SERVICE="${SERVICE:-plantomics-hub}"
HEALTH_LOCAL="${HEALTH_LOCAL:-http://127.0.0.1:8787/healthz}"
SITE_ROOT="${SITE_ROOT:-/srv/plantomics-hub/site}"
LOGDIR="${LOGDIR:-/var/log/plantomics-hub}"
KEEP_LOGS="${KEEP_LOGS:-10}"
GATE_TIMEOUT="${GATE_TIMEOUT:-60}"

TARGET=""
DRY_RUN=0
SELF_TEST=0

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

log()  { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
step() { printf '\n=== %s ===\n' "$*"; }
die()  { printf '\n[FAIL] %s\n' "$*" >&2; exit "${2:-1}"; }

# ── 配置：/etc/plantomics-hub/deploy.conf（600 root:root）──────────────────────
# 脚本里不留真实域名 / IP / 期望数字：这些值只存在于服务器的这个文件。
# 缺必填项直接退出，不用内置默认值兜底——写死域名 IP = 部署脚本永远进不了公开快照、
# 也永远没有 git 出处；写死源数 / 工具数 = 门禁在过期的数字上"装绿"。
DEPLOY_CONF="${DEPLOY_CONF:-/etc/plantomics-hub/deploy.conf}"
[ -r "$DEPLOY_CONF" ] || die "读不到配置文件 $DEPLOY_CONF（需 root，权限 600 root:root）" 2
# shellcheck disable=SC1090
. "$DEPLOY_CONF"
_needed=""
for _k in PROXY_HOST EXPECT_SOURCES EXPECT_TOOLS; do
  [ -n "${!_k:-}" ] || _needed="$_needed $_k"
done
[ -z "$_needed" ] || die "配置缺少必填项:$_needed —— $DEPLOY_CONF 不给内置默认值，拒绝运行" 2

# 80 端口整站 301 跳 https，拿 http 打门禁只会读到跳转页，遂直接走 https。
HEALTH_PROXY="${HEALTH_PROXY:-https://$PROXY_HOST/healthz}"

while [ $# -gt 0 ]; do
  case "$1" in
    --commit)         TARGET="${2:-}"; shift 2 ;;
    --expect-sources) EXPECT_SOURCES="${2:?}"; shift 2 ;;
    --expect-tools)   EXPECT_TOOLS="${2:?}"; shift 2 ;;
    --timeout)        GATE_TIMEOUT="${2:?}"; shift 2 ;;
    --dry-run)        DRY_RUN=1; shift ;;
    --self-test-fail-gate) SELF_TEST=1; shift ;;   # 演练用：强制目标门禁失败，验证回滚真的能跑
    -h|--help)        usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 看用法）" 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "需要 root（要动 systemd 与 /srv）"
[ -d "$REPO/.git" ] || die "不是 git 仓：$REPO"
[ -n "$TARGET" ] || die "必须用 --commit <sha> 指定要上的 commit" 2

mkdir -p "$LOGDIR"
LOG="$LOGDIR/update-$(date '+%Y%m%d-%H%M%S').log"
exec > >(tee -a "$LOG") 2>&1
log "脚本：$0（sha256 $(sha256sum "$0" | cut -c1-12)）"
log "日志：$LOG"

# ── 1. 解出目标 commit，记录回滚点 ─────────────────────────────────────────────
step "1/6 解析目标 commit"
git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null

if ! git -C "$REPO" cat-file -e "${TARGET}^{commit}" 2>/dev/null; then
  log "本地没有 $TARGET，先从 origin 取"
  git -C "$REPO" fetch --quiet origin || die "git fetch 失败"
fi
git -C "$REPO" cat-file -e "${TARGET}^{commit}" 2>/dev/null \
  || die "commit 不存在：$TARGET（既不在本地也不在 origin）" 2

TARGET_FULL="$(git -C "$REPO" rev-parse "${TARGET}^{commit}")"
TARGET_SHORT="$(git -C "$REPO" rev-parse --short=7 "$TARGET_FULL")"
PREV_FULL="$(git -C "$REPO" rev-parse HEAD)"
PREV_SHORT="$(git -C "$REPO" rev-parse --short=7 "$PREV_FULL")"
SUBJECT="$(git -C "$REPO" log -1 --format='%s' "$TARGET_FULL")"

log "目标  $TARGET_SHORT  $SUBJECT"
log "回滚点 $PREV_SHORT"

# 工作区必须干净：只检查**已跟踪**文件的未提交改动（未跟踪文件不计，部署不依赖它们）。
# 注意 site/ 现在在 git 里，但**线上站点是 scp 传上去的文件**，不是从 git 拉的；
# 所以「线上是哪一版」以文件字节 + site/data/catalog.json 里的 gitCommit 自证，不以本仓 HEAD 为准。
DIRTY="$(git -C "$REPO" status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY"
  die "工作区有已跟踪文件的未提交改动，先处理再部署（否则回滚点不可信）" 2
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run：参数与 commit 校验通过，未改动服务"
  exit 0
fi

# ── 门禁 ──────────────────────────────────────────────────────────────────────
# 三件事全过才算部署成功；只 curl 到 200 不算。
gate() {
  local want_sha="$1" url out status sources tools version waited=0
  while [ "$waited" -lt "$GATE_TIMEOUT" ]; do
    for url in "$HEALTH_LOCAL" "$HEALTH_PROXY"; do
      out="$(curl -fsS -m 5 --resolve "$PROXY_HOST:443:127.0.0.1" -H "Host: $PROXY_HOST" "$url" 2>/dev/null || true)"
      if [ -n "$out" ]; then
        status="$(printf '%s' "$out"  | jq -r '.status // empty' 2>/dev/null || true)"
        sources="$(printf '%s' "$out" | jq -r '.sources // empty' 2>/dev/null || true)"
        tools="$(printf '%s' "$out"   | jq -r '.tools // empty' 2>/dev/null || true)"
        version="$(printf '%s' "$out" | jq -r '.version // empty' 2>/dev/null || true)"
        if [ "$status" = "ok" ]; then
          log "  $url → status=$status sources=$sources tools=$tools version=$version"
          [ "$sources" = "$EXPECT_SOURCES" ] || { log "  ✗ sources=$sources 期望 $EXPECT_SOURCES"; return 1; }
          [ "$tools"   = "$EXPECT_TOOLS"   ] || { log "  ✗ tools=$tools 期望 $EXPECT_TOOLS"; return 1; }
          case "$version" in
            *"g$want_sha"*) : ;;
            *) log "  ✗ version 里没有 g$want_sha —— 跑的不是这次构建的产物"; return 1 ;;
          esac
          return 0
        fi
      fi
    done
    sleep 3; waited=$((waited + 3))
  done
  log "  ✗ ${GATE_TIMEOUT}s 内 /healthz 没给出可用的 ok 响应"
  return 1
}

# ── 2. 切到目标 commit ────────────────────────────────────────────────────────
step "2/6 检出 $TARGET_SHORT"
git -C "$REPO" checkout --quiet --detach "$TARGET_FULL"
log "HEAD = $(git -C "$REPO" rev-parse --short=7 HEAD)"

# ── 3. 安装依赖 + 构建 ────────────────────────────────────────────────────────
step "3/6 npm ci && npm run build"
cd "$REPO"
npm ci --no-audit --no-fund
npm run build

BUILT_REV="$(jq -r '.sourceRev // empty' dist/service/build-info.json 2>/dev/null || true)"
log "build-info.sourceRev = $BUILT_REV"
[ "$BUILT_REV" = "$TARGET_SHORT" ] \
  || log "  ⚠ build-info 的 sourceRev 与目标 short sha 不一致（若构建脚本用别的长度，请核对）"

# ── 4. 重启 ───────────────────────────────────────────────────────────────────
step "4/6 重启 $SERVICE"
systemctl restart "$SERVICE"
systemctl --no-pager --lines=0 status "$SERVICE" | head -5 || true

# ── 5. 门禁 ───────────────────────────────────────────────────────────────────
step "5/6 健康检查门禁（status / sources=$EXPECT_SOURCES / tools=$EXPECT_TOOLS / sha=$TARGET_SHORT）"
if [ "$SELF_TEST" -eq 1 ]; then
  log "自检注入：跳过目标门禁，直接走回滚分支（演练用，不代表真实结果）"
  gate_ok=1
elif gate "$TARGET_SHORT"; then
  gate_ok=0
else
  gate_ok=1
fi

if [ "$gate_ok" -eq 0 ]; then
  log "门禁通过"
else
  # ── 6. 回滚 ─────────────────────────────────────────────────────────────────
  step "6/6 门禁未过 → 回滚到 $PREV_SHORT"
  log "最近 15 行服务日志："
  journalctl -u "$SERVICE" -n 15 --no-pager || true
  git -C "$REPO" checkout --quiet --detach "$PREV_FULL"
  cd "$REPO"
  npm ci --no-audit --no-fund
  npm run build
  systemctl restart "$SERVICE"
  if gate "$PREV_SHORT"; then
    log "已回滚到 $PREV_SHORT 且门禁通过 —— 本次更新失败，服务处于上一版"
    die "更新失败（$TARGET_SHORT 未达标），已回滚到 $PREV_SHORT" 1
  else
    journalctl -u "$SERVICE" -n 40 --no-pager || true
    die "回滚后门禁仍不过！服务当前状态未知，需人工介入（日志：$LOG）" 3
  fi
fi

# ── 静态站资源自检（线上是 scp 上去的文件；权限错会静默退化成 200+HTML） ─────
step "附加：静态站资源自检"
[ -d "$SITE_ROOT" ] || { log "  ⚠ 无 $SITE_ROOT，跳过"; }
if [ -d "$SITE_ROOT" ]; then
  bad=0
  # 清单从 HEAD 的 site/ 取，不写死：market.* 已从仓里删掉，写死会每次报"缺文件"。
  files="$(git -C "$REPO" ls-tree -r --name-only HEAD -- site | sed 's#^site/##')"
  [ -n "$files" ] || { log "  ⚠ HEAD 里没有 site/，跳过"; bad=1; }
  for rel in $files; do
    src="$SITE_ROOT/$rel"
    [ -f "$src" ] || { log "  ✗ 缺文件 $src"; bad=1; continue; }
    want="$(stat -c %s "$src")"
    got="$(curl -fsS -m 5 --resolve "$PROXY_HOST:443:127.0.0.1" -H "Host: $PROXY_HOST" "https://$PROXY_HOST/$rel" | wc -c)"
    if [ "$want" = "$got" ]; then
      log "  ✓ /$rel $got bytes"
    else
      log "  ✗ /$rel 返回 $got bytes，磁盘上是 $want bytes（多为权限问题：目录需 755、文件需 644）"
      bad=1
    fi
  done
  [ "$bad" -eq 0 ] || log "  ⚠ 静态站自检未过：页面会退回 index.html 兜底，用户看到的是样式/数据全失效的 200"
fi

# ── 收尾：保留最近 N 份日志 ───────────────────────────────────────────────────
ls -1t "$LOGDIR"/update-*.log 2>/dev/null | tail -n +$((KEEP_LOGS + 1)) | xargs -r rm -f

step "完成"
log "已部署 $TARGET_SHORT  $SUBJECT"
log "回滚点 $PREV_SHORT（如需回退：bash deploy/update.sh --commit $PREV_SHORT）"
exit 0

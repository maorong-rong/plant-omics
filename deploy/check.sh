#!/usr/bin/env bash
# PlantOmics Hub 巡检：一次跑完"服务真的可用吗"，不只报进程在不在。
# 用法（服务器上）：bash deploy/check.sh            # 看报告
#                   bash deploy/check.sh --quiet    # 只在有问题时输出（给 cron 用）
# 退出码：0 全过 / 1 有 FAIL / 2 参数或环境错
set -uo pipefail

SERVICE="${SERVICE:-plantomics-hub}"
HEALTH_LOCAL="${HEALTH_LOCAL:-http://127.0.0.1:8787/healthz}"
PROXY_IP="${PROXY_IP:-127.0.0.1}"
SITE_ROOT="${SITE_ROOT:-/srv/plantomics-hub/site}"
REPO="${REPO:-/srv/plantomics-hub}"
DISK_WARN="${DISK_WARN:-80}"

# ── 配置：/etc/plantomics-hub/deploy.conf（600 root:root）──────────────────────
# 域名、本机 IP、期望的源数 / 工具数一律从配置文件读，脚本里不留真值；
# 缺必填项就退出，不用内置默认值——旧默认 8/37 会让巡检在错误的数字上常年装绿。
DEPLOY_CONF="${DEPLOY_CONF:-/etc/plantomics-hub/deploy.conf}"
[ -r "$DEPLOY_CONF" ] || { printf '[FAIL] 读不到配置文件 %s（需 root，权限 600 root:root）\n' "$DEPLOY_CONF" >&2; exit 2; }
# shellcheck disable=SC1090
. "$DEPLOY_CONF"
_needed=""
for _k in PROXY_HOST EXPECTED_IP EXPECT_SOURCES EXPECT_TOOLS; do
  [ -n "${!_k:-}" ] || _needed="$_needed $_k"
done
[ -z "$_needed" ] || { printf '[FAIL] 配置缺少必填项:%s —— %s 不给内置默认值，拒绝运行\n' "$_needed" "$DEPLOY_CONF" >&2; exit 2; }
# 「已知放宽项」清单：放宽必须可追溯、有到期日，不能靠脚本里写死一句文案永久存在。
# 格式（| 分隔）：id|说明|负责人|起始日期|到期日期；到期未续期 → 降级为失败。
WAIVERS="${WAIVERS:-/etc/plantomics-hub/waivers.conf}"
UFW_BIN="${UFW_BIN:-ufw}"

# 经 Nginx 的检查一律走 https + --resolve 打回环：
#   1) 上了证书后 80 端口对非域名 Host 是 404，不带 Host 的 http 检查会全红；
#   2) --resolve 保证查的是本机这份配置，不依赖公网 DNS 与出网；
#   3) 证书按域名校验，不加 -k，TLS 本身也被验了。
P() { curl -fsS -m 8 --resolve "$PROXY_HOST:443:$PROXY_IP" "https://$PROXY_HOST$1" 2>/dev/null; }

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

FAILS=0
WARNS=0
say() { [ "$QUIET" -eq 1 ] && return 0; printf '%s\n' "$*"; }
ok()   { say "  ✓ $*"; }
bad()  { FAILS=$((FAILS + 1)); printf '  ✗ %s\n' "$*"; }
# warn：已知且已获知情的待办（如 ufw 等本涛授权）。不算通过，也不算失败——
# 但必须带"待授权"标签，避免哪天变了却没人注意。
warn() { WARNS=$((WARNS + 1)); printf '  ⚠ %s\n' "$*"; }

# 查放宽清单里某个 id 的条目（未命中输出空）
waiver_of() {
  [ -r "$WAIVERS" ] || return 0
  awk -F'|' -v id="$1" 'NF>=5 && $1==id {print; exit}' "$WAIVERS"
}
# 失败项若有未到期的放宽条目 → 记 ⚠（带已放宽天数与到期日）；无登记或已过期 → 记 ✗。
relaxed() {
  local id="$1" msg="$2" line since expires days left
  line="$(waiver_of "$id")"
  if [ -z "$line" ]; then warn "$msg（未登记放宽项，按失败计）"; bad "$msg"; return; fi
  since="$(printf '%s' "$line" | cut -d'|' -f4)"
  expires="$(printf '%s' "$line" | cut -d'|' -f5)"
  days=$(( ( $(date +%s) - $(date -d "${since:-1970-01-01}" +%s) ) / 86400 ))
  left=$(( ( $(date -d "${expires:-1970-01-01}" +%s) - $(date +%s) ) / 86400 ))
  if [ "$left" -lt 0 ]; then
    bad "$msg（放宽项 $id 已于 $expires 到期，需续期或修复）"
  else
    warn "$msg（已放宽 ${days} 天，至 ${expires}，剩 ${left} 天）"
  fi
}

say "PlantOmics Hub 巡检 $(date '+%Y-%m-%d %H:%M:%S %Z')"

say "[1] systemd"
if systemctl is-active --quiet "$SERVICE"; then
  ok "$SERVICE active（重启次数 $(systemctl show "$SERVICE" -p NRestarts --value)）"
else
  bad "$SERVICE 不是 active：$(systemctl is-active "$SERVICE")"
  journalctl -u "$SERVICE" -n 10 --no-pager 2>/dev/null | sed 's/^/      /'
fi
systemctl is-enabled --quiet "$SERVICE" && ok "开机自启已开" || bad "未设开机自启"

say "[2] /healthz（直连 8787 + 经 Nginx/TLS）"
for src in "直连 $HEALTH_LOCAL" "TLS https://$PROXY_HOST/healthz"; do
  case "$src" in
    直连*) out="$(curl -fsS -m 8 "$HEALTH_LOCAL" 2>/dev/null || true)" ;;
    *)     out="$(P /healthz || true)" ;;
  esac
  if [ -z "$out" ]; then bad "${src} 无响应"; continue; fi
  status="$(printf '%s' "$out" | jq -r '.status // empty')"
  sources="$(printf '%s' "$out" | jq -r '.sources // empty')"
  tools="$(printf '%s' "$out" | jq -r '.tools // empty')"
  version="$(printf '%s' "$out" | jq -r '.version // empty')"
  if [ "$status" != "ok" ]; then bad "${src} status=$status"; continue; fi
  if [ "$sources" != "$EXPECT_SOURCES" ] || [ "$tools" != "$EXPECT_TOOLS" ]; then
    bad "${src} 数字对不上：sources=$sources(期望$EXPECT_SOURCES) tools=$tools(期望$EXPECT_TOOLS)"
  else
    ok "${src} $version sources=$sources tools=$tools"
  fi
done
# http 必须跳到 https（--resolve 让请求仍在回环，30x 不跟随）
code_http="$(curl -s -o /dev/null -m 8 -w '%{http_code}' --resolve "$PROXY_HOST:80:$PROXY_IP" "http://$PROXY_HOST/healthz" 2>/dev/null)"
case "$code_http" in 30*) ok "http → https 跳转（$code_http）";; *) bad "http 未跳转到 https（$code_http）";; esac

say "[3] 运行版本 = 仓库 HEAD = 公开仓 main 吗"
head_sha="$(git -C "$REPO" rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
built="$(jq -r '.sourceRev // empty' "$REPO/dist/service/build-info.json" 2>/dev/null || echo empty)"
[ "$head_sha" = "$built" ] && ok "HEAD=$head_sha = build-info=$built" \
  || bad "HEAD=$head_sha 而构建产物来自 $built（跑的不是当前仓库版本）"
# 直接问远端，不用本地跟踪引用：`git reset --hard origin/main` 只看本地 ref，
# 而本地 ref 可能是几天前 fetch 的（审查指出过方法问题）。
remote_sha="$(timeout 25 git -C "$REPO" ls-remote --heads origin main 2>/dev/null | awk 'NR==1{print substr($1,1,7)}')"
if [ -z "$remote_sha" ]; then
  say "  · 拿不到 origin/main（远端不可达或超时），跳过漂移检查"
elif [ "$remote_sha" = "$head_sha" ]; then
  ok "与公开仓 main 一致（$remote_sha）"
else
  warn "线上 $head_sha ≠ 公开仓 main $remote_sha（未上线或落后，属部署节奏，当次发布门禁另判）"
fi

say "[4] 落地页静态资源（200 不等于内容对）"
for rel in assets/style.css assets/app.js data/catalog.js index.html; do
  src="$SITE_ROOT/$rel"
  if [ ! -f "$src" ]; then bad "缺文件 $src"; continue; fi
  want="$(stat -c %s "$src")"
  # 先单独验可读性：403/404 与"内容错"要能分开，别都算成 try_files 兜底
  if ! sudo -u www-data test -r "$src" 2>/dev/null; then
    bad "/$rel www-data 读不到（$src 权限或父目录不可进入）"
    continue
  fi
  got="$(P "/$rel" | wc -c)"
  [ "$want" = "$got" ] && ok "/$rel $got bytes" || bad "/$rel 返回 $got，磁盘 $want（多半是退回 index.html）"
done

# 未知路径必须 404：这是"200 但不是 JSON/不是那个文件"的总闸。
# 一旦有人把 try_files 兜底改回 /index.html，这条会立刻红。
code_404="$(curl -s -o /dev/null -m 8 -w '%{http_code}' --resolve "$PROXY_HOST:443:$PROXY_IP" "https://$PROXY_HOST/__pmh_no_such_path__" 2>/dev/null)"
[ "$code_404" = "404" ] && ok "未知路径 → 404" \
  || bad "未知路径返回 $code_404（又在兜首页兜 200？）"

# /catalog 是服务端契约面，不该由静态兜底回答。未实现时只提示，不判失败（由发布门禁单判）。
cat_ct="$(curl -s -o /dev/null -m 8 -w '%{http_code} %{content_type}' --resolve "$PROXY_HOST:443:$PROXY_IP" "https://$PROXY_HOST/catalog" 2>/dev/null)"
case "$cat_ct" in
  "200 application/json"*) ok "/catalog 200 application/json" ;;
  "404 "*)                 say "  · /catalog 尚未实现（404），发布门禁里会单独判定" ;;
  *)                       bad "/catalog 返回 $cat_ct（期望 200 + application/json）" ;;
esac

say "[5] 端口与防火墙"
ss -ltnp 2>/dev/null | grep -q '127.0.0.1:8787' && ok "8787 只监听回环" || bad "8787 未监听回环（可能对外暴露或没起来）"
if command -v "$UFW_BIN" >/dev/null 2>&1; then
  st="$("$UFW_BIN" status 2>/dev/null | head -1)"
  case "$st" in
    *inactive*) relaxed ufw-inactive "ufw 未启用：$st" ;;
    *)
      ok "ufw：$st"
      [ -n "$(waiver_of ufw-inactive)" ] && say "  · 放宽项 ufw-inactive 已不再需要，可从 $WAIVERS 删除"
      ;;
  esac
fi
ss -ltn 2>/dev/null | grep -q ':443 ' && ok "443 在监听" || bad "443 未监听（HTTPS 未配置）"

say "[6] 资源"
disk="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
[ "$disk" -lt "$DISK_WARN" ] && ok "根分区 ${disk}%" || bad "根分区 ${disk}%（阈值 ${DISK_WARN}%）"
avail_mb="$(free -m | awk '/^Mem:/{print $7}')"
[ "$avail_mb" -gt 200 ] && ok "可用内存 ${avail_mb} MB" || bad "可用内存仅 ${avail_mb} MB"
say "  · journal 占用：$(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMG]' | head -1)"

say "[7] 证书与续期"
if [ -d /etc/letsencrypt/live ]; then
  for d in /etc/letsencrypt/live/*/; do
    f="$d/fullchain.pem"; [ -f "$f" ] || continue
    end="$(date -d "$(openssl x509 -enddate -noout -in "$f" | cut -d= -f2)" +%s 2>/dev/null || echo 0)"
    left=$(( (end - $(date +%s)) / 86400 ))
    [ "$left" -gt 21 ] && ok "$(basename "$d") 剩 ${left} 天" || bad "$(basename "$d") 只剩 ${left} 天，续期可能没跑"
  done
else
  bad "尚无证书（/etc/letsencrypt 不存在）"
fi
# 续期任务本身也要查：证书"还剩很多天"不等于续期链路活着
if systemctl is-enabled --quiet certbot.timer 2>/dev/null && systemctl is-active --quiet certbot.timer 2>/dev/null; then
  next="$(systemctl list-timers certbot.timer --no-pager 2>/dev/null | awk 'NR==2{print $1" "$2" "$3}')"
  ok "certbot.timer enabled+active（下次 ${next:-未知}）"
else
  bad "certbot.timer 不是 enabled+active，续期不会跑"
fi

say "[8] 域名解析"
dns="$(getent ahostsv4 "$PROXY_HOST" | awk 'NR==1{print $1}')"
[ "$dns" = "$EXPECTED_IP" ] && ok "$PROXY_HOST → $dns" || bad "$PROXY_HOST 解析到 ${dns:-无}，不是本机 $EXPECTED_IP"

say ""
if [ "$FAILS" -eq 0 ] && [ "$WARNS" -eq 0 ]; then
  say "结论：全部通过"
  exit 0
elif [ "$FAILS" -eq 0 ]; then
  say "结论：全部通过（${WARNS} 项已知待办告警，见 ⚠）"
  exit 0
else
  printf '结论：%d 项未通过' "$FAILS"
  [ "$WARNS" -gt 0 ] && printf '（另有 %d 项告警）' "$WARNS"
  printf '\n'
  exit 1
fi

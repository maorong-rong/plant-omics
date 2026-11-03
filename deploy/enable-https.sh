#!/usr/bin/env bash
# 一键上 HTTPS：前置校验（DNS 必须已指向本机）→ 装 certbot → 签发 → 强制跳转 → 续期定时器 → 实测。
#
# 用法（服务器上，root）：
#   bash enable-https.sh --email you@example.com                # 域名取 deploy.conf 的 PROXY_HOST
#   bash enable-https.sh --email you@example.com --dry-run      # 只做前置校验与预演签发
#
# 为什么先卡 DNS：Let's Encrypt 的 HTTP-01 校验走域名解析。域名还指着别的机器时，
# 签发必然失败并消耗失败配额（每小时 5 次）。所以这里先查，不指本机直接退出。
#
# 改 DNS 属本涛授权范围：本脚本不改 DNS，只检查；没切就停下来报人。
set -euo pipefail

EMAIL=""
DRY=0

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

log()  { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die()  { printf '\n[FAIL] %s\n' "$*" >&2; exit "${2:-1}"; }

# ── 配置：/etc/plantomics-hub/deploy.conf（600 root:root）──────────────────────
# 域名与本机 IP 只存在于这个文件，脚本里不留真值；缺必填项直接退出。
DEPLOY_CONF="${DEPLOY_CONF:-/etc/plantomics-hub/deploy.conf}"
[ -r "$DEPLOY_CONF" ] || die "读不到配置文件 $DEPLOY_CONF（需 root，权限 600 root:root）" 2
# shellcheck disable=SC1090
. "$DEPLOY_CONF"
_needed=""
for _k in PROXY_HOST EXPECTED_IP; do
  [ -n "${!_k:-}" ] || _needed="$_needed $_k"
done
[ -z "$_needed" ] || die "配置缺少必填项:$_needed —— $DEPLOY_CONF 不给内置默认值，拒绝运行" 2
# Nginx 站点文件名通常就是域名首段；不写死，允许 deploy.conf 用 NGINX_SITE 覆盖。
NGINX_SITE="${NGINX_SITE:-${PROXY_HOST%%.*}}"
NGINX_SITE_CONF="/etc/nginx/sites-available/$NGINX_SITE"

while [ $# -gt 0 ]; do
  case "$1" in
    --email)   EMAIL="${2:?}"; shift 2 ;;
    --domain)  PROXY_HOST="${2:?}"; shift 2 ;;   # 兼容旧参数名，值仍落到 PROXY_HOST
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1" 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "需要 root"
[ "$DRY" -eq 1 ] || [ -n "$EMAIL" ] || die "必须给 --email（证书到期提醒要用）" 2

# ── 1. 前置：DNS ──────────────────────────────────────────────────────────────
log "1/6 校验 DNS：$PROXY_HOST 是否指向 $EXPECTED_IP"
DNS_IPS="$(getent ahostsv4 "$PROXY_HOST" | awk '{print $1}' | sort -u | tr '\n' ' ')"
log "  解析结果：${DNS_IPS:-无}"
case " $DNS_IPS " in
  *" $EXPECTED_IP "*) log "  ✓ 含 $EXPECTED_IP" ;;
  *) die "DNS 还没指过来（解析到 ${DNS_IPS:-无}，需要 $EXPECTED_IP）。改 A 记录属本涛授权，先报再动。" 4 ;;
esac

# ── 2. 前置：80 端口对本机可用、Nginx 在跑 ───────────────────────────────────
log "2/6 校验 Nginx 与 80 端口"
systemctl is-active --quiet nginx || die "nginx 不是 active"
nginx -t >/dev/null 2>&1 || die "现有 nginx 配置未通过 nginx -t，先修配置再签证书"
curl -fsS -m 5 -H "Host: $PROXY_HOST" "http://127.0.0.1/healthz" >/dev/null \
  || log "  ⚠ 本机 80 上 /healthz 不通（不影响签发，但上线后要复查）"
log "  ✓ nginx active，配置合法"

# ── 3. 装 certbot ────────────────────────────────────────────────────────────
log "3/6 安装 certbot"
if ! command -v certbot >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq certbot python3-certbot-nginx
fi
certbot --version

# ── 4. 签发 ──────────────────────────────────────────────────────────────────
if [ "$DRY" -eq 1 ]; then
  log "4/6 dry-run：--staging 预演签发（不占配额、不写正式证书）"
  certbot --nginx -d "$PROXY_HOST" --staging --non-interactive --agree-tos -m "$EMAIL" \
          --redirect --keep-until-expiring
  log "  ✓ 预演通过；正式签发请去掉 --dry-run 重跑"
  log "  ⚠ 注意：staging 证书此刻已写进 $NGINX_SITE_CONF，443 上会是**不受信任**的证书；"
  log "     正式签发那一步会自动带 --force-renewal 覆盖它，别停在这一步对外服务。"
  exit 0
fi

log "4/6 正式签发（--nginx 自动改配置并加 80→443 跳转）"
cp -a "$NGINX_SITE_CONF" "$NGINX_SITE_CONF.bak-$(date +%Y%m%d%H%M%S)"

# 已存在证书（尤其是 --dry-run 留下的 staging 证书）时必须 --force-renewal：
# 否则 certbot 判"还没到期"原样保留，443 上会继续跑不受信任的 staging 证书（2026-10-31 实遇）。
FORCE=()
[ -d "/etc/letsencrypt/live/$PROXY_HOST" ] && FORCE=(--force-renewal)

# 本机到生产 ACME 端点偶发丢包（实测 0.76s / 14.2s / 25s 超时），默认 45s 读超时会失败；
# 放宽到 120s，并最多重试 3 次。失败不重试到"看起来成功"，只重试超时这一类。
for attempt in 1 2 3; do
  log "  第 $attempt 次尝试"
  if certbot --nginx -d "$PROXY_HOST" --non-interactive --agree-tos -m "$EMAIL" \
             --redirect --issuance-timeout 120 "${FORCE[@]}" 2>&1 | tail -6; then
    :
  fi
  if openssl x509 -noout -issuer -in "/etc/letsencrypt/live/$PROXY_HOST/fullchain.pem" 2>/dev/null | grep -q STAGING; then
    log "  ⚠ 仍是 staging 证书，继续"
  else
    break
  fi
  sleep 5
done
openssl x509 -noout -issuer -in "/etc/letsencrypt/live/$PROXY_HOST/fullchain.pem" 2>/dev/null | grep -q STAGING \
  && die "签发后仍是 staging 证书，HTTPS 不能对外用。查 /var/log/letsencrypt/letsencrypt.log" 
nginx -t && systemctl reload nginx

# ── 5. 续期定时器 ────────────────────────────────────────────────────────────
log "5/6 续期：certbot.timer"
if systemctl list-unit-files | grep -q '^certbot.timer'; then
  systemctl enable --now certbot.timer
  systemctl list-timers certbot.timer --no-pager | head -3 || true
else
  log "  ⚠ 没找到 certbot.timer（非 apt 安装的 certbot？），需手工加 cron"
fi
# 续期成功/失败都要有人看得见：hook 写日志
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/10-reload-nginx.sh <<'HOOK'
#!/bin/sh
nginx -t && systemctl reload nginx && echo "$(date -Is) cert renewed, nginx reloaded"
HOOK
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/10-reload-nginx.sh
certbot renew --dry-run 2>&1 | tail -5

# ── 6. 实测 ──────────────────────────────────────────────────────────────────
log "6/6 实测"
curl -s -o /dev/null -w "  https://$PROXY_HOST/healthz → %{http_code}\n" "https://$PROXY_HOST/healthz"
curl -s -o /dev/null -w "  http  → https 跳转 → %{http_code}\n" "http://$PROXY_HOST/healthz"
curl -s -o /dev/null -w "  https 静态资源 → %{http_code} %{content_type}\n" "https://$PROXY_HOST/assets/style.css"
openssl x509 -noout -subject -enddate -in "/etc/letsencrypt/live/$PROXY_HOST/fullchain.pem" | sed 's/^/  /'

log "完成。注意：certbot --nginx 改动过 $NGINX_SITE_CONF，"
log "       请把新配置回抄到仓库 deploy/nginx.conf 并更新 deploy/服务器现状.md。"

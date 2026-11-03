#!/usr/bin/env bash
# 最小配置备份：只备"重建机器时手写不回来"的东西，不备可重建的产物。
#
# 备份内容：
#   /etc/plantomics-hub/            （含 env，**有 token**，所以归档目录 700、文件 600）
#   /etc/nginx/sites-available/<NGINX_SITE>   （站点配置，名字由 deploy.conf 推导）
#   /etc/systemd/system/plantomics-hub.service
#   /etc/cron.d/plantomics-check
#   /etc/letsencrypt/renewal-hooks/deploy/   （续期 hook；证书本身可重签，不备私钥）
#
# 不备：/srv/plantomics-hub（git 仓，从公开仓 clone 即可）、site/（已在 git 里）、dist/（可构建）、
#       /etc/letsencrypt/live|archive（私钥 + 可重签，备了反而多一份密钥副本）。
#
# 用法：/usr/local/sbin/plantomics-backup.sh        （cron 每日）
# 环境变量：DEST（默认 /root/backups）、KEEP_DAYS（默认 7）
set -uo pipefail

DEST="${DEST:-/root/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"

# ── 配置：/etc/plantomics-hub/deploy.conf（600 root:root）──────────────────────
# 站点文件名从域名首段推导（或用 NGINX_SITE 覆盖），脚本里不留真实域名。
DEPLOY_CONF="${DEPLOY_CONF:-/etc/plantomics-hub/deploy.conf}"
[ -r "$DEPLOY_CONF" ] || { echo "[FAIL] 读不到 $DEPLOY_CONF（需 root，权限 600 root:root）" >&2; exit 2; }
# shellcheck disable=SC1090
. "$DEPLOY_CONF"
[ -n "${PROXY_HOST:-}" ] || { echo "[FAIL] $DEPLOY_CONF 缺少必填项: PROXY_HOST —— 不给内置默认值，拒绝运行" >&2; exit 2; }
NGINX_SITE="${NGINX_SITE:-${PROXY_HOST%%.*}}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$DEST/plantomics-config-$STAMP.tar.gz"

umask 077
mkdir -p "$DEST"
chmod 700 "$DEST"

FILES=()
for p in /etc/plantomics-hub "/etc/nginx/sites-available/$NGINX_SITE" \
         /etc/systemd/system/plantomics-hub.service /etc/cron.d/plantomics-check \
         /etc/letsencrypt/renewal-hooks/deploy; do
  [ -e "$p" ] && FILES+=("$p")
done

[ "${#FILES[@]}" -gt 0 ] || { echo "没有可备份的路径，退出" >&2; exit 1; }

tar czf "$ARCHIVE" --warning=no-file-changed "${FILES[@]}" 2>/dev/null || true
chmod 600 "$ARCHIVE"

# tar 里有 env（token），校验一下权限不是摆设
mode="$(stat -c %a "$ARCHIVE")"
[ "$mode" = "600" ] || { echo "备份文件权限异常：$mode" >&2; exit 1; }

# 只留最近 KEEP_DAYS 天
find "$DEST" -name 'plantomics-config-*.tar.gz' -type f -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true

printf '%s 备份完成 %s（%s 字节，权限 %s，保留 %s 天）\n' \
  "$(date -Is)" "$ARCHIVE" "$(stat -c %s "$ARCHIVE")" "$mode" "$KEEP_DAYS"

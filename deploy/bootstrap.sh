#!/usr/bin/env bash
# PlantOmics Hub —— 引导安装脚本（部署物料，未在真实服务器验证）
#
# 做什么：装系统依赖 → 建用户 → 把仓放 /opt/plantomics-hub → 构建 → 装 systemd 单元 →
#         生成 /etc/plantomics-hub.env（若不存在）→ 启动。Nginx 站点单独按 deploy/nginx.conf 装。
#
# 用法（root）：
#   sudo bash deploy/bootstrap.sh /path/to/plant-omics-source
#   sudo bash deploy/bootstrap.sh /path/to/plant-omics-source --host example.org
#
# 不做的事：不自动签证书、不改防火墙、不填真实 token（留占位让你改）。
# 幂等：重复执行安全（已存在的 env 文件不覆盖、已有目录不删）。
set -euo pipefail

SRC=""
HOSTNAME_PUBLIC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOSTNAME_PUBLIC="${2:-}"; shift 2 ;;
    -h|--help) sed -n '1,20p' "$0"; exit 0 ;;
    *) SRC="$1"; shift ;;
  esac
done

APP_DIR=/opt/plantomics-hub
APP_USER=plantomics
ENV_FILE=/etc/plantomics-hub.env
UNIT=/etc/systemd/system/plantomics-hub.service

log() { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[bootstrap] %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "需要 root 运行（sudo bash deploy/bootstrap.sh <源码路径>）"
[[ -n "$SRC" && -d "$SRC" ]] || die "请给出源码目录，例如：sudo bash deploy/bootstrap.sh /srv/plant-omics"
[[ -f "$SRC/package.json" ]] || die "$SRC 不像本仓根目录（缺 package.json）"

log "检查 Node 版本（要求 ≥ 20，推荐 22）"
if ! command -v node >/dev/null 2>&1; then
  die "未找到 node。请先装 Node 22（例如 NodeSource 或发行版包），再重跑本脚本。"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node 版本过低（$NODE_MAJOR），要求 ≥ 20"
command -v npm >/dev/null 2>&1 || die "未找到 npm"

log "建系统用户 $APP_USER（已存在则跳过）"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

log "同步源码到 $APP_DIR（保留已有 env，不删目录）"
mkdir -p "$APP_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude node_modules --exclude dist --exclude .git --exclude '记录' \
    --exclude '论文' --exclude '.archify' --exclude 'site' --exclude 'web' \
    "$SRC"/ "$APP_DIR"/
else
  tar -C "$SRC" --exclude=node_modules --exclude=dist --exclude=.git \
      --exclude='记录' --exclude='论文' --exclude='.archify' --exclude=site --exclude=web \
      -cf - . | tar -C "$APP_DIR" -xf -
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "安装依赖并构建（含 devDependencies，构建后不留悬空）"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --no-audit --no-fund
sudo -u "$APP_USER" npm run build

log "安装 systemd 单元"
install -m 0644 "$APP_DIR/deploy/plantomics-hub.service" "$UNIT"

log "准备环境变量文件 $ENV_FILE"
if [[ -f "$ENV_FILE" ]]; then
  log "已存在，保持不动（要改请手工编辑）"
else
  TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  ALLOWED="example.org"
  if [[ -n "$HOSTNAME_PUBLIC" ]]; then ALLOWED="$HOSTNAME_PUBLIC,www.$HOSTNAME_PUBLIC"; fi
  cat > "$ENV_FILE" <<EOF
# 由 deploy/bootstrap.sh 生成；含 token，权限 600
PLANTOMICS_HUB_HOST=127.0.0.1
PLANTOMICS_HUB_PORT=8787
PLANTOMICS_HUB_TOKEN=$TOKEN
PLANTOMICS_HUB_SERVER_NAME=plantomics-hub
PLANTOMICS_HUB_LOG=info
PLANTOMICS_HUB_ALLOWED_HOSTS=$ALLOWED
EOF
  chown root:root "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "已生成 token（在 $ENV_FILE 里，请自行保存给客户端）"
fi

log "启动服务"
systemctl daemon-reload
systemctl enable --now plantomics-hub.service
sleep 1
systemctl --no-pager --lines=0 status plantomics-hub.service || true

log "本机自检：curl -fsS http://127.0.0.1:8787/healthz"
if command -v curl >/dev/null 2>&1; then
  curl -fsS http://127.0.0.1:8787/healthz && echo || die "健康检查失败：看 journalctl -u plantomics-hub -n 50"
fi

cat <<'NEXT'

下一步（本脚本不做）：
  1) 装 Nginx 站点：把 deploy/nginx.conf 的 example.org 换成你的域名，
     cp 到 /etc/nginx/sites-available/plantomics-hub.conf 并软链到 sites-enabled，nginx -t && reload；
  2) 签证书：certbot --nginx -d 你的域名；
  3) 把 /etc/plantomics-hub.env 里的 token 交给客户端；
  4) 防火墙只放行 80/443，8787 不要对外。
NEXT

#!/usr/bin/env bash
# CloudNine 首次部署引导脚本（在目标服务器上以 root 执行）
#
# 职责：
#   1. 安装运行时依赖（Node.js、nginx）
#   2. 创建低权限服务账号与数据目录
#   3. 克隆仓库到 /opt/cloudnine
#   4. 安装 systemd unit 与 nginx 反代配置
#   5. 生成 /etc/cloudnine/cloudnine.env
#
# 用法：sudo bash scripts/bootstrap.sh
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/cloudnine}"
DATA_DIR="${DATA_DIR:-/var/lib/cloudnine}"
FILE_ROOT="${FILE_ROOT:-/data}"
SERVICE_USER="${SERVICE_USER:-cloudnine}"
SERVICE_NAME="${SERVICE_NAME:-cloudnine}"
PORT="${PORT:-8480}"
REPO_URL="${REPO_URL:-https://github.com/bytesfloow/cloudnine.git}"
BRANCH="${BRANCH:-main}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SERVICE_HOME="${SERVICE_HOME:-/home/$SERVICE_USER}"

log() { echo "[bootstrap] $*"; }
fail() { echo "[bootstrap] ✗ $*" >&2; exit 1; }

# 端口预检：避免服务因端口占用进入崩溃循环（Restart=always 会无限重试，日志难查）
port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -tln "sport = :$1" 2>/dev/null | grep -q LISTEN
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

check_ports() {
  # 服务已在运行时，$PORT 由自己占用属正常（后续会 restart），不算冲突
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "服务当前已在运行，$PORT 由自身占用属正常"
  elif port_in_use "$PORT"; then
    echo "[bootstrap] ✗ 端口 $PORT 已被其他进程占用："
    ss -tlnp 2>/dev/null | grep ":$PORT " || true
    echo "[bootstrap]   请先停止占用进程，或修改 /etc/cloudnine/cloudnine.env 里的 PORT"
    exit 1
  else
    log "端口 $PORT 空闲"
  fi

  # 80 端口由 nginx 占用属正常
  if systemctl is-active --quiet nginx && port_in_use 80; then
    log "nginx 已运行并占用 80，正常"
  elif port_in_use 80; then
    echo "[bootstrap] ✗ 端口 80 已被占用（nginx 需要该端口）："
    ss -tlnp 2>/dev/null | grep ":80 " || true
    exit 1
  else
    log "端口 80 空闲"
  fi
}

# ---------- 1. 系统包 ----------
log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git rsync nginx ca-certificates build-essential python3 >/dev/null

# ---------- 2. Node.js ----------
if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]; then
  log "安装 Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node.js: $(node -v)  npm: $(npm -v)"

# ---------- 3. 服务账号与目录 ----------
log "创建服务账号与目录"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$SERVICE_HOME" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$DEPLOY_DIR" "$DATA_DIR" "$FILE_ROOT" "$SERVICE_HOME" /etc/cloudnine
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
# FILE_ROOT 需要服务账号可读写，否则上传/新建会失败
chown "$SERVICE_USER:$SERVICE_USER" "$FILE_ROOT"
chmod 755 "$FILE_ROOT"
chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME"

# ---------- 4. 代码 ----------
# 非破坏性：目标目录若已有部署（data/、node_modules/），必须保留。
# 绝不能 rm -rf $DEPLOY_DIR/* —— 里面通常存着账号库 db.json。
if [ ! -d "$DEPLOY_DIR/.git" ]; then
  log "在 $DEPLOY_DIR 初始化 git 仓库（保留既有数据目录与 node_modules）"
  git -C "$DEPLOY_DIR" init -q
  git -C "$DEPLOY_DIR" remote remove origin 2>/dev/null || true
  git -C "$DEPLOY_DIR" remote add origin "$REPO_URL"
fi
# 部署目录属主是服务账号，root 运行 git 会触发 "dubious ownership" 拦截
git config --global --add safe.directory "$DEPLOY_DIR" 2>/dev/null || true
cd "$DEPLOY_DIR"
git fetch --all --prune --quiet || fail "git fetch 失败（服务器能否访问 GitHub？）"
git checkout -B "$BRANCH" "origin/$BRANCH" --quiet || fail "git checkout 失败"
git reset --hard "origin/$BRANCH" --quiet
log "代码版本: $(git rev-parse --short HEAD)"

# ---------- 5. 配置文件 ----------
log "安装 systemd unit"
# 注入真实路径：ReadWritePaths 必须覆盖 DATA_DIR / FILE_ROOT / 服务账号家目录，
# 否则 ProtectSystem=strict 会让文件写操作全部失败
# @NODE_BIN@ 必须用服务器上 node 的真实路径（可能是 /usr/local/bin/node）
NODE_BIN="$(command -v node)"
[ -x "$NODE_BIN" ] || { echo "[bootstrap] ✗ 找不到 node 可执行文件"; exit 1; }
sed \
  -e "s#@SERVICE_USER@#$SERVICE_USER#g" \
  -e "s#@DEPLOY_DIR@#$DEPLOY_DIR#g" \
  -e "s#@DATA_DIR@#$DATA_DIR#g" \
  -e "s#@FILE_ROOT@#$FILE_ROOT#g" \
  -e "s#@SERVICE_HOME@#$SERVICE_HOME#g" \
  -e "s#@NODE_BIN@#$NODE_BIN#g" \
  scripts/systemd/cloudnine.service > "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

log "安装 nginx 配置"
cp scripts/nginx/cloudnine.conf /etc/nginx/sites-available/cloudnine
ln -sf /etc/nginx/sites-available/cloudnine /etc/nginx/sites-enabled/cloudnine
# 移除可能冲突的默认站点（占用 80 端口）
rm -f /etc/nginx/sites-enabled/default
nginx -t

log "生成环境变量文件"
if [ ! -f /etc/cloudnine/cloudnine.env ]; then
  cat > /etc/cloudnine/cloudnine.env <<EOF
# CloudNine 运行参数（环境变量优先级最高）
PORT=$PORT
HOST=127.0.0.1
FILE_ROOT=$FILE_ROOT
DATA_DIR=$DATA_DIR
SITE_NAME=CloudNine
SESSION_DAYS=7
REMEMBER_DAYS=30
MAX_UPLOAD_MB=4096
TRASH_RETENTION_DAYS=30
MAX_EXTRACT_MB=8192
TRUST_PROXY=true
EOF
  chmod 640 /etc/cloudnine/cloudnine.env
  chown root:"$SERVICE_USER" /etc/cloudnine/cloudnine.env
fi

# ---------- 6. 依赖与构建 ----------
check_ports
log "安装依赖"
npm --prefix server ci --no-audit --no-fund --foreground-scripts
npm --prefix client ci --no-audit --no-fund --foreground-scripts
log "构建前端"
npm --prefix client run build

chown -R "$SERVICE_USER:$SERVICE_USER" "$DEPLOY_DIR/client/dist"

log "启动服务"
systemctl restart "$SERVICE_NAME"
systemctl reload nginx

sleep 3
systemctl --no-pager --lines=10 status "$SERVICE_NAME" || true

# 已存在账号库时不要再提示"初始化向导"，否则会误导运维
if [ -f "$DATA_DIR/db.json" ] && python3 -c "
import json,sys
try:
    sys.exit(0 if json.load(open('$DATA_DIR/db.json')).get('account') else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
  log "引导完成。访问：http://<服务器IP>/（账号已存在，将进入登录页）"
else
  log "引导完成。访问：http://<服务器IP>/（首次访问将进入初始化向导，创建唯一账号）"
fi

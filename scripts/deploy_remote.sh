#!/usr/bin/env bash
# CloudNine 远端部署脚本（在目标服务器上执行）
#
# 流程：拉取代码 → 安装依赖 → 构建前端 → 重启服务 → 健康检查
# 任何一步失败都会自动回滚到上一个可用版本。
#
# 用法：
#   bash scripts/deploy_remote.sh            # 正常部署
#   bash scripts/deploy_remote.sh --no-build # 跳过前端构建（仅服务端有改动时）
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/cloudnine}"
SERVICE_NAME="${SERVICE_NAME:-cloudnine}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8480/api/state}"
HEALTH_RETRIES="${HEALTH_RETRIES:-15}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"
SKIP_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

log()  { echo "[deploy $(date '+%H:%M:%S')] $*"; }
fail() { echo "[deploy ERROR] $*" >&2; exit 1; }

cd "$DEPLOY_DIR" || fail "部署目录不存在: $DEPLOY_DIR"

# ---------- 1. 记录当前版本用于回滚 ----------
PREV_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo '')"
PREV_TARBALL="/tmp/cloudnine-rollback-$(date +%s).tar.gz"
log "当前版本: ${PREV_COMMIT:-<无>}"

rollback() {
  log "开始回滚到 ${PREV_COMMIT:-<无>}"
  if [ -n "$PREV_COMMIT" ]; then
    git checkout --quiet "$PREV_COMMIT" 2>/dev/null || true
    git reset --hard --quiet "$PREV_COMMIT" 2>/dev/null || true
    npm --prefix client ci --silent >/dev/null 2>&1 || true
    npm --prefix client run build >/dev/null 2>&1 || true
    npm --prefix server ci --silent >/dev/null 2>&1 || true
  elif [ -f "$PREV_TARBALL" ]; then
    tar -xzf "$PREV_TARBALL" -C "$DEPLOY_DIR" || true
  fi
  systemctl restart "$SERVICE_NAME" || true
  log "回滚完成"
}

# 首次部署无历史版本时，用当前工作区打快照作为兜底
if [ -z "$PREV_COMMIT" ]; then
  tar -czf "$PREV_TARBALL" --exclude=node_modules --exclude=.git \
      -C "$DEPLOY_DIR" . 2>/dev/null || true
fi

# ---------- 2. 拉取代码 ----------
log "拉取最新代码"
git fetch --all --prune --quiet || fail "git fetch 失败"
git checkout --quiet "${DEPLOY_BRANCH:-main}" || fail "git checkout 失败"
git pull --ff-only --quiet origin "${DEPLOY_BRANCH:-main}" || fail "git pull 失败"
NEW_COMMIT="$(git rev-parse HEAD)"
log "部署版本: $NEW_COMMIT"
if [ "$NEW_COMMIT" = "$PREV_COMMIT" ]; then
  log "版本未变化，仍执行重启以确保服务状态干净"
fi

# ---------- 3. 安装依赖 ----------
log "安装服务端依赖"
npm --prefix server ci --no-audit --no-fund --foreground-scripts \
  || fail "服务端依赖安装失败"

if [ "$SKIP_BUILD" -eq 0 ]; then
  log "安装客户端依赖"
  npm --prefix client ci --no-audit --no-fund \
    || fail "客户端依赖安装失败"

  log "构建前端"
  npm --prefix client run build \
    || fail "前端构建失败"
else
  log "跳过前端构建（--no-build）"
fi

# ---------- 4. 重启服务 ----------
# 端口预检：若端口被「其他进程」占用，重启后服务会进入崩溃循环且日志难查。
# 服务自身在跑时端口由自己占用，属正常。
APP_PORT="$(grep -E '^PORT=' /etc/cloudnine/cloudnine.env 2>/dev/null | cut -d= -f2 | tr -d '\r')"
APP_PORT="${APP_PORT:-8480}"
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  if command -v ss >/dev/null 2>&1 && ss -tln "sport = :$APP_PORT" 2>/dev/null | grep -q LISTEN; then
    echo "占用者信息：" >&2
    ss -tlnp 2>/dev/null | grep ":$APP_PORT " >&2 || true
    fail "端口 $APP_PORT 已被其他进程占用，拒绝重启服务"
  fi
fi

log "重启服务 $SERVICE_NAME"
if ! systemctl restart "$SERVICE_NAME"; then
  log "重启失败，触发回滚"
  rollback
  fail "服务重启失败"
fi

# ---------- 5. 健康检查 ----------
log "健康检查: $HEALTH_URL"
ok=0
for i in $(seq 1 "$HEALTH_RETRIES"); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    ok=1
    log "健康检查通过（${i} 次尝试）"
    break
  fi
  sleep "$HEALTH_INTERVAL"
done

if [ "$ok" -ne 1 ]; then
  log "健康检查失败，触发回滚"
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
  rollback
  fail "健康检查失败，已回滚"
fi

# ---------- 6. 上报实际产物 ----------
ASSET="$(curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1 && echo ok || echo unknown)"
MAIN_JS="$(ls -1 "$DEPLOY_DIR"/client/dist/assets/main-*.js 2>/dev/null | head -1 | xargs -r basename)"
log "完成。版本=$NEW_COMMIT 主包=$MAIN_JS 健康=$ASSET"

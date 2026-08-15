#!/usr/bin/env bash
# 部署 llm-pro.cn:--web 静态站(默认,与旧版行为一致)、--server 后端 API、--all 先后端再前端。
# 两者同构:build → tar 管道上传 → 目录原子切换,旧版本留时间戳备份(保最近 2 份)。
# 用法:scripts/deploy.sh [--web|--server|--all] [--skip-build]
set -euo pipefail

HOST=llm-pro
WEBROOT=/var/www/llms-study
APIROOT=/opt/llms-study-api
cd "$(dirname "$0")/.."

TARGET=web
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --web) TARGET=web ;;
    --server) TARGET=server ;;
    --all) TARGET=all ;;
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "用法: scripts/deploy.sh [--web|--server|--all] [--skip-build]" >&2; exit 2 ;;
  esac
done

deploy_web() {
  if [[ "$SKIP_BUILD" != 1 ]]; then
    npm run build
  fi

  # 构建产物自检:论文陪读必须在场(防再次发生 flag-off 静默摘除)
  if ! grep -rq "论文陪读" dist/assets/*.js; then
    echo "FATAL: dist 里没有论文陪读(Paper Copilot),检查 .env.production 的 VITE_ENABLE_PAPER_COPILOT" >&2
    exit 1
  fi

  local STAMP
  STAMP=$(date +%Y%m%d-%H%M%S)
  ssh "$HOST" "rm -rf ${WEBROOT}-new && mkdir -p ${WEBROOT}-new"
  # COPYFILE_DISABLE=1:macOS bsdtar 否则会打进 AppleDouble(._xxx)垃圾文件
  COPYFILE_DISABLE=1 tar -C dist -czf - . | ssh "$HOST" "tar -xzf - -C ${WEBROOT}-new"
  ssh "$HOST" "mv ${WEBROOT} ${WEBROOT}.bak-${STAMP} && mv ${WEBROOT}-new ${WEBROOT} \
    && ls -dt ${WEBROOT}.bak-* 2>/dev/null | tail -n +3 | xargs -r rm -rf"

  echo "web deployed at ${STAMP}; backups:"
  ssh "$HOST" "ls -dt ${WEBROOT}.bak-* 2>/dev/null"
}

deploy_server() {
  if [[ "$SKIP_BUILD" != 1 ]]; then
    (cd server && npm ci && npm run build)
  fi

  local STAMP
  STAMP=$(date +%Y%m%d-%H%M%S)
  ssh "$HOST" "rm -rf ${APIROOT}-new && mkdir -p ${APIROOT}-new"
  # 只传 dist + lockfile;原生模块(better-sqlite3/@node-rs)必须在目标机 npm ci 重建
  # COPYFILE_DISABLE=1:macOS bsdtar 否则会打进 AppleDouble(._xxx),曾把 ._001_init.sql 混进迁移目录
  COPYFILE_DISABLE=1 tar -C server -czf - dist package.json package-lock.json | ssh "$HOST" "tar -xzf - -C ${APIROOT}-new"
  ssh "$HOST" "cd ${APIROOT}-new && npm ci --omit=dev --no-audit --no-fund"
  ssh "$HOST" "if [ -d ${APIROOT} ]; then mv ${APIROOT} ${APIROOT}.bak-${STAMP}; fi \
    && mv ${APIROOT}-new ${APIROOT} \
    && ls -dt ${APIROOT}.bak-* 2>/dev/null | tail -n +3 | xargs -r rm -rf \
    && systemctl restart llms-study-api"

  sleep 2
  if curl -sf https://llm-pro.cn/api/app/health >/dev/null; then
    echo "server deployed at ${STAMP}; health OK; backups:"
    ssh "$HOST" "ls -dt ${APIROOT}.bak-* 2>/dev/null"
  else
    cat >&2 <<EOF
FATAL: https://llm-pro.cn/api/app/health 探活失败。排查:
  ssh ${HOST} "curl -s http://127.0.0.1:8787/api/app/health"   # 通 → nginx 未配 /api/app/(见 deploy/provision.md 第 5 步);不通 → 看日志
  ssh ${HOST} "journalctl -u llms-study-api -n 50 --no-pager"
回滚:
  ssh ${HOST} "systemctl stop llms-study-api \\
    && mv ${APIROOT} ${APIROOT}.broken-${STAMP} \\
    && mv ${APIROOT}.bak-${STAMP} ${APIROOT} \\
    && systemctl start llms-study-api"
EOF
    exit 1
  fi
}

case "$TARGET" in
  web) deploy_web ;;
  server) deploy_server ;;
  all) deploy_server; deploy_web ;;
esac

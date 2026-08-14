#!/usr/bin/env bash
# 部署 llm-pro.cn:build → tar 管道上传 → 目录原子切换,旧版本留时间戳备份(保最近 2 份)。
# 用法:scripts/deploy.sh [--skip-build]
set -euo pipefail

HOST=llm-pro
WEBROOT=/var/www/llms-study
cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--skip-build" ]]; then
  npm run build
fi

# 构建产物自检:论文陪读必须在场(防再次发生 flag-off 静默摘除)
if ! grep -rq "论文陪读" dist/assets/*.js; then
  echo "FATAL: dist 里没有论文陪读(Paper Copilot),检查 .env.production 的 VITE_ENABLE_PAPER_COPILOT" >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
ssh "$HOST" "rm -rf ${WEBROOT}-new && mkdir -p ${WEBROOT}-new"
tar -C dist -czf - . | ssh "$HOST" "tar -xzf - -C ${WEBROOT}-new"
ssh "$HOST" "mv ${WEBROOT} ${WEBROOT}.bak-${STAMP} && mv ${WEBROOT}-new ${WEBROOT} \
  && ls -dt ${WEBROOT}.bak-* 2>/dev/null | tail -n +3 | xargs -r rm -rf"

echo "deployed at ${STAMP}; backups:"
ssh "$HOST" "ls -dt ${WEBROOT}.bak-* 2>/dev/null"

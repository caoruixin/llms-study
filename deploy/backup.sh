#!/usr/bin/env bash
# =============================================================================
# llms-study 每日备份(P5)。由 /etc/cron.d/llms-study-backup 于每日 03:00 调用。
#
# 策略(为什么这样设计):
# - SQLite 用 `.backup` 而非 cp:.backup 走 SQLite 在线备份 API,对 WAL 模式安全,
#   拿到的是一致性快照;直接 cp 可能撕裂到事务中间状态。
# - 日备保 14 天 + 周日份保 8 周:两周内可按天回退,两个月内可按周回退。
# - files/ 用 rsync --link-dest 硬链接快照:未变化的文件只占 inode 不占空间,
#   50MB 级 PDF 全量拷 7 份不现实,硬链接快照 = 增量的空间、全量的可恢复性。
# - 磁盘水位 >85% 时向 stderr 告警:cron 的 stderr 会进邮件/日志,尽早暴露。
#
# 安装:cp 到 /usr/local/bin/llms-study-backup.sh && chmod +x(见 provision.md §8)
# =============================================================================
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/llms-study}"
DB_PATH="${DB_PATH:-$DATA_DIR/data.db}"
FILES_DIR="${FILES_DIR:-$DATA_DIR/files}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/llms-study}"

DAILY_KEEP=14      # 日备份保留份数
WEEKLY_KEEP=8      # 周日份保留份数
SNAP_KEEP=7        # files/ 快照保留份数
DISK_WARN_PCT=85   # 磁盘水位告警阈值

TODAY="$(date +%F)"
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/files"

# ---- 1. SQLite 在线备份(先落 tmp 再改名:中途失败不留半个"看似完整"的备份) ----
DB_TMP="$BACKUP_DIR/daily/.data-$TODAY.db.tmp"
DB_OUT="$BACKUP_DIR/daily/data-$TODAY.db.gz"
sqlite3 "$DB_PATH" ".backup '$DB_TMP'"
gzip -c "$DB_TMP" > "$DB_OUT.tmp"
rm -f "$DB_TMP"
mv "$DB_OUT.tmp" "$DB_OUT"
echo "[backup] sqlite → $DB_OUT ($(du -h "$DB_OUT" | cut -f1))"

# 周日(date +%u == 7)追加一份周备:硬链接零拷贝(同文件系统)
if [ "$(date +%u)" = "7" ]; then
  ln -f "$DB_OUT" "$BACKUP_DIR/weekly/data-$TODAY.db.gz"
  echo "[backup] weekly copy → weekly/data-$TODAY.db.gz"
fi

# ---- 2. files/ 硬链接快照 ----
SNAP_DIR="$BACKUP_DIR/files/$TODAY"
# 找最近一份快照作 link-dest 基准(不存在则退化为全量拷贝)
PREV="$(ls -1d "$BACKUP_DIR"/files/*/ 2>/dev/null | sort | tail -1 || true)"
if [ -d "$FILES_DIR" ]; then
  if [ -n "$PREV" ] && [ "$PREV" != "$SNAP_DIR/" ]; then
    rsync -a --delete --link-dest="$PREV" "$FILES_DIR/" "$SNAP_DIR/"
  else
    rsync -a --delete "$FILES_DIR/" "$SNAP_DIR/"
  fi
  echo "[backup] files snapshot → $SNAP_DIR"
fi

# ---- 3. 轮转(按名字排序删最旧,文件名含日期即时间序) ----
prune() { # $1=glob(有意不加引号,展开成候选列表)  $2=保留数
  # 末尾 || true:glob 无匹配时 ls 非零退出,在 pipefail 下会误杀整个脚本
  # shellcheck disable=SC2086
  ls -1d $1 2>/dev/null | sort | head -n -"$2" | while read -r old; do
    rm -rf "$old"
    echo "[backup] pruned $old"
  done || true
}
prune "$BACKUP_DIR/daily/data-*.db.gz" "$DAILY_KEEP"
prune "$BACKUP_DIR/weekly/data-*.db.gz" "$WEEKLY_KEEP"
prune "$BACKUP_DIR/files/*/" "$SNAP_KEEP"

# ---- 4. 磁盘水位告警(数据盘与备份盘都查;stderr → cron 邮件/日志) ----
for p in "$DATA_DIR" "$BACKUP_DIR"; do
  pct="$(df --output=pcent "$p" | tail -1 | tr -dc '0-9')"
  if [ "$pct" -gt "$DISK_WARN_PCT" ]; then
    echo "[backup][WARN] $p 所在磁盘使用率 ${pct}% 超过 ${DISK_WARN_PCT}% 阈值,请尽快扩容或清理" >&2
  fi
done

echo "[backup] done $TODAY"

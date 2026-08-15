# llms-study API 首次上机 checklist(ECS llm-pro,8.219.69.75)

按顺序执行;每步末尾有自检命令。全程 root(`ssh llm-pro`)。

> **执行记录**:2026-08-14 已按本 checklist 完成 1-6 步与第 8 步(备份);
> nginx 现网配置在 `/etc/nginx/conf.d/llms-study.conf`(非 sites-enabled)。
> 系统是 **Alibaba Cloud Linux 4(RHEL 系,dnf)**,不是 Debian——包管理命令以下面修正版为准。

## 1. Node 22 LTS

发行版源自带 Node 22(无需 NodeSource;systemd ExecStart 依赖 /usr/bin/node):

```bash
dnf install -y nodejs nodejs-npm sqlite rsync   # sqlite/rsync 是备份脚本(第 8 步)的依赖,一并装
node --version   # v22.x
which node       # /usr/bin/node
```

## 2. 运行用户与目录

```bash
useradd --system --create-home --home-dir /opt/llms-study-api --shell /sbin/nologin llmapp || true
mkdir -p /var/lib/llms-study/files
chown -R llmapp:llmapp /var/lib/llms-study
chmod 750 /var/lib/llms-study
```

注意:`scripts/deploy.sh --server` 会整目录替换 /opt/llms-study-api,该目录内不要手工放任何持久数据(数据全在 /var/lib/llms-study)。

## 3. /etc/llms-study/api.env(0600,机密所在)

```bash
mkdir -p /etc/llms-study
touch /etc/llms-study/api.env
chmod 600 /etc/llms-study/api.env
```

内容清单(参考 server/.env.example 注释;生产必须独立生成,勿复用 dev 值):

```ini
PORT=8787
DATA_DIR=/var/lib/llms-study
# openssl rand -hex 32 —— 生成后勿再更换,换了已存的用户 LLM key 全部解不开
LLM_KEY_MASTER=
ADMIN_USERNAME=admin
# 仅首次启动(users 表为空)时生效;admin 首登后立即改密
ADMIN_INITIAL_PASSWORD=
ALLOWED_ORIGINS=https://llm-pro.cn
# COOKIE_SECURE 默认 true,生产不用写
# 服务端 LLM key(P2 网关注入 admin 请求;逗号分隔依序故障转移)
SERVER_DEEPSEEK_KEYS=
SERVER_MOONSHOT_KEYS=
SERVER_ZHIPU_KEYS=
SERVER_JINA_KEYS=
SERVER_OPENAI_COMPAT_KEYS=
```

## 4. systemd

```bash
# 本机执行:把 unit 拷到服务器
scp deploy/llms-study-api.service llm-pro:/etc/systemd/system/
ssh llm-pro "systemctl daemon-reload && systemctl enable llms-study-api"
```

先不 start:代码还没部署,等第 6 步。

## 5. nginx 增量(P0 只加 /api/app/)

对照 deploy/nginx-llm-pro.conf(目标态参考),本阶段只把两块加进现网配置:

1. `upstream llms_api { ... }`(server 块外)
2. `location /api/app/ { ... }` 与 `location /api/app/files/ { ... }`(server 块内,静态与 LLM location 一律不动)

```bash
nginx -t && systemctl reload nginx
```

⚠️ 5 条 /api/{provider}/ 的翻转属于 P2,顺序必须:后端上线 → 前端发版 → 最后翻 nginx(翻早了未登录用户 LLM 立断且前端没有引导 UI)。

## 6. 首次部署 + 健康检查

```bash
# 本机执行
scripts/deploy.sh --server
```

脚本自动:npm ci + build → tar 上传 /opt/llms-study-api-new → 服务器 npm ci --omit=dev
→ 原子 mv(留 .bak-时间戳 2 份)→ systemctl restart → curl https://llm-pro.cn/api/app/health。

手动自检:

```bash
ssh llm-pro "systemctl status llms-study-api --no-pager | head -8"
ssh llm-pro "curl -s http://127.0.0.1:8787/api/app/health"   # 不经 nginx,后端本体
curl -s https://llm-pro.cn/api/app/health                     # 经 nginx 全链
ssh llm-pro "journalctl -u llms-study-api -n 20 --no-pager"   # 应见 [migrate] applied 001_init.sql 与 [seed] 已创建 admin
```

restart 验证自动迁移:`ssh llm-pro systemctl restart llms-study-api` 后 journal 无 migrate 报错、health 仍 200。

## 7. 回滚

```bash
ssh llm-pro
ls -dt /opt/llms-study-api.bak-*          # 找最近备份
systemctl stop llms-study-api
mv /opt/llms-study-api /opt/llms-study-api.broken-$(date +%Y%m%d-%H%M%S)
mv /opt/llms-study-api.bak-<STAMP> /opt/llms-study-api
systemctl start llms-study-api
curl -s http://127.0.0.1:8787/api/app/health
```

DB schema 不自动回滚:迁移是纯加法(P0 只有 001),旧代码跑在新 schema 上安全;真要回退 schema 先备份 /var/lib/llms-study/data.db 再手工处理。

## 8. 备份(P5)

策略见 `deploy/backup.sh` 头注释(SQLite `.backup` 日备 14 天 + 周备 8 周;files/ 硬链接快照 7 份;磁盘水位 >85% stderr 告警)。

### 安装

```bash
# 本机执行
scp deploy/backup.sh llm-pro:/usr/local/bin/llms-study-backup.sh
scp deploy/backup.cron llm-pro:/etc/cron.d/llms-study-backup
ssh llm-pro "chmod +x /usr/local/bin/llms-study-backup.sh && chmod 644 /etc/cron.d/llms-study-backup"
# sqlite3 CLI 与 rsync 是备份脚本的执行者,必须在(alinux4 包名:sqlite、rsync)
ssh llm-pro "command -v sqlite3 && command -v rsync || dnf install -y sqlite rsync"
```

自检:

```bash
ssh llm-pro "/usr/local/bin/llms-study-backup.sh"                 # 手工跑一次,应无报错
ssh llm-pro "ls -lh /var/backups/llms-study/daily /var/backups/llms-study/files"
ssh llm-pro "grep llms-study /var/log/syslog | tail -3"           # 次日确认 cron 真的跑了
```

⚠️ 备份脚本装在 /usr/local/bin(不在 /opt/llms-study-api 内):`deploy.sh --server` 会整目录替换 /opt,放里面会随发版丢失。

### 恢复演练(每季度做一次,备份没演练过 = 没有备份)

```bash
ssh llm-pro
systemctl stop llms-study-api

# 1) 恢复 SQLite:解压最近日备,替换前先把现场留档
cp /var/lib/llms-study/data.db /var/lib/llms-study/data.db.pre-restore-$(date +%s)
gunzip -c /var/backups/llms-study/daily/data-<日期>.db.gz > /var/lib/llms-study/data.db
rm -f /var/lib/llms-study/data.db-wal /var/lib/llms-study/data.db-shm   # 旧 WAL 属于旧库,必须清
chown llmapp:llmapp /var/lib/llms-study/data.db

# 2) 恢复 files/:快照目录整个 rsync 回去
rsync -a --delete /var/backups/llms-study/files/<日期>/ /var/lib/llms-study/files/
chown -R llmapp:llmapp /var/lib/llms-study/files

systemctl start llms-study-api
curl -s http://127.0.0.1:8787/api/app/health
# 登录一个测试账号,确认 /api/app/sync/changes?since=0 能拉到数据、文件 GET 正常
# 演练后:数据一致则删除 pre-restore 留档
```

DB 与 files/ 必须恢复到**同一天**的备份:sync_records 里的 stored_files 元数据与磁盘文件要对得上;跨天混搭会出现"元数据在、文件 404"(后端会日志告警但不自愈)。若只能混搭,恢复后跑 `POST /api/app/admin/recount-quota` 重算配额。

## 待办(后续阶段)

- P2:nginx 翻转 5 条 LLM location(见 nginx-llm-pro.conf 头注释);同时把现网 `/api/app/` 的 client_max_body_size 从 1m 提到 10m(P3 同步 push 批上限 8MB)
- P5 遗留:**OSS 异地备份**——单机备份挡不住整机故障;开阿里云 OSS bucket(同区域、低频存储),
  backup.sh 末尾追加 `ossutil cp -r /var/backups/llms-study oss://<bucket>/llms-study-backup/ --update`,
  凭证放 /root/.ossutilconfig(0600);bucket 侧配 90 天生命周期规则控制成本
- ADMIN_DAILY_CALL_LIMIT:如需给 admin 的服务端 key 调用加日上限,在 api.env 中设置(0/缺省 = 不限)

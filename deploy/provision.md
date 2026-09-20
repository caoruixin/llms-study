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

## 9. 空心论文核查(同步自愈,PLAN-web-snapshot-sync §1.8)

"空心论文" = 客户端已把 `papers` 行推上来(`status='ready'`)、但正文 `blocks` 一条没到或原始文件没传成。
表现是换设备打开只有标题没有正文。**同步自愈那次发版前后各跑一次**:发版前留基线(知道有几篇坏的、是谁的),
发版后隔一天再跑——1.1/1.3 的自动补推生效后条数应当下降;若某篇长期不掉,说明原设备再没打开过论文库,
需要联系用户在原设备上打开一次(或在新设备用「从原网址重新导入」)。

只读查询,不改数据;以 `llmapp` 身份 `-readonly` 打开,避免 root 创建出 root 属主的 `-wal/-shm` 把服务写坏:

```bash
ssh llm-pro
sudo -u llmapp sqlite3 -readonly -box /var/lib/llms-study/data.db <<'SQL'
WITH ready AS (
  SELECT p.user_id,
         p.id                                     AS paper_id,
         p.updated_at,
         json_extract(p.payload, '$.title')       AS title,
         json_extract(p.payload, '$.blockCount')  AS client_blocks,   -- 客户端自报的应有块数
         (SELECT COUNT(*) FROM sync_records b
           WHERE b.user_id = p.user_id AND b.paper_id = p.id
             AND b.tbl = 'blocks' AND b.deleted = 0) AS server_blocks,
         EXISTS (SELECT 1 FROM stored_files f
                  WHERE f.user_id = p.user_id AND f.paper_id = p.id)  AS has_file
    FROM sync_records p
   WHERE p.tbl = 'papers' AND p.deleted = 0
     AND json_extract(p.payload, '$.status') = 'ready'                -- 只查已就绪的:处理中的论文本就还没推完
)
SELECT u.username, r.paper_id, r.title, r.client_blocks, r.server_blocks, r.has_file,
       datetime(r.updated_at / 1000, 'unixepoch', 'localtime') AS updated_at
  FROM ready r JOIN users u ON u.id = r.user_id
 WHERE r.server_blocks = 0 OR r.has_file = 0
 ORDER BY u.username, r.updated_at DESC;
SQL
```

`has_file = 0` 且 `server_blocks > 0` 只是原始文件缺失(正文能读,PDF 原貌打不开),比正文全缺轻一档。
把最后的 `WHERE` 换成 `r.client_blocks IS NOT NULL AND r.server_blocks < r.client_blocks` 可再查"推了一半"的论文
(推送中途被杀的典型形态)。同一份判定的在线版本是 `GET /api/app/sync/summary`,客户端对账用的就是它。

## 10. 服务端渲染兜底(可选)

网页原貌导入的 Tier 3:纯客户端渲染的页面(正文全在 JS 里、模块脚本被浏览器跨源策略拦掉)由服务器上的
无头 Chrome 渲染。**独立 systemd unit(`llms-study-render`)+ 独立用户(`llmrender`)+ unix socket**,
理由见 `deploy/llms-study-render.service` 头注释。代码随 `scripts/deploy.sh --server` 一起发布;
本节只装运行环境。**装好 ≠ 启用**:总闸是 10.7 里 `api.env` 的那一行。

### 10.1 预检(只读;任何一项不过就**停在这里**,不装——客户端的两级捕获与如实报错不受影响)

```bash
ssh llm-pro
uname -m                                  # 期望 x86_64;aarch64 没有 Google Chrome 包 → 走 10.2 的备选
nproc                                     # ≥ 2 为佳;1 核也能跑,渲染期间 API 会变慢(unit 已设 Nice=10)
free -m                                   # API 在跑的前提下 available ≥ ~1000:unit 硬顶 768M,还得给系统留余量
stat -fc %T /sys/fs/cgroup                # 期望 cgroup2fs;不是 → MemoryHigh/MemorySwapMax/IPAddressDeny 都不生效,停
systemctl --version | head -1             # ≥ 243(OOMPolicy);alinux4 远高于此

# Chromium 沙箱:unit 里 NoNewPrivileges=true 使 setuid 沙箱失效,只能靠非特权 user namespace
sysctl user.max_user_namespaces           # 必须 > 0
sudo -u nobody unshare -U true && echo userns-ok   # 必须打印 userns-ok;报 Operation not permitted → 停
# (绝不用 --no-sandbox 绕过:那等于让不可信网页里的漏洞直通 llmrender 用户)

# DNS 解析器:决定 unit 里 IPAddressAllow= 写什么(见 10.5)
cat /etc/resolv.conf

# 内核是否支持 cgroup/BPF 防火墙(IPAddressDeny=):第一条应当**失败**,第二条应当成功
systemd-run --wait --pipe -p IPAddressDeny=any curl -sS -m 5 -o /dev/null https://www.aliyun.com \
  && echo "!! IPAddressDeny 未生效" || echo "deny-ok"
systemd-run --wait --pipe curl -sS -m 5 -o /dev/null https://www.aliyun.com && echo "baseline-ok"
# 若输出里有 "IP firewalling ... not supported" 之类告警 = 内核不支持 → 停(少了内核级这一层,不上线)
```

### 10.2 Chrome

```bash
cat > /etc/yum.repos.d/google-chrome.repo <<'EOF'
[google-chrome]
name=google-chrome
baseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64
enabled=1
gpgcheck=1
gpgkey=https://dl.google.com/linux/linux_signing_key.pub
EOF
```

**alinux4 上直接 `dnf install google-chrome-stable` 会失败**(2026-09-19 实测):
`nothing provides liberation-fonts needed by google-chrome-stable`。发行版有真正的字体包
(`liberation-sans-fonts` / `liberation-fonts-common`),唯独没有 `liberation-fonts` 这个**元包名**,
而 Chrome 的 RPM 点名要它;其余依赖(全部动态库)都能满足——
`dnf repoquery --requires google-chrome-stable` 逐条 `--whatprovides` 核过,只缺这一个。

不要 `rpm --nodeps` 硬装(此后每次 `dnf upgrade` 都会卡在同一个依赖上,Chrome 就再也拿不到安全更新),
也不必退到下面的 headless shell 备选。做一个**空的垫片包**把这个名字补上(provides 那个名字、requires 真字体):

```bash
mkdir -p /root/llms-study-shim && cd /root/llms-study-shim
cat > liberation-fonts-shim.spec <<'EOF'
Name:           liberation-fonts-shim
Version:        1.0
Release:        1
Summary:        Provides the liberation-fonts name that google-chrome-stable requires
License:        MIT
BuildArch:      noarch
Provides:       liberation-fonts = 2.1.5
Requires:       liberation-sans-fonts

%description
Alibaba Cloud Linux 4 ships liberation-sans-fonts but not the liberation-fonts metapackage that
google-chrome-stable depends on. This empty package provides that name so Chrome can be installed
from Google's dnf repository and keep receiving security updates. Safe to remove with Chrome.

%files
EOF
dnf install -y rpm-build                                  # 临时工具链,装完垫片就卸
rpmbuild -bb --quiet --define "_topdir /root/llms-study-shim/build" liberation-fonts-shim.spec
cp build/RPMS/noarch/liberation-fonts-shim-1.0-1.noarch.rpm . && rm -rf build

dnf install -y ./liberation-fonts-shim-1.0-1.noarch.rpm google-chrome-stable   # 约 160 个包、下载 255M、落盘 1.1G
dnf remove -y rpm-build
```

首次安装会导入 Google 的签名密钥,**核对指纹**:`EB4C 1BFD 4F04 2F6D DDCC EC91 7721 F63B D38B 4796`。

```bash
/opt/google/chrome/chrome --version       # Google Chrome 1xx.x;RENDER_CHROME_PATH 用这个**真二进制**,不是 /usr/bin 下的包装脚本
rpm -q google-chrome-stable liberation-fonts-shim
ldd /opt/google/chrome/chrome | grep -c "not found"       # 0
dnf check                                                 # 无输出 = 依赖关系干净,后续 dnf upgrade 不会被卡
```

(别的发行版若自带 `liberation-fonts` 元包,跳过垫片,直接 `dnf install -y google-chrome-stable`。
垫片的 spec 与 rpm 留在 `/root/llms-study-shim/`,重装机器时可直接复用那个 rpm。)

走包管理器是为了让浏览器跟着 `dnf upgrade` 拿安全更新——它是这台机器上攻击面最大的东西,别让它停在装机那天的版本。
升级后 `systemctl try-restart llms-study-render`(正在渲染的那一次会失败一次,可接受)。

备选(仅 aarch64,或 RPM 的依赖在 alinux4 上装不上时):

```bash
cd /opt/llms-study-api
PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx playwright-core install chromium-headless-shell
ls /opt/ms-playwright/chromium_headless_shell-*/chrome-linux*/headless_shell   # 这个路径填进 RENDER_CHROME_PATH
# 缺的动态库按报错逐个 dnf 装(nss atk at-spi2-atk cups-libs libdrm libXcomposite libXdamage libXrandr mesa-libgbm pango alsa-lib …):
/opt/ms-playwright/chromium_headless_shell-*/chrome-linux*/headless_shell --version
```

代价:这个二进制不随 dnf 更新,只随 `playwright-core` 版本更新——`deploy.sh --server` 之后要手工重跑上面的 install,
并同步更新 `render.env` 里的路径(目录名带版本号)。

### 10.3 运行用户

```bash
useradd --system --no-create-home --shell /sbin/nologin llmrender || true
id llmrender                              # uid/gid 都应是 llmrender,且不在 llmapp 组里
# 不需要手工建目录:/run/llms-study-render(socket)与 /var/lib/llms-study-render(Chrome 的 HOME)
# 由 unit 的 RuntimeDirectory= / StateDirectory= 自动创建并设好属主

# 代码目录必须对它可读(deploy.sh 以 root 解包,默认 0755/0644,正常情况下直接通过)
sudo -u llmrender test -r /opt/llms-study-api/dist/server/src/render/index.js && echo code-readable
sudo -u llmrender test -r /opt/llms-study-api/node_modules/playwright-core/package.json && echo deps-readable
# 反向自检:它**读不到** API 的机密与数据(下面两条都应报 Permission denied)
sudo -u llmrender cat /etc/llms-study/api.env
sudo -u llmrender ls /var/lib/llms-study
```

`dist/server/src/render/index.js` 不存在 = 线上代码还是旧版,先 `scripts/deploy.sh --server` 再回来。

### 10.4 /etc/llms-study/render.env(**无机密**,0644 即可)

```bash
cat > /etc/llms-study/render.env <<'EOF'
RENDER_SOCKET_PATH=/run/llms-study-render/render.sock
RENDER_CHROME_PATH=/opt/google/chrome/chrome
EOF
chmod 644 /etc/llms-study/render.env
```

只有这两行。**绝不**把 `api.env` 的内容抄进来,也**绝不**写 `RENDER_ALLOW_FORBIDDEN_DEV`
(本机开发用的 SSRF 逃生口;进程在 systemd 下检测到它会直接拒绝启动)。

### 10.5 systemd unit

```bash
# 本机执行
scp deploy/llms-study-render.service llm-pro:/etc/systemd/system/
```

**上机后先改 `IPAddressAllow=` 那一行**,写成 10.1 里 `cat /etc/resolv.conf` 看到的 nameserver,一个多余的地址都不要
(阿里云通常是 `100.100.2.136 100.100.2.138`;若是 `127.0.0.53` 就写 `127.0.0.53`)。
元数据地址 `100.100.100.200` 必须保持被拒。

```bash
ssh llm-pro
vi /etc/systemd/system/llms-study-render.service          # 改 IPAddressAllow=
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/llms-study-render.service   # 无报错(unknown lvalue = systemd 太旧)
systemctl enable --now llms-study-render
systemctl status llms-study-render --no-pager | head -12  # active (running)
journalctl -u llms-study-render -n 20 --no-pager          # 应见 [render] listening on unix:/run/llms-study-render/render.sock
ls -la /run/llms-study-render/                            # 目录 drwxr-x--- llmrender llmrender;render.sock srw-rw---- 
```

### 10.6 不经 API 的自检(此时功能对用户仍是关着的)

```bash
S=/run/llms-study-render/render.sock
curl --unix-socket $S -s http://x/health                   # {"ok":true}

# 真渲染一次:一篇纯客户端渲染的文章。期望 HTTP 200、十秒以内、html 几万字符、blockedScripts=0
curl --unix-socket $S -s -m 60 -o /tmp/render-smoke.json -w 'http=%{http_code} time=%{time_total}s\n' \
  -X POST -H 'content-type: application/json' \
  -d '{"url":"https://z.ai/blog/glm-built-its-inference-infrastructure"}' http://x/render
python3 -c "import json;j=json.load(open('/tmp/render-smoke.json'));print(len(j['html']),'Recursive Self-Improvement' in j['html'],j['blockedScripts'],j['agentVersion'])"

# 渲染进行中另开一个终端:沙箱必须开着(下面这条必须输出 0)
pgrep -u llmrender -fa chrome | grep -c -- --no-sandbox

# 渲染结束后不留浏览器进程(只剩一个 node)
pgrep -u llmrender -fa . 

# 安全抽查:每条都应被拒(403/400),不应挂起。前三条是毫秒级(不起浏览器);localhost 要一两秒——
# 它过得了 URL 形状校验,要到渲染器里解析出 127.0.0.1 才被拒
for u in http://127.0.0.1:8787/api/app/health http://100.100.100.200/latest/meta-data/ file:///etc/passwd http://localhost/; do
  curl --unix-socket $S -s -m 20 -w " <- $u http=%{http_code}\n" -X POST -H 'content-type: application/json' -d "{\"url\":\"$u\"}" http://x/render
done

# 内核级那一层:以本 unit 的身份与网络策略直接连内网/元数据,应当连不上(Operation not permitted / 超时)
systemd-run --wait --pipe -p User=llmrender \
  -p "IPAddressDeny=127.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16" \
  curl -sS -m 5 http://100.100.100.200/latest/meta-data/ ; echo "exit=$? (非 0 才对)"

# 内存:渲染时看峰值,应明显低于 768M
systemctl show llms-study-render -p MemoryPeak -p MemoryCurrent
```

启动失败且日志里有 `No usable sandbox` / `Failed to move to new namespace` = 10.1 的 userns 预检其实没过
(或被 sysctl/LSM 另行限制)→ **停用本 unit,不要加 --no-sandbox**。

### 10.7 启用(对用户生效)

顺序不能反:`llmrender` 组必须先存在(10.3),否则带 `SupplementaryGroups=llmrender` 的 API unit 起不来。

```bash
# 本机执行:更新 API 的 unit(新增 SupplementaryGroups=llmrender,让 API 进程打得开那个 0660 的 socket)
scp deploy/llms-study-api.service llm-pro:/etc/systemd/system/

ssh llm-pro
echo 'RENDER_SERVICE_SOCKET=/run/llms-study-render/render.sock' >> /etc/llms-study/api.env
systemctl daemon-reload
systemctl restart llms-study-api
curl -s http://127.0.0.1:8787/api/app/health                                  # API 本体仍然健康
grep Groups /proc/$(systemctl show -p MainPID --value llms-study-api)/status    # 列表里应有 llmrender 的 gid
# 以 API 的身份(llmapp + 附加组 llmrender)直连 socket:{"ok":true};去掉 --groups 那段应当 Permission denied
setpriv --reuid llmapp --regid llmapp --groups llmrender curl --unix-socket /run/llms-study-render/render.sock -s http://x/health
```

然后在 https://llm-pro.cn/#/papers 用「按 URL 导入」导入上面那个 z.ai 链接:进度应走到「服务器渲染」,导入成功。
未登录直接打 `POST /api/app/render-url` 应是 401;登录后短时间内连打,用满每用户容量(`RENDER_URL_RATE_CAPACITY`,现为 5,每 60s 回一枚)后的下一次应是 429。
(在后台标签页里导入会慢不少——浏览器暂停后台页的动画帧,页内捕获要等到 20s 硬超时才让位给服务器渲染;2026-09-19 线上实测后台标签页 43s,前台约 18s。)

### 10.8 回滚 / 关闭(由快到彻底)

```bash
# ① 即时总闸:API 不再转发,/api/app/render-url 回 503,前端回落到如实报错。用户无感知的其它功能不受影响
sed -i '/^RENDER_SERVICE_SOCKET=/d' /etc/llms-study/api.env && systemctl restart llms-study-api

# ② 停掉并禁用渲染服务(Chromium 进程随 cgroup 一并回收)
systemctl disable --now llms-study-render

# ③ 彻底卸载(可选)
rm /etc/systemd/system/llms-study-render.service && systemctl daemon-reload
dnf remove -y google-chrome-stable
```

`SupplementaryGroups=llmrender` 留在 API unit 里无害(组还在就行);要删 `llmrender` 用户/组,必须**先**把 API unit 里那一行去掉并 daemon-reload,否则 API 下次重启会因为组不存在而起不来。
代码层面的回滚同第 7 节(`.bak-*` 目录切换);`deploy.sh --server` 末尾的 `systemctl try-restart llms-study-render` 在 unit 未安装/已停用时是 no-op。

unit 进了 `failed`(5 分钟内崩溃 10 次)时 socket 会消失,API 自动回 503——这是设计内的失效方式;
查因:`journalctl -u llms-study-render -n 100 --no-pager`,修好后 `systemctl reset-failed llms-study-render && systemctl start llms-study-render`。

## 待办(后续阶段)

- P2:nginx 翻转 5 条 LLM location(见 nginx-llm-pro.conf 头注释);同时把现网 `/api/app/` 的 client_max_body_size 从 1m 提到 10m(P3 同步 push 批上限 8MB)
- P5 遗留:**OSS 异地备份**——单机备份挡不住整机故障;开阿里云 OSS bucket(同区域、低频存储),
  backup.sh 末尾追加 `ossutil cp -r /var/backups/llms-study oss://<bucket>/llms-study-backup/ --update`,
  凭证放 /root/.ossutilconfig(0600);bucket 侧配 90 天生命周期规则控制成本
- ADMIN_DAILY_CALL_LIMIT:如需给 admin 的服务端 key 调用加日上限,在 api.env 中设置(0/缺省 = 不限)

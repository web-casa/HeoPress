# 备份与恢复

HeoPress 内置的备份：数据库（每日全量 + 每小时增量，或小 VPS 用的仅全量导出）、媒体（按对象增量同步）与配置，
每份备份带 SHA-256 清单；可选加密；按 14 天 / 8 周保留整条恢复链；每周自动恢复演练，证明备份真的能恢复。
另有单站点导出与"导入为新站点"，用于迁移和复制站点。依据：spec `ops/backup-restore`、ADR-0013（保留期限）。

代码位置：`apps/cms/src/services/backup/`（`backup-service.ts` 备份、`database-backup.ts` 数据库、`media-backup.ts` 媒体、
`config-backup.ts` 配置、`manifest.ts` 清单、`crypto.ts` 加密、`target.ts` 备份目标、`retention.ts` 保留、
`restore.ts` 恢复、`drill.ts` 恢复演练、`worker.ts` 定时任务）、`apps/cms/src/services/site-export/`（单站点导出与导入）；
命令行 `apps/cms/scripts/backup-cli.ts`；表定义 `packages/database/src/schema/backups.ts`。

> 旧的 `docker/scripts/backup.sh`、`docker/scripts/restore.sh` 与 `docker/scripts/restore-drill.sh` 来自上游，只做
> `pg_dump` 到对象存储、不含媒体与清单，也不做哈希校验；新部署请使用本页的内置备份。

## 1. 前提

- **PostgreSQL 18 程序**：`pg_basebackup`、`pg_combinebackup`、`pg_verifybackup`、`pg_dump`、`pg_restore`，演练还需要
  `pg_ctl` 与 `postgres`。默认从 `PATH` 查找，也可用 `HEOPRESS_PG_BIN_DIR` 指定目录（Debian / Ubuntu 的 PGDG 软件包是
  `/usr/lib/postgresql/18/bin`）。版本须与数据库服务器一致。
- **官方应用镜像不含这些程序**（运行时镜像只装 Node，见 `docker/Dockerfile`）。Docker 部署时，在装有 Node 24 与
  PostgreSQL 18 程序的主机或辅助容器里运行 `heopress backup` 命令（第 3 节），并用系统 cron / systemd timer 定时；
  应用容器内不要设置 `HEOPRESS_BACKUP_TARGET`，否则定时备份会因找不到程序而失败（失败会通知管理员，不会静默）。
- **备份角色**：`HEOPRESS_BACKUP_DATABASE_URL`（未设置时依次用 `DATABASE_OWNER_URL`、`DATABASE_URL`）。
  `basebackup` 需要有 `REPLICATION` 权限的角色，且 `pg_hba.conf` 允许该角色的 `replication` 连接；`dump` 需要能读全部表的角色
  （表所有者或超级用户；应用角色受行级安全限制，不能用）。
- **增量备份的前提**（PostgreSQL 17+ 的增量 `pg_basebackup`）：`summarize_wal = on`、`wal_level` 为 `replica` 或 `logical`、
  角色有 `REPLICATION`。任何一项不满足时，显式要求的增量备份直接失败并写明缺哪一项；每小时的定时任务改做全量备份（见第 2 节），
  不会生成一份无法恢复的增量。开启方法：

  ```sql
  ALTER SYSTEM SET summarize_wal = on;
  SELECT pg_reload_conf();
  ```

## 2. 配置

全部是实例级环境变量，只由运行备份的进程读取；任何值都不写进备份或日志。

| 变量 | 含义 | 默认 |
|---|---|---|
| `HEOPRESS_BACKUP_TARGET` | 备份目标：`local:/var/lib/heopress/backups`（绝对路径），或 `s3`。不设置则不启用备份 | — |
| `HEOPRESS_BACKUP_S3_BUCKET`、`HEOPRESS_BACKUP_S3_ACCESS_KEY_ID`、`HEOPRESS_BACKUP_S3_SECRET_ACCESS_KEY` | `s3` 目标的桶与凭据（S3、R2、OSS、COS、MinIO 等兼容存储） | — |
| `HEOPRESS_BACKUP_S3_ENDPOINT`、`HEOPRESS_BACKUP_S3_REGION`、`HEOPRESS_BACKUP_S3_PREFIX`、`HEOPRESS_BACKUP_S3_FORCE_PATH_STYLE` | 端点、区域、前缀、路径风格 | 前缀 `heopress-backups` |
| `HEOPRESS_BACKUP_METHOD` | `basebackup`（物理备份，全量 + 增量）或 `dump`（`pg_dump` 逻辑备份，仅全量，适合小 VPS） | `basebackup` |
| `HEOPRESS_BACKUP_DATABASE_URL` | 备份角色的连接串 | 见第 1 节 |
| `HEOPRESS_BACKUP_ENCRYPTION_KEY_FILE` | 备份密钥文件（32 字节：原始字节、64 位十六进制或 base64）。不设置则不加密 | — |
| `HEOPRESS_BACKUP_CONFIG_FILES` | 要一并备份的配置文件（逗号分隔的绝对路径，如 env 文件、Caddyfile）；**仅在加密时**写入 | — |
| `HEOPRESS_BACKUP_DRILL_DATABASE_URL` | `dump` 演练创建临时数据库所用的连接（需要 `CREATEDB`） | 备份角色所在服务器的 `postgres` 库 |
| `HEOPRESS_BACKUP_SCHEDULE` | `off` 关闭定时备份与演练（Studio 和命令行的手动操作仍可用） | 开启 |
| `HEOPRESS_BACKUP_FULL_CRON`、`HEOPRESS_BACKUP_INCREMENTAL_CRON`、`HEOPRESS_BACKUP_DRILL_CRON` | 计划（node-cron，带秒） | 每天 02:30 全量、每小时 15 分增量、每周日 04:00 演练 |
| `HEOPRESS_BACKUP_MAX_CHAIN` | 一条链上全量之后最多几份增量，超出后下一次做全量 | 48 |
| `HEOPRESS_RETENTION_BACKUP_DAILY`、`HEOPRESS_RETENTION_BACKUP_WEEKLY` | 保留：最近多少天各留一份、最近多少周各留一份 | 14、8 |
| `HEOPRESS_PG_BIN_DIR` | PostgreSQL 18 程序目录 | `PATH` |
| `HEOPRESS_SITE_EXPORT_DIR` | Studio 发起的单站点导出写到哪里 | `./data/exports` |

设置了 `HEOPRESS_BACKUP_TARGET` 后，CMS 的工作进程按计划运行：每日全量；每小时的任务做增量（`auto`：没有可用基础备份、链已满或
增量前提不满足时做全量），成功后按保留策略清理；每周演练；另外每分钟处理 Studio 或 API 发起的"立即备份 / 立即演练"。
同一时刻只有一个备份、清理或演练在运行（数据库咨询锁），清理永远不会删掉一个正在写入、尚未写清单的备份的内容。

## 3. 命令行

在 `apps/cms` 目录下运行（需要 `DATABASE_URL` 与上面的备份变量）：

```bash
npx tsx scripts/cli.ts backup run --kind full           # 立即备份：full、incremental 或 auto
npx tsx scripts/cli.ts backup list                      # 备份目录与最近的演练
npx tsx scripts/cli.ts backup verify <备份ID> --key-file /etc/heopress/backup.key   # 校验整条链的清单与每个对象的哈希，不恢复
npx tsx scripts/cli.ts backup drill                     # 立即对最新备份做恢复演练
npx tsx scripts/cli.ts backup prune                     # 按保留策略清理
```

命令返回 JSON；备份、校验或演练失败时退出码为 2。

## 4. 备份的内容

一份备份位于目标的 `backups/<备份ID>/` 下：

- **数据库**：`basebackup` 是 `pg_basebackup` 的普通格式副本（WAL 随之流式写入，可独立启动），增量备份以上一份备份的
  `backup_manifest` 为基准；`dump` 是 `pg_dump` 自定义格式，并在同一快照中记录每张表的行数。
- **配置**：`config/instance.json` 记录非秘密的 `HEOPRESS_*` 设置，以及**已设置的秘密的名称**（不记录值或其哈希），
  恢复时据此知道需要另行交接哪些秘密；`HEOPRESS_BACKUP_CONFIG_FILES` 列出的文件只在加密备份中写入。
- **媒体**：实例存储与每个站点存储配置中的每个对象，按内容 SHA-256 只存一次（目标的 `media/` 下），之后的备份只写新内容；
  更新时间与大小未变的对象不再读取。
- **清单** `manifest.json`：数据库版本与系统标识、应用版本与提交、各站点内容仓库的提交、每个对象的大小与 SHA-256
  （加密时同时记录密文与明文哈希）、每个媒体对象、所属链。最后写入：没有清单的备份不算备份，其残留文件会被删除。
  旁边的 `manifest.json.sha256` 可在没有密钥时发现损坏；加密时还有 `manifest.json.mac`（备份密钥下的 HMAC）发现篡改。

**媒体一致性**：数据库先于媒体备份，所以数据库引用的每个对象在列出时都已存在。备份过程中被改写的对象按"读到的字节"
计算哈希并保存，清单只指向确实存在的内容；列出之后被删除的对象沿用上一份备份的副本（报告中记为 `carried`）。

## 5. 加密与密钥

- 加密为 AES-256-GCM 分块流：每个文件用 HKDF 从备份密钥与随机盐派生独立密钥，任一块被重排、删除、截断或密钥错误都会失败。
  加密备份中的媒体以带密钥的名称存放，目标里看不到明文哈希。
- **密钥不得与备份放在一起**：本地目标时，位于目标目录内的密钥文件会被拒绝（`KEY_BESIDE_BACKUPS`）。清单只记录密钥 ID。
- 生成密钥并单独保管（例如密码管理器、另一台机器或离线介质）：

  ```bash
  openssl rand -hex 32 > /etc/heopress/backup.key && chmod 600 /etc/heopress/backup.key
  ```

- 恢复必须**单独提供密钥**（`--key-file` 或 `HEOPRESS_BACKUP_ENCRYPTION_KEY_FILE`），不会从备份或实例设置中读取；
  给错密钥时报 `KEY_MISMATCH` 并给出所需的密钥 ID。`JWT_SECRET`、`ENCRYPTION_KEY` 与数据库密码同样不在备份中，须一并独立保管。
  丢失备份密钥等于丢失加密备份。

## 6. 保留策略

按 ADR-0013：最近 14 天每天保留最新的一份成功备份，最近 8 个 ISO 周每周保留一份，最新的成功备份与运行中的备份始终保留；
**被保留的备份依赖的整条链**（全量及其之前的增量）一起保留，绝不只删基础备份而留下无法恢复的增量。其余备份（包括失败的）
被删除，数据库中的记录标为 `removed`。之后不再被任何清单引用的媒体内容也一并删除。

保留期限由数据保留策略读取（`HEOPRESS_RETENTION_BACKUP_DAILY`、`HEOPRESS_RETENTION_BACKUP_WEEKLY`，无效值回退到默认值并在启动时警告），
保留计划由数据保留模块的 `planBackupRetention` 计算（`apps/cms/src/services/retention/backup-pruner.ts`）。清理在三处执行，
都在同一把备份锁下：每日的数据保留任务（`data-retention`，配置了备份目标时 CMS 启动时注册备份清理器，见
[数据保留](data-retention.md)）、每次备份成功之后（定时备份或 `backup run`）、以及手动 `backup prune`。

## 7. 恢复

先校验，再恢复到**空的**目标，最后在开放写入之前**重放删除账本**（见下文"删除账本"）：

```bash
npx tsx scripts/cli.ts backup verify <备份ID> --key-file /secure/backup.key
```

**`dump` 备份**：恢复到一个新建的空数据库（`pg_restore`，不带原所有者与授权），恢复媒体后立即重放删除账本：

```bash
npx tsx scripts/cli.ts backup restore <备份ID> --key-file /secure/backup.key \
  --database-url postgresql://heopress:<密码>@db.example.com:5432/heopress_restored \
  --media-dir /var/lib/heopress/restored-media
```

**`basebackup` 备份**：整条链用 `pg_combinebackup` 合并到 `--data-dir`（必须为空或不存在），并用 `pg_verifybackup` 校验：

```bash
npx tsx scripts/cli.ts backup restore <备份ID> --key-file /secure/backup.key \
  --data-dir /var/lib/postgresql/18/restored --media-dir /var/lib/heopress/restored-media
```

然后以数据库所有者身份在该目录上启动 PostgreSQL 18，再重放删除账本（有 `--media-dir` 时对其中恢复的媒体操作）：

```bash
npx tsx scripts/cli.ts backup finish-restore <备份ID> --key-file /secure/backup.key \
  --database-url postgresql://heopress:<密码>@db.example.com:5432/heopress
```

要点：

- **缺失基础链时恢复明确失败**（`BASE_CHAIN_MISSING`），在写入任何内容之前；不会"部分恢复"一个增量备份。
- 每个对象读取时都按清单校验哈希，不一致即失败。
- 媒体恢复到 `--media-dir/<存储名>/`（实例存储为 `default`），再按需复制回本地存储目录或对象存储。
- **删除账本重放**在开放写入前运行（`apps/cms/src/services/backup/ledger-replay.ts` 调用数据保留模块的
  `replayDeletionLedger`）：备份之后被删除的个人数据会随恢复回来，重放把它们再次删除、补回账本表中缺失的行，
  输出中列出每条记录的结果。只要有一条记录无法再次删除，命令以退出码 2 结束并给出 `writesMayOpen: false`：
  此时**保持应用停止、不开放写入**，处理完失败记录（输出中有站点、对象与错误名）后重新执行 `finish-restore`，
  直到 `writesMayOpen: true`。
- 恢复只覆盖到备份时刻：v1 不做任意时间点恢复（PITR），需要时见第 10 节 pgBackRest。

### 删除账本

删除账本（数据保留模块，见[数据保留](data-retention.md)）记录每个个人数据删除请求删掉的对象。它有两份：数据库中的
`lumibase_deletion_ledger` 表（会随恢复回到备份时的状态），以及**外部账本**——`HEOPRESS_DELETION_LEDGER_DIR`
指定的目录，未设置时为对象存储中的 `ops/deletion-ledger/` 前缀。恢复依赖外部账本找回备份之后的删除记录，因此：

- 外部账本**必须放在恢复不会回滚的地方**：独立的卷或目录，不能放在要被恢复覆盖的数据目录、媒体目录或备份目标里；
  用对象存储时，恢复媒体不得覆盖或删除 `ops/deletion-ledger/` 前缀。
- 外部账本要**像密钥一样单独备份**（例如复制到另一台机器或另一个桶，只追加不删除），它不包含在 HeoPress 备份中。
- 恢复与演练都会读取它：`backup restore`、`backup finish-restore` 和每周演练使用同一配置
  （`HEOPRESS_DELETION_LEDGER_DIR` 或对象存储），运行这些命令的环境必须能访问它。

## 8. 自动恢复演练

每周（`HEOPRESS_BACKUP_DRILL_CRON`）把最新的成功备份恢复到临时环境并检查：

1. 整条链与每份清单（SHA-256 与 MAC）；
2. 每个数据库与配置对象、每个媒体对象的哈希；
3. 数据库恢复：`dump` 恢复到临时数据库 `heopress_drill_*`；`basebackup` 合并、校验后在临时数据目录上启动一个临时服务器；
4. 行数与清单比对（`dump` 精确比对；物理备份的行数是备份开始时的近似值，只要求每张表存在）；
5. 删除账本重放：在副本上执行与恢复时相同的重放（外部账本在演练隔离开始前读取，只读不写；重放只写副本），
   任何一条记录无法再次删除都会让演练失败，并在报告中列出该记录（`站点/对象类型/对象ID`）；
6. 只读渲染冒烟：在恢复的库上用 Classic 渲染器请求每个公开站点的首页与一篇已发布页面，不得出现 5xx。

**隔离**：临时服务器只监听私有 Unix 套接字（不开 TCP），临时数据库是新库、绝不是生产库，恢复的媒体写到临时目录；
演练期间不对副本运行任何队列、调度或工作进程，不提供生产密钥（加密凭据保持加密），并拒绝一切外发请求——任何外发尝试都会让演练失败。
结束后临时数据库、目录与服务器全部清理。

结果记录在 `lumibase_backup_drills`，Studio 的"日志与监控 › 备份"页面显示每项检查与失败对象。演练失败时，实例管理员收到通知，
并在实例事件中记一条错误，内容包括失败的检查与对象（例如哪个媒体对象与清单的哈希不符）。

## 9. 单站点导出与导入为新站点

导出复用 P12 的导入包格式（`docs/schemas/heopress.import-bundle.v1.schema.json`），增加集合结构、关联、主题、站点设置、
采集源与自动发布阈值等记录。只有该站点的管理员可以导出；其他用户请求时返回 `FORBIDDEN`。

```bash
npx tsx scripts/cli.ts backup export-site --site <站点ID> --actor <用户ID> --out /var/lib/heopress/exports/site-a
npx tsx scripts/cli.ts backup import-site --bundle /var/lib/heopress/exports/site-a \
  --site <新站点ID> --name "站点 A 副本" --actor <用户ID>
```

Studio 中站点管理员可在"日志与监控 › 备份"发起导出，结果写到 `HEOPRESS_SITE_EXPORT_DIR/<站点ID>/<导出ID>`；
导入为新站点只能由实例管理员在命令行执行。

**导出的安全范围**：

- 只包含本站点的内容、设置、主题版本与媒体；翻译组只保留本站点的成员，其他站点的成员不导出（报告中给出数量）；
- 共享密钥与凭据不导出：加密字段、凭据字段、带凭据的采集源地址、站点设置中的凭据均被丢弃，报告列出被丢弃的项；
- 媒体地址改写为包内引用，暂不支持的媒体类型（如 SVG）被丢弃并记入报告。

**导入为新站点**：新站点 ID、新的区块 ID 与关联 ID（全部重新映射）；内容以草稿导入后通过 P12 的批次激活；
**域名不绑定，采集源导入后暂停，自动发布设置保留阈值但不授予信任等级（即不自动发布）**；插件采集源不导入。导入需要媒体存储配置：
新站点使用本地存储配置（可用 `--media-public-url` 指定公开地址）。导入报告列出所有被停用的项，运营者确认后再人工启用。

不导出的内容：内容修订历史与重定向规则（导入后从当前版本开始记录）。

## 10. 可选方案：pgBackRest

需要任意时间点恢复（PITR）、并行压缩、多仓库或更大的数据库时，可以改用 [pgBackRest](https://pgbackrest.org/)
（MIT 许可，独立安装在数据库主机上，HeoPress 不依赖它）。它多一个需要运维的组件，因此不是默认方案。

1. 在数据库主机安装 pgBackRest，配置 `/etc/pgbackrest/pgbackrest.conf`：

   ```ini
   [global]
   repo1-type=s3
   repo1-s3-bucket=heopress-backups
   repo1-s3-endpoint=s3.example.com
   repo1-s3-region=auto
   repo1-path=/pgbackrest
   repo1-retention-full=2
   repo1-retention-diff=14
   repo1-cipher-type=aes-256-cbc
   start-fast=y

   [heopress]
   pg1-path=/var/lib/postgresql/18/main
   ```

   S3 凭据与 `repo1-cipher-pass` 放在只有 postgres 用户可读的文件或环境中，并与备份分开保管。
2. PostgreSQL 中设置 `archive_mode = on`、`archive_command = 'pgbackrest --stanza=heopress archive-push %p'`，然后
   `pgbackrest --stanza=heopress stanza-create` 与 `pgbackrest --stanza=heopress check`。
3. 用系统定时器调度 `pgbackrest --stanza=heopress --type=full backup`（每周）与 `--type=diff`（每日）。
4. 恢复：停止 PostgreSQL，`pgbackrest --stanza=heopress --delta restore`，需要时加 `--type=time --target="2026-10-29 03:00:00+00"`。

采用 pgBackRest 时：

- HeoPress 的备份目录、Studio 页面与每周演练不知道 pgBackRest 的备份。请定期执行 `pgbackrest verify`，并自行在隔离主机上
  做恢复演练（恢复到临时目录、启动、检查行数与页面）。
- 媒体与配置仍需备份：可以保留 HeoPress 内置备份并设 `HEOPRESS_BACKUP_METHOD` 为 `dump`、降低频率，它同时负责媒体、配置与每周演练；
  或用对象存储自身的版本化与复制。
- 恢复后同样要在开放写入前重放删除账本：`backup finish-restore` 需要一份 HeoPress 备份的 ID 作为上下文，
  使用与恢复时间点最接近的一份。

# 升级

用 `heopress upgrade` 把一个 Docker Compose 部署的 HeoPress 升级到新版本：先检查兼容性、备份、在数据库副本上预演迁移，
再冻结全部写入、做最终备份、迁移、切换应用、冒烟测试，最后开放写入。任何一步失败都不会带着半升级的状态开放写入
（spec `ops/upgrades`）。英文版的通用流程（版本策略、发布通道、手动回滚的限制）见 [Upgrade Operations](../../en/operations/upgrades.md)。

代码位置：`apps/cms/scripts/upgrade-cli.ts`（命令）、`apps/cms/src/services/upgrade/`（`orchestrator.ts` 步骤与回滚、
`compat.ts` 兼容检查、`maintenance-control.ts` 维护开关与写入排空、`journal.ts` 升级记录、`ports.ts` 备份等外部接口、
`adapters/` Compose 切换、配置快照、冒烟测试与预演库）；进程内的写入闸门在 `apps/cms/src/services/maintenance/write-gate.ts`，
HTTP 拦截在 `apps/cms/src/middleware/maintenance.ts`；表定义在 `packages/database/src/schema/maintenance.ts`。

## 命令

在宿主机上、新版本的代码目录里（`apps/cms`）运行，连接生产库的**表所有者**账号：

```bash
npx tsx scripts/cli.ts upgrade check                # 只做兼容检查，不改任何东西
npx tsx scripts/cli.ts upgrade run                  # 完整升级
npx tsx scripts/cli.ts upgrade status [--id <id>]   # 最近一次（或指定）升级的记录
npx tsx scripts/cli.ts upgrade rollback --id <id>   # 重试一次停在维护中的升级的恢复
```

退出码：`0` 成功或已是目标版本；`1` 用法错误；`2` 升级被中止、已回滚，或回滚被拒绝；`3` 恢复未通过验证，**维护仍开着**。

| 环境变量 | 含义 | 默认 |
|---|---|---|
| `DATABASE_OWNER_URL` | 生产库的所有者连接（没有时用 `DATABASE_URL`） | — |
| `HEOPRESS_UPGRADE_DIR` | 升级记录与配置副本的目录 | `./data/upgrades` |
| `HEOPRESS_UPGRADE_ENV_FILE` | Compose 的 env 文件，`HEOPRESS_VERSION` 写在这里 | `./.env` |
| `HEOPRESS_UPGRADE_COMPOSE_ARGS` | `docker compose` 在 `up` 之前的参数 | `-f docker/docker-compose.yml -f docker/docker-compose.prod.yml` |
| `HEOPRESS_UPGRADE_SERVICES` | 要切换的服务 | `cms worker site` |
| `HEOPRESS_UPGRADE_CONFIG_FILES` | 还需要快照的配置文件，逗号分隔 | — |
| `HEOPRESS_UPGRADE_CMS_URL` | 宿主机访问 CMS 的地址 | `http://127.0.0.1:1989` |
| `HEOPRESS_UPGRADE_SMOKE_URLS` | 升级后必须返回 200 的公开页面，逗号分隔 | — |
| `HEOPRESS_UPGRADE_DRAIN_TIMEOUT_SECONDS` | 等待写入排空的时间 | `120` |
| `HEOPRESS_UPGRADE_TARGET_VERSION` | 要安装的版本 | 当前代码目录的版本 |
| `HEOPRESS_BACKUP_TARGET` 等 `HEOPRESS_BACKUP_*` | 升级用的备份，与 `heopress backup` 相同（见"备份接口"） | — |

命令不打印连接串或任何秘密。

## 步骤

| # | 步骤 | 失败时 |
|---|---|---|
| 1 | 兼容检查：不降级、不跨主版本、PostgreSQL ≥ 18、生产库的迁移历史是新版本迁移的前缀（哈希一致）、生产库不比新版本新、每个已安装插件声明的 `heopress` 版本范围包含新版本、已注册备份提供者 | 中止，什么都没改 |
| 2 | 快照配置文件（env 文件与 `HEOPRESS_UPGRADE_CONFIG_FILES`） | 中止 |
| 3 | 备份（`pre-upgrade`） | 中止 |
| 4 | 把备份恢复到临时库 `heopress_upgrade_<id>`，在上面跑新版本迁移，然后删掉临时库 | 中止，**不进入维护**，生产不受影响 |
| 5 | 进入维护模式，冻结全部写入 | 关闭维护，中止 |
| 6 | 等待写入排空（见下文） | 关闭维护，中止 |
| 7 | 最终备份（`final`）：包含预演期间用户保存的修改 | 关闭维护，中止 |
| 8 | 在生产库上执行迁移 | 恢复（见下文） |
| 9 | 切换应用：改写 env 文件里的 `HEOPRESS_VERSION`，`docker compose up -d --wait`，确认 `/api/v1/system/version` | 恢复 |
| 10 | 冒烟测试：`/health/ready`、版本、`HEOPRESS_UPGRADE_SMOKE_URLS` | 恢复 |
| 11 | 关闭维护，开放写入 | — |

升级记录写在 `HEOPRESS_UPGRADE_DIR` 下的文件里，不写在数据库里，所以恢复数据库不会把记录本身也回滚掉。
记录的状态：`running`、`up-to-date`、`aborted`（第 1–7 步失败）、`completed`、`rolled-back`（恢复并验证成功）、
`failed-in-maintenance`（恢复失败）。

## 写入冻结

维护开关是表 `lumibase_maintenance` 的一行，只有表所有者能改（应用角色只能读）。每个 CMS 进程（`web`、`worker`、
`all`）每几秒读一次开关，并把自己的状态写进 `lumibase_maintenance_acks`。开关打开后，进程：

- 对 REST 的 `POST`、`PUT`、`PATCH`、`DELETE` 以及 OAuth 回调返回 `503`，错误码 `MAINTENANCE`，带 `Retry-After: 60`；
  读请求、GraphQL 查询和只读的 MCP 方法与工具照常可用，GraphQL 变更与写入类 MCP 工具同样返回 `503`；
- 暂停队列消费（不再取新任务，等进行中的任务结束）、定时任务（本轮跳过）、事件消费者和 Astro 构建循环；
- 刷新审计缓冲；
- 进行中的写请求结束后，确认"已冻结、进行中写入为 0"。

进程启动后在第一次读到维护开关之前拒绝写入；读不到开关时保持上一次读到的状态（已冻结的进程保持冻结）。

升级命令只有在**每个进程**都确认了本次冻结、且数据库里除升级命令自己外没有其他持有写事务的连接时才继续；超时则关闭维护并中止。
Studio 在维护期间显示提示条（"维护中"），内容来自 `GET /api/v1/system/maintenance`。

## 失败与恢复

进入维护后的失败按这个顺序恢复：配置文件 → 数据库（从最终备份恢复）→ 旧版本应用，然后验证数据库与最终备份一致、配置文件与快照一致、
运行的是旧版本。验证通过才关闭维护（状态 `rolled-back`）；验证失败则**维护保持开启、写入保持关闭**，记录迁移失败与恢复失败的步骤
（状态 `failed-in-maintenance`）。排除问题后运行 `upgrade rollback --id <id>` 重试恢复。

预演期间（第 3–7 步之间）用户保存的内容在最终备份里，所以回滚后仍然存在。

**新版本开放写入后不能回滚。** 对状态为 `completed` 的升级运行 `upgrade rollback` 会被拒绝：恢复旧备份会丢掉开放写入以后的所有数据。
这时先制定数据保留方案（导出新数据、决定保留哪些、再人工恢复），或者用向前修复代替回滚。

## 备份接口

备份由备份与恢复模块（P13 1.x）提供，升级只通过 `apps/cms/src/services/upgrade/ports.ts` 的 `UpgradeBackupProvider` 接口使用它：
`takeBackup`（`pre-upgrade` / `final`）、`restoreCopy`（恢复到预演库）、`restoreProduction`、`verifyProduction`。
`heopress upgrade` 在配置了备份目标（`HEOPRESS_BACKUP_TARGET` 及其他 `HEOPRESS_BACKUP_*`，与 `heopress backup` 相同，
见[备份与恢复](backup-restore.md)）时用 `registerUpgradeBackupProvider` 注册备份模块
（`apps/cms/src/services/upgrade/adapters/backup-module.ts`）；**没有备份目标时兼容检查失败，升级不会开始**。

- 升级的两份备份都是普通的全量备份：进入备份目录、按保留策略清理、可以用 `heopress backup restore` 恢复。
  无论 `HEOPRESS_BACKUP_METHOD` 设成什么，升级都用 `dump` 方式：dump 可以直接恢复到一个数据库，基础备份需要另起服务器。
- 预演库用 `pg_restore` 恢复，保留所有者与权限（角色在同一台服务器上）。
- 恢复生产库时先在旁边建一个新库（与生产库相同的所有者、编码、排序规则、连接上限、数据库级权限与设置），恢复进去，
  逐表行数与备份清单核对，然后改名替换生产库。替换前任何一步失败，生产库都保持原样；替换后重放删除账本（P13 5.2），
  重放失败则恢复失败、写入保持关闭。被替换的旧库拒绝连接，`verifyProduction` 通过后才删除；验证失败时保留，名字写在失败报告里。
- 所有者角色需要能创建、改名、删除数据库（Compose 部署的数据库所有者是超级用户）。媒体文件不恢复：升级不改变媒体。

## 插件 API 破坏性变更

插件 API 的破坏性变更列在发布说明里，能确定转换的部分由 codemod 处理，其余部分报告为人工步骤，原样保留代码：

```bash
heopress-ext codemod --list                          # 有哪些 codemod、各自覆盖哪些变更
heopress-ext codemod --dir ./my-plugin               # 只报告会改什么、哪些要人工处理
heopress-ext codemod --dir ./my-plugin --write       # 写入可确定的转换
heopress-ext codemod --dir ./my-plugin --only lumibase-to-heopress
```

代码位置：`packages/extension-cli/src/codemods/`（`framework.ts` 框架、`lumibase-to-heopress.ts` 示例）。
codemod 用 TypeScript 解析器按位置改写，保留格式与注释；有人工步骤时退出码为 `3`。

`lumibase-to-heopress`（LumiBase Extension SDK 0.x → HeoPress 1.0）：

| 变更 | 处理 |
|---|---|
| `@lumibase/extension-sdk` → `@heopress/extension-sdk`，`@lumibase/sdk` → `@heopress/sdk`（导入、导出、`import()`、`require()`、类型导入、`declare module`） | 自动转换 |
| `package.json` 里的这两个包，改为 1.0 版本范围 | 自动转换 |
| 清单文件 `lumibase-extension.json` → `heopress-extension.json` | 自动转换 |
| 清单字段 `compatibleWith` → `heopress` | 自动转换 |
| `heopress` 版本范围不含 1.0 | 报告：在 1.0 上测试后放宽 |
| 其他 `@lumibase/*` 包 | 报告：插件只能依赖 Extension SDK |
| `LUMIBASE_*` 环境变量 | 报告：插件没有环境变量，改用设置或秘密 |
| 插件名以 `lumibase-` 开头 | 报告：改名会改变插件在每个站点上的身份 |
| 运行时拼出的模块名 | 报告 |

升级前用官方 Skill `heopress-upgrade`（`skills/upgrade/SKILL.md`）让 Agent 按这份流程检查与执行。

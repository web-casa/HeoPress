# 已知问题与预期失败

本文件列出 CI 中被标记为"预期失败"的测试及其原因。规则（P01 任务 3.3）：上游既有失败必须逐个修复；
确实无法在当前 phase 修复的才标记为 CI 中可见的预期失败，并在此登记复现方式、影响与计划修复的 phase。不得整体跳过测试。

## 当前预期失败

无。

## 已知缺陷（未修复）

不是测试失败，而是已确认、已排期的产品缺陷（ADR-0017）。

| 缺陷 | 影响 | 复现方式 | 计划 |
|---|---|---|---|
| URL 采集的加工 outbox 没有消费者（P14 清点无人消费的队列时发现） | P08 把每篇代表来源文档的后续加工任务写入 `lumibase_ingest_processing_jobs`，原计划由 P09 消费，但 P09 的内容流水线只按来源文档 ID 处理（Flows 的 `pipeline:*` 操作、提示词工作台），没有任何进程读取这些行；P14 前它们被投递到无人消费的 `ingest-process` 队列。现在这些行保持 `pending`，抓取到的文档要由运营者或定时 Flow 指定 ID 送入流水线 | 抓取一个 `url` 信源后查询 `SELECT status, count(*) FROM lumibase_ingest_processing_jobs GROUP BY status` | 由后续 phase 实现 outbox 消费者（按站点范围、按行幂等）：登记 `ingest-process` 队列并在 worker 中注册，或由维护任务直接认领 `pending` 行 |
| 页面浏览 `cdc` 策略不再向队列发出事件（P14） | 该策略原先把每次访问额外投递到无人消费的 `pageview-cdc` 队列；P14 删除了这次投递，策略现在与 `db-rollup` 相同，每次访问写入 `lumibase_pageview_events` | 设置 `pageviews.strategy = 'cdc'` 后访问页面，`pgboss.job` 中没有 `pageview-cdc` 任务 | 外部管道（如 Debezium → ClickHouse）从 `lumibase_pageview_events` 的变更读取；如需专门的事件出口，另立变更 |
| 图片上传入队无人消费的 `media-processing` 任务（P13 镜像运行验收发现） | 上游 `POST /media/:key` 为每张图片入队 `generate-thumbnails`，但没有任何进程注册该队列（P03 起图片变换在请求时进程内完成）；这些任务停在 `created`，直到 pg-boss 按过期与保留策略清理，任务积压统计会一直包含它们 | 上传一张图片后查询 `SELECT count(*) FROM pgboss.job WHERE name = 'media-processing' AND state = 'created'` | 由维护者决定删除该入队还是补上缩略图 worker；在此之前 `docker/scripts/accept-mixed-load.mjs` 把该队列单独计为 `orphanQueued`，不计入积压 |

## 已修复的上游失败

上游 CI 只按名称运行 `integration` 测试，下列测试从未在带数据库或带 `HEOPRESS_ENV` 的环境中跑过。
P01 把 CI 改为整套运行数据库测试后发现并修复：

| 测试 | 现象 | 原因与修复 | 提交 |
|---|---|---|---|
| `packages/database/src/__tests__/ai-approvals.property.test.ts` | 插入时报 `Cannot read properties of null (reading 'constructor')`，随种子出现 | fast-check 4 可能生成无原型对象，drizzle 无法处理；生成器加 `noNullPrototype` | 7bb53641 |
| 同上 | Agent 名为 `lumibase-copilot`，期望 `heopress-copilot` | 改名只改了 schema，迁移中的列默认值未改；新增迁移 0019 | b2c8f667 |
| `packages/database/src/__tests__/revision-provenance.property.test.ts` | `1e-45` 与 `1.401298464324817e-45` 不等 | PostgreSQL 以最短 float32 形式输出 `real`；按 float32 比较 | b2c8f667 |
| `apps/cms/src/middleware/__tests__/rls.test.ts` | 生产模式失败关闭用例返回 200 | 中间件也读 `process.env.HEOPRESS_ENV`，测试环境为 development 时被跳过；测试内清空该变量 | 7bb53641 |
| Change Feed 晚提交漏读（P04 9.1） | 游标为 `(occurred_at, id)` 加 2 秒安全延迟，写事务开始后超过 2 秒才提交时其事件会被已推进的游标跳过 | 事件改为按位置（写入事务 id `txid` + 序号 `seq`）排序，读取端只读比所有进行中事务都早的事务（`txid < pg_snapshot_xmin(pg_current_snapshot())`），晚提交的事件晚读到、不会被跳过；`late-commit.db.integration.test.ts`、`consumer-runner.db.integration.test.ts` 覆盖，去掉该条件时失败 | P04 8.x/9.1 提交 |
| 数据库测试以超级用户运行（P03 7.1） | 超级用户绕过 RLS，测试不能证明 RLS 在生产角色下生效 | CI 改为迁移用表所有者、所有数据库测试用应用角色 `heopress_app`（无 SUPERUSER、无 BYPASSRLS，`pnpm --filter @heopress/database app-role`）；新增 `rls.db.test.ts`，以应用角色执行并带守卫（超级用户/BYPASSRLS 时报错）。该测试发现 `rls-policies.sql` 只建 `AS RESTRICTIVE` 策略——没有宽松策略时 PostgreSQL 拒绝所有行，按文件执行后非超级用户角色读不到任何数据；改为默认（宽松）策略。Codex 第 5 轮复审后收紧：应用角色不再有 TRUNCATE（RLS 不约束 TRUNCATE）和 TRIGGER（挂在所有者表上的触发器会以所有者权限执行），测试库用 `app-role --test-database` 另加 TRUNCATE；已存在的角色若属于其他角色或拥有启用 RLS 的表则拒绝；扩展表改为全局行只读、写入限本站点；设置了 `DATABASE_URL` 而缺少 `DATABASE_OWNER_URL`、或 `DATABASE_URL` 能绕过 RLS 时，`rls.db.test.ts` 直接失败而不是跳过 | P03 7.1 提交、第 5 轮修复 |
| Change Feed（P02 新增端到端测试 `change-feed.e2e.test.ts` 发现） | 拉取消费者每次读取都会再收到上一批的最后一个事件；Webhook 派发每轮把同一批最多重发 1000 次 | 产品缺陷：`occurred_at` 为微秒精度而游标只带毫秒，键集条件对游标所指事件本身成立；迁移 0020 把两列改为 `timestamp(3)` | P02 3.2 提交 |
| `apps/cms/src/services/__tests__/g3-dispatch-reliability.db.integration.test.ts`（两个并发派发） | 约 20% 概率两边都不派发 | 产品缺陷：租约持有者加锁段用 `SKIP LOCKED`，被对方的瞬时行锁挤掉；改为受 `lock_timeout` 约束的 `FOR UPDATE` | 914a0969 |
| 审计日志分页与导出（P14 3.1，`audit-pagination.db.integration.test.ts` 复现） | 同一毫秒内比页边界行更晚的记录既不早于、也不等于毫秒游标，下一页与下一批导出都跳过它们（5 条同毫秒记录每页 2 条只读到 2 条） | 产品缺陷：游标为毫秒、`lumibase_audit_log.timestamp` 为微秒；迁移 0123 把该列改为 `timestamp(3)`（与 Change Feed 迁移 0020 相同），游标与列精度一致 | P14 3.2 提交 |
| 跨站翻译组成员站点同时写入（P14 4.1，`settings-lock-order.db.integration.test.ts` 复现） | 两个成员站点同时修改内容设置时互相等待对方的设置行，PostgreSQL 记录死锁，牺牲方重试（耗尽时返回 409） | 产品缺陷：设置行没有全局加锁顺序；新增 `services/site-network/settings-locks.ts`，事务开始时按站点 ID 升序一次性锁定本站点与其翻译邻居的设置行，之后只允许向更大的 ID 补锁，否则重新开始并把该站点加入下一次的计划 | P14 4.2 提交 |
| 全局扩展行的写入路径未接入（P14 1.5） | `rls-policies.sql` 只允许平台范围写 `site_id IS NULL` 的扩展，而应用代码不设置该变量：部署策略后由站点上下文安装或更新全局扩展会被 RLS 拒绝 | 产品缺陷：`routes/marketplace.ts` 与 `official-extension-reconciler.ts` 改为在平台范围写入；`global-extensions-scope.db.integration.test.ts` 覆盖"平台范围可写、站点范围改不到全局行且不能新建全局行" | P14 1.5 提交 |
| RLS 策略未进入迁移，开发环境中间件跳过 RLS（P14 1.7） | 策略只存在于手工文件，默认部署没有行级隔离；`HEOPRESS_ENV=development` 时中间件也不设置 `app.site_id` | 产品缺陷：`0125_p14_rls_policies` 由 `src/rls/registry.ts` 生成并随迁移安装（`ENABLE`、不 `FORCE`），`withRls` 在开发环境同样设置站点范围，`app-role --check` 逐表核对策略、无范围读取报错、无 CREATE 且不拥有对象；`rls-catalog.db.test.ts` 与 `rls.db.test.ts` 覆盖 | P14 1.7 提交 |
| 应用角色可在 `public`、`pgboss` 建对象（P14 2.1–2.2） | 可写 schema 让应用角色能放置同名函数或操作符重载，所有者执行未限定调用时可能解析到它；运行时自建的向量表与 `mat_*` 表归应用角色所有 | 产品缺陷：`ensureAppRole` 只授予 USAGE 并 `REVOKE CREATE ON SCHEMA public, pgboss`；运行时改为调用属主的 SECURITY DEFINER 入口（`heopress_ensure_vector_space`、`heopress_materialize_create\|truncate\|drop`）；存量向量表与 `mat_*` 表移交属主并启用 RLS，其他自有对象列出后以非零码退出。`app-role.db.test.ts`、`vector-store.db.test.ts`、`materialize-app-role.db.integration.test.ts` 覆盖 | P14 2.1–2.2 提交 |

## 记录

| 日期 | 环境 | 结果 |
|---|---|---|
| 2026-10-15 | Node 24.21.0、PostgreSQL 18.6（`postgres:18-alpine`）、Redis 7 | 迁移全部成功；单元测试 4178 通过 / 213 跳过（需数据库的套件在无 `DATABASE_URL` 时自动跳过）；golden-path 与 upgrade-path E2E 通过；数据库集成测试 53 个文件 509 个测试通过 |
| 2026-10-15 | 同上，CI `db-suites` 等价运行（整套，`HEOPRESS_ENV=development`） | 数据库包 6 个文件 20 个测试通过；CMS 387 个文件 3393 通过 / 1 跳过；无数据库时 vitest 共 4226 通过 / 221 跳过；CI run 38721876538 全绿 |

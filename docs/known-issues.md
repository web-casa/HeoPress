# 已知问题与预期失败

本文件列出 CI 中被标记为"预期失败"的测试及其原因。规则（P01 任务 3.3）：上游既有失败必须逐个修复；
确实无法在当前 phase 修复的才标记为 CI 中可见的预期失败，并在此登记复现方式、影响与计划修复的 phase。不得整体跳过测试。

## 当前预期失败

无。

## 已知缺陷（未修复）

不是测试失败，而是已确认、已排期的产品缺陷（ADR-0017）。

| 缺陷 | 影响 | 复现方式 | 计划 |
|---|---|---|---|
| 审计日志分页（`modules/audit/routes.ts` 的 `keysetAfter`）与 Change Feed 同样以毫秒游标比较微秒精度的时间戳 | 疑似：分页边界上同一毫秒内的其余行可能被跳过；**尚未复现** | 在同一毫秒内写入多条审计记录后按页读取 | P04 先写复现测试，确认后修复 |
| RLS 策略未进入迁移，开发环境中间件跳过 RLS | `migrations/rls-policies.sql` 需手工执行；`withRls` 在 `HEOPRESS_ENV=development` 时不设置 `app.site_id`，应用自身目前依赖应用层站点条件 | 迁移后查询 `pg_policies` 为空 | 由后续 phase 决定是否把策略纳入迁移（需同时让所有请求路径设置 `app.site_id`） |
| 应用角色可在 `public`、`pgboss` 建对象 | 运行时自建向量空间表与队列分区表，所以应用角色有这两个 schema 的 CREATE；这些表归应用角色所有。可写 schema 带来 search_path 信任边界：所有者（迁移、维护）以 `public` 在 search_path 中执行时，可能解析到应用角色创建的同名函数或操作符重载；所有者写入应用角色自有表时，表上的触发器会以所有者权限执行 | 应用角色 `CREATE FUNCTION public.…` 后，所有者执行未加 schema 限定的调用 | 后续把运行时自建对象移到专用 schema（应用角色只在该 schema 有 CREATE），维护脚本固定 `search_path`；在此之前，维护应用角色自有表时先 `SET ROLE` 到应用角色 |
| 不同站点的内容设置锁没有全局顺序 | 一个站点的写入先锁本站点设置（部分为排他锁），刷新翻译组时再共享锁其他成员站点的设置；两个站点的写入同时进行时可能互相等待对方的设置行（死锁） | 两个跨站翻译组的成员站点同时修改内容设置 / 写入组内条目 | 由 PostgreSQL 检测死锁，牺牲方在最外层事务边界重试（P07 起覆盖每个根站点事务，最多 3 次）；彻底消除需先收集全部涉及站点再一次性按顺序加锁（P07 设计第 26 版） |
| 全局扩展行的写入路径未接入 | `rls-policies.sql` 只允许平台范围（`app.platform_scope = 'on'` 且无站点）写 `site_id IS NULL` 的扩展；应用代码目前不设置该变量 | 部署策略后由站点上下文安装全局扩展会被 RLS 拒绝 | 与"RLS 策略纳入迁移"一起处理：平台管理路径设置 `app.platform_scope` |

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

## 记录

| 日期 | 环境 | 结果 |
|---|---|---|
| 2026-10-15 | Node 24.21.0、PostgreSQL 18.6（`postgres:18-alpine`）、Redis 7 | 迁移全部成功；单元测试 4178 通过 / 213 跳过（需数据库的套件在无 `DATABASE_URL` 时自动跳过）；golden-path 与 upgrade-path E2E 通过；数据库集成测试 53 个文件 509 个测试通过 |
| 2026-10-15 | 同上，CI `db-suites` 等价运行（整套，`HEOPRESS_ENV=development`） | 数据库包 6 个文件 20 个测试通过；CMS 387 个文件 3393 通过 / 1 跳过；无数据库时 vitest 共 4226 通过 / 221 跳过；CI run 38721876538 全绿 |

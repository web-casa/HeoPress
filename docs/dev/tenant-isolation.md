# 站点隔离：新增站点表、范围来源与例外

P14（ADR-0023、ADR-0024）之后，站点隔离有两层，缺一不可：

1. **数据库行级安全**：每张有 `site_id` 的表要么在 `packages/database/src/rls/registry.ts` 登记策略，要么登记为有原因的例外；
   策略随迁移安装（当前 `0125_p14_rls_policies`，由 `rlsPolicySql()` 从清单生成）。
2. **应用范围**：每次读写在某个站点（或平台）范围内执行。没有范围时，`app_site_id()` 抛 `heopress: no site scope`（SQLSTATE 42501），
   而不是返回空集；应用角色没有任何 schema 的 `CREATE`，也不拥有对象。

两层是互补的：应用层的站点条件仍是主要防线，行级安全是绕过应用层时的最后一道。

## 策略种类（`RlsEntry.policy`）

| 值 | 含义 | 典型表 |
|---|---|---|
| `site` | 只在 `site_id = app_site_id()` 时可见、可写 | 内容、字段、条目、设置 |
| `site-or-instance` | 站点行同 `site`；实例行（`site_id IS NULL`）任何范围可插入、只在平台范围读改 | 审计日志 |
| `site-or-global-read` | 站点行同 `site`；全局行（`site_id IS NULL`）任何范围可读、只在平台范围写 | 扩展 |
| `translation-group` | 本站点或跨站翻译组成员站点可见、可写 | 翻译组 |
| `agent-access` | 只在设置了 `app.agent_access = 'on'` 的事务中可见 | 外部 Agent 的访问 |
| `system-events` | 任何人可插入；`app.platform_reader` / `app.retention` 可读，`app.retention` 可删 | 系统事件 |
| `exempt` | 不启用行级安全，必须写明四类原因之一 | 域名解析、跨站调度队列、渲染缓存、实例簿记 |

策略 SQL 的生成规则在 `packages/database/src/rls/policies.ts`；全局读策略用不抛错的 `app_site_id_or_null()`，因为策略里的 `CASE`
可能被规划器折叠成参数，全局行不能依赖严格函数被惰性求值。

## 范围来源（`apps/cms/src/__tests__/helpers/db-access-inventory.ts`）

每个打开连接或启动后台工作的入口都要在清单里登记它的范围来源：

| 来源 | 做法 |
|---|---|
| `request-site` | 请求经 `withDb` / `withTenant` 得到已设 `app.site_id` 的句柄 |
| `request-platform` | 实例级请求显式进入平台范围（`withPlatformScope`） |
| `task-site` | 队列任务、消费者、定时任务从任务数据取站点，在 `scopedDatabase` 中执行 |
| `per-site-iteration` | 跨站 pass 从 `lumibase_sites` 列出站点，逐站执行；只用 id、时间、租约等元数据 |
| `agent-access` | Agent/MCP 路径按调用者可代表的站点设 `app.agent_access` |
| `platform-reader` | 只读例外表（无 `site_id`）或平台范围 |
| `owner-maintenance` | 以所有者运行（迁移、备份、升级）；行级安全不约束所有者 |

`db-access-inventory.wiring.test.ts` 扫描连接、`cron.schedule`、worker 注册、路由挂载与 `scripts/*-cli.ts`：出现未登记入口或登记已消失都会失败。
新增后台入口时先登记，再写代码。

## 新增一张有 `site_id` 的表

1. 在 `packages/database/src/schema/` 定义表（`site_id` 外键到 `lumibase_sites`），生成迁移（`pnpm db:generate`）。
2. 在同一个 change 里把它加入 `rls/registry.ts`（`site(...)`；确属例外则 `exempt(...)` 并写原因）。
3. 生成策略迁移（新迁移，不要改已发布的迁移）：

   ```bash
   cd packages/database
   DATABASE_URL=<owner> pnpm exec drizzle-kit generate --custom --name p14_<what>_policies
   DATABASE_URL=<owner> pnpm exec tsx -e "import {rlsPolicySql} from './src/rls/policies'; import {writeFileSync} from 'node:fs'; writeFileSync('drizzle/<生成的编号>_p14_<what>_policies.sql', rlsPolicySql(undefined, {breakpoints: true}))"
   ```

4. 写该表的服务/路由时只用 `withDb`/`scopedDatabase` 的句柄；测试用 `connectDbFixtures()`（所有者）准备数据，用应用角色执行被测代码。
5. 验证：`pnpm --filter @heopress/database exec vitest --run`（含 `rls-registry`、`rls-catalog`、`rls`），
   `DATABASE_URL=<应用角色> pnpm --filter @heopress/database app-role --check`。

`rls-registry.test.ts` 扫描 schema 源码，发现"有 `site_id` 却既没策略也没例外"的表即失败；`rls-catalog.db.test.ts` 反向核对已迁移的库：
每张登记表的策略名与命令、`ENABLE` 且不 `FORCE`，以及运行时创建的表（向量空间、物化表）带站点策略。

## 例外

只有四类原因：`pre-site-lookup`（解析域名时还不知道站点）、`cross-site-schedule`（跨站调度队列，只含 id/时间/租约/计数）、
`render-cache`（公开页面的渲染缓存，只含公开页）、`instance`（部署自身的簿记）。新增例外要在 registry 里写明类别与一句话说明，
并在 review 中说明为什么应用层范围不足以覆盖。

## 运行时创建的表

应用角色不能 `CREATE`。向量空间表与物化表由属主的 `SECURITY DEFINER` 入口创建（`heopress_ensure_vector_space`、
`heopress_materialize_create|truncate|drop`）：固定 `search_path`、校验参数、建表时 `ENABLE ROW LEVEL SECURITY` 并建站点策略，
`EXECUTE` 只授给应用角色。新增这类动态表时照此增加入口，不要在运行时执行 DDL。

## 验证与应急开关

- `app-role --check`（容器启动时执行）核对：角色不绕过 RLS、探针只看到一行、策略与清单逐表一致、无范围读取报错、任何 schema 都没有
  `CREATE` 且不拥有对象。任一项不满足，`cms` 拒绝启动（`HEOPRESS_REQUIRE_APP_ROLE=true`）。
- 应急开关（只在站点因缺少范围无法服务时使用）：`DATABASE_URL=<所有者> pnpm --filter @heopress/database rls -- --disable`，
  恢复用 `--enable`。关闭期间数据库不再按站点隔离写入，应保持单站点或维护模式，并在修复后立即恢复。
- 反向验收：临时在 `policies.ts` 删掉一条策略或让 `app_site_id()` 返回空串，`rls-catalog.db.test.ts` / `rls.db.test.ts` /
  `app-role --check` 必须失败；撤回后恢复。

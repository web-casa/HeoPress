# 数据保留

HeoPress 保存哪些数据、保存多久、由哪个任务清理，以及个人数据删除后如何保证不会因为恢复备份而重新出现（ADR-0013，
spec `ops/data-retention`）。这里的期限是工程默认值，不构成法律意见；面向欧盟用户的运营者应自行做合规评估。

代码位置：`apps/cms/src/services/retention/`（`policy.ts` 保留期限、`snapshot-retention.ts` 抓取快照与争议保留、
`run-record-retention.ts` AI 运行记录、`backup-pruner.ts` 备份保留接口、`deletion-ledger.ts` 删除账本、
`retention-job.ts` 每日任务）；表定义在 `packages/database/src/schema/retention.ts`。

## 保留期限

所有期限都是实例级配置，从环境变量读取；未设置或取值无效时使用默认值（无效值在启动时记一条警告）。

| 数据 | 默认 | 环境变量 | 清理任务 |
|---|---|---|---|
| 原始抓取快照（HTML） | 90 天 | `HEOPRESS_RETENTION_SNAPSHOT_DAYS`（1–3650） | `data-retention`，每天 03:47 |
| AI 运行记录中的完整输出 | 90 天 | `HEOPRESS_RETENTION_AI_RUN_BODY_DAYS`（1–3650） | `data-retention` |
| 访问明细（AI 爬虫访问与 AI 引荐，含 IP 哈希） | 7 天，按天汇总保留 | `HEOPRESS_RETENTION_ACCESS_DETAIL_DAYS`（1–90） | `crawl-hits-purge`，每小时 |
| 已被全部消费者确认的变更事件 | 30 天 | `HEOPRESS_RETENTION_CHANGE_EVENT_DAYS`（1–90） | 变更事件维护（与分发循环一起运行） |
| 备份 | 每日 14 份、每周 8 份 | `HEOPRESS_RETENTION_BACKUP_DAILY`、`HEOPRESS_RETENTION_BACKUP_WEEKLY` | `data-retention`（由备份模块注册的清理器执行） |

站点管理员可用 `GET /api/v1/retention` 查看实例当前生效的期限（`policy` 字段）。
变更事件：站点自己在 `cdc_feed.retentionDays` 设置的天数优先，没有设置时用实例期限。

其他已有的保留规则（站点审计、实例事件、活动日志、通知）见英文文档 [Data retention](../../en/operations/data-retention.md)。
访问统计的原始事件（`lumibase_pageview_events`）在汇总后即删除。

## 原始抓取快照

`data-retention` 每天检查最后一次写入早于保留期限的快照。以下引用会**阻止清理**，快照保留到下一次运行再检查：

- **待审核内容**：由该快照的来源文档派生（`lumibase_content_provenance`）的条目尚未发布，或该条目仍有处于 `review`、`veto_window`、`queued` 的自动发布候选；
- **未结争议**：该快照有未解除的保留标记（见下），或派生条目有未处理的授权复核；
- **进行中任务**：来源文档的加工任务尚未交给队列，或引用该来源文档的 AI 生产仍是 `running` / `retry_scheduled`。

没有阻止清理的引用时（包括只被已发布内容的来源记录引用），快照内容被删除，记录保留为**墓碑**：
哈希、删除时间与原因（`retention_expired`）；来源文档保留抽取规则版本。管理员下载快照
（`GET /api/v1/ingest/documents/:id/snapshot`）此时返回 `410`，`meta.tombstone` 给出哈希、规则版本、删除时间与原因。
之后再次抓取到完全相同的内容时，快照会重新保存并去掉墓碑。

### 争议保留

对快照存在投诉、版权争议等未结事项时，站点管理员可以给它加保留标记，争议结束后解除：

- `GET /api/v1/retention/holds?state=open|all` 列出；
- `POST /api/v1/retention/holds`，请求体 `{ "snapshotId": "…", "reason": "…" }`（原因不写个人数据）；
- `POST /api/v1/retention/holds/:id/release` 解除，快照在下一次运行时重新进入清理。

## AI 运行记录

每次模型调用都记在调用账本（`lumibase_llm_calls`）中，已完成调用的 `result` 保存完整输出；提示词本身不保存（只保存摘要）。
超过期限后，`result` 被替换为只含提供方、模型与 token 用量的标记；费用（`lumibase_llm_attempts`）、门禁结论与生产步骤记录
（步骤、模型、提示词与编辑策略版本、token、费用、结果）不受影响，仍可查询。进行中的调用不处理；
对已清理调用的重放会被拒绝（`CALL_RESULT_EXPIRED`）。Studio 中的 AI 对话属于用户内容，不在此范围。

## 备份

保留策略由本模块决定，备份目录与删除由备份模块负责。备份模块在启动时用 `registerBackupPruner` 注册一个清理器，
`data-retention` 每天以 `{ daily, weekly }` 调用它；没有注册清理器时不清理任何备份，任务日志会注明。

清理器可使用 `planBackupRetention` 选择要保留的备份：保留最近 `daily` 个日期（UTC）各自最新的成功备份、
最近 `weekly` 个 ISO 周各自最新的成功备份、最近一次成功备份、所有进行中的备份，以及这些备份依赖的完整基础链（全量与之前的增量）；
其余（包括失败的备份）可以删除。

## 个人数据删除请求

删除请求走 `POST /api/v1/admin/erasure` → `/:id/confirm` → `/:id/execute`（可选双人确认）。除按集合与过滤条件删除条目外，
请求范围也可以是含有个人数据的原始抓取快照：`{ "scope": { "ingestSnapshots": ["<快照 ID>", …] } }`。

个人数据删除**优先于所有保留引用**：即使快照仍被待审核内容、争议或进行中任务引用，内容也会被删除（墓碑原因
`personal_data_erasure`），引用它的来源文档的抽取正文被清空；仍在等待审核的派生条目标记"来源缺失"
（`lumibase_content_provenance.source_missing_at`）、置为暂停发布（hold），其自动发布候选退回人工复核（原因 `source_missing`），
站点管理员收到通知。之后再次抓取到相同内容时，被删除的快照内容不会重新保存。

## 删除账本

删除请求执行时，每个被删除的对象都写入删除账本，只记录标识与时间（站点、请求、对象类型、集合名、对象 ID、动作、删除时间），不记录内容：

1. **外部账本**：在删除之前写入，位于数据库之外。设置 `HEOPRESS_DELETION_LEDGER_DIR` 时写入该目录（每月一个 NDJSON 文件，追加并落盘）；
   未设置时写入对象存储的 `ops/deletion-ledger/` 前缀（不在任何站点的媒体前缀下）。
2. **账本表** `lumibase_deletion_ledger`：每个对象删除后写入。该表不随站点删除而删除。

外部账本必须放在恢复操作不会回滚的位置：使用独立卷挂载 `HEOPRESS_DELETION_LEDGER_DIR`，或确保恢复只恢复数据库而不覆盖
`ops/deletion-ledger/`；并像加密密钥一样单独备份。

### 恢复后重放

从备份恢复后、开放写入之前，恢复流程必须调用 `replayDeletionLedger`（`apps/cms/src/services/retention/deletion-ledger.ts`）：

```ts
const report = await replayDeletionLedger({ db, storage, sink: deletionLedgerSinkFromEnv(process.env, storage) });
if (report.failed > 0) { /* 保持维护模式，不开放写入 */ }
```

它读取外部账本与各站点账本表的并集，按删除时间依次处理：已恢复回来的条目再次删除（或再次加密粉碎），
快照再次删除内容并写回墓碑，账本表中缺少的记录补回。返回的恢复报告列出每条重放记录及结果
（`deleted_again`、`already_absent`、`failed`）以及补回的行数；`failed` 大于 0 时恢复流程必须保持写入关闭。重复执行是安全的。

## Git 历史

Git 快照不导出个人数据，删除个人数据通常不需要改写 Git 历史。确需改写时按 [Git 历史改写](../../ops/history-rewrite.md)
的人工流程，由实例所有者批准后执行；系统不会自动改写 Git 历史。

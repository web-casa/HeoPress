# ops/ingest-processing-outbox Specification

## Purpose
把来源文档的加工 outbox（`lumibase_ingest_processing_jobs`）接到站点自己的加工 Flow 上：抓取成功后文档自动进入加工，
行状态可追踪，没有配置 Flow 的站点不被凭空加工。

## Requirements

### Requirement: 待加工文档自动交给站点的加工 Flow
调度器 SHALL 每分钟找出 `kind = 'process'` 且 `status = 'pending'` 的 outbox 行，在行所属站点的范围内认领，
并为每一行向该站点所有以 `pipeline:fetch-source` 为第一步的启用 Flow 各入队一个 `flow:event` 任务，
任务输入 SHALL 包含该行的来源文档 ID。入队成功后该行 SHALL 变为 `enqueued` 并记录 `enqueued_at`。

#### Scenario: 有加工 Flow 的站点
- **WHEN** 一个站点有启用中的、以 `pipeline:fetch-source` 为第一步的 Flow，且有一条 `pending` 的 `process` 行
- **THEN** 调度器入队一个 `flow:event` 任务，其 `input.sourceDocumentIds` 是该行的文档 ID，行变为 `enqueued`

#### Scenario: 同一行不会被重复派发
- **WHEN** 调度器连续运行两次
- **THEN** 第二次不再为该行入队（它已是 `enqueued`）

### Requirement: 没有加工 Flow 时保持待处理
站点没有以 `pipeline:fetch-source` 为第一步的启用 Flow 时，调度器 SHALL NOT 入队任何任务，也 SHALL NOT 改变行状态。

#### Scenario: 未配置 Flow
- **WHEN** 站点只有其他 Flow（例如事件触发但第一步不是 `pipeline:fetch-source`）或没有 Flow
- **THEN** `pending` 行保持 `pending`，队列中没有任务

### Requirement: 线索不进入加工
`kind = 'lead'` 的行（仅发现用途的信源）SHALL NOT 被调度器派发，保持 `pending` 供运营者作为研究线索使用。

#### Scenario: 线索行
- **WHEN** outbox 中有一行 `kind = 'lead'`
- **THEN** 调度器不为其入队任务，行保持 `pending`

### Requirement: 站点范围
调度器对每张表的读写 SHALL 在行所属站点的范围内进行；跨站的行、Flow 与任务互不影响。

#### Scenario: 两个站点各有待处理行
- **WHEN** 站点 A 与站点 B 各有一条 `pending` 行，且各自有加工 Flow
- **THEN** 两行各自入队到自己的站点，任务数据中的 `siteId` 与行一致

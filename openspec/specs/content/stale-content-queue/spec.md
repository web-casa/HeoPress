# content/stale-content-queue Specification

## Purpose
给"待更新"再加一个来源：系统按站点发现长期没更新的已发布条目，自动打上可解释的标记，并在条目被编辑后收回；
把这些自动标记、运营者的手工标记和等待复核的条目汇成一个站点级复核队列，在 API 与 Studio 里都能一次看完。

## Requirements

### Requirement: 自动过期标记
系统 SHALL 按站点扫描条目，并 SHALL 只对"已发布、未删除、当前没有标记、`updated_at` 早于阈值、且没有未来发布排期"
的条目写入自动标记（`needs_update_since` 为扫描时刻、`needs_update_reason` 为 `auto:stale`、
`needs_update_source` 为 `auto`，`needs_update_due_at` 为空）。
已有手工标记的条目 MUST NOT 被自动标记覆盖或改期；草稿、未来排期与已删除条目 MUST NOT 被标记。
阈值 SHALL 可配置，默认 365 天。扫描 MUST 幂等：没有变化的第二次运行 MUST NOT 写入任何行。

#### Scenario: 标记长期未更新的已发布条目
- **WHEN** 某站点有一个 400 天前更新、已发布、无标记的条目，阈值取默认 365 天，扫描运行一次
- **THEN** 该条目获得 `auto` 标记，`needsUpdateSince` 为扫描时刻，`needsUpdateReason` 为 `auto:stale`，`dueAt` 为空

#### Scenario: 草稿、未来排期与已删除条目不动
- **WHEN** 同一次扫描面对一年前的草稿、`publish_at` 在未来的已发布条目、以及已删除的条目
- **THEN** 三者都没有标记

#### Scenario: 手工标记不被覆盖
- **WHEN** 一个 400 天前更新、已被运营者手工标记（含原因与截止时间）的条目经过一次扫描
- **THEN** 标记的 `source` 仍为 `manual`，标记时间、原因与截止时间都不变

#### Scenario: 第二次运行不写入
- **WHEN** 扫描刚标记了一个条目，且没有任何条目被编辑，扫描再运行一次
- **THEN** 本次没有标记得以写入或清除，也不产生 Change Feed 事件

### Requirement: 自动标记的解除
系统 SHALL 在条目被更新（`updated_at` 晚于标记时间）后清除它的自动标记，三个标记列连同来源一起置空。
手工标记 MUST NOT 被清除，即使条目在标记后被编辑。

#### Scenario: 编辑解决标记
- **WHEN** 一个带 `auto` 标记的条目在标记之后被内容更新，随后扫描运行
- **THEN** 标记被清除，`needsUpdateSince`、`needsUpdateReason`、`needsUpdateDueAt` 与 `needsUpdateSource` 都为空

#### Scenario: 尚未编辑的自动标记保留
- **WHEN** 一个带 `auto` 标记的条目在标记之后没有被编辑
- **THEN** 扫描不改变它的标记

#### Scenario: 手工标记不会自动解除
- **WHEN** 一个带 `manual` 标记的条目在标记之后被编辑
- **THEN** 扫描不清除它，原因与截止时间保持原样

### Requirement: 变更信号与派生状态
每次自动标记真正写入或清除时，系统 SHALL 在同一事务里写一条既有的 Change Feed 事件（变更字段为 `['needs_update']`，
来源为 `system`）。自动标记 MUST NOT 逐行写审计事件，也 MUST NOT 改变条目的 `version` 或 `updated_at`：
它是派生状态，不是一次编辑或人的动作。

#### Scenario: 变化留下变更事件、不留审计
- **WHEN** 扫描标记一个条目并清除另一个条目的自动标记
- **THEN** Change Feed 中两个条目各有一条 `['needs_update']` 事件，审计中没有对应的 `item_timeliness_*` 记录

#### Scenario: 标记不是编辑
- **WHEN** 扫描标记一个条目
- **THEN** 该条目的 `version` 与 `updated_at` 与扫描前相同

### Requirement: 定时任务与站点范围
自动扫描 SHALL 作为定时任务每小时运行一次，并 MUST 在 `apps/cms/src/__tests__/helpers/db-access-inventory.ts`
登记为按站点迭代。每个站点的工作 MUST 在该站点的行级安全范围内执行；站点之间 MUST NOT 互相看到或改写标记。

#### Scenario: 每个站点各自成范围
- **WHEN** 站点 A 与站点 B 各有一个过期条目，扫描运行一次
- **THEN** 两个条目各自被标记，且标记分别写在自己站点的行上

### Requirement: 复核队列 API
系统 SHALL 提供 `GET /api/v1/review-queue?collection=&limit=`（站点范围、已认证），一次返回三组需要人处理的条目：
手工标记（`source = manual`）、自动标记（`source = auto`）、等待复核（`editorial_state = 'in_review'`），
每组带计数。每一行 MUST 包含条目 id、集合名、标题、原因、截止时间与更新时间，并 MUST 只出现在一组里（标记优先）。
未知集合名 MUST 返回 404；调用者无权读取的集合 MUST NOT 出现在结果中。`limit` 默认 50、最大 200，
超出时 MUST 收敛到 200，非整数或小于 1 MUST 返回 400。响应 MUST 带 `truncated`；计数只覆盖本页。

#### Scenario: 三组与计数
- **WHEN** 站点有一个手工标记、一个自动标记、一个 `in_review` 条目，调用 `GET /api/v1/review-queue`
- **THEN** 返回 200，三组计数各为 1，每行带条目 id、集合、标题、原因、截止时间与更新时间，且 `truncated` 为 false

#### Scenario: 分页与截断
- **WHEN** 有 3 个待处理条目，调用 `GET /api/v1/review-queue?limit=1`
- **THEN** 只返回 1 行，`truncated` 为 true，计数之和为 1

#### Scenario: 集合过滤与未知集合
- **WHEN** 调用 `?collection=articles`，再调用 `?collection=nope`
- **THEN** 前者只返回该集合的条目；后者返回 404

#### Scenario: 站点与权限
- **WHEN** 站点 B 的调用者请求队列，或只有 `read` 权限的调用者请求本站点队列
- **THEN** B 的调用者只看到 B 的条目；只读者能看到本站点队列；没有会话的请求返回 401

### Requirement: Studio 复核队列页
Studio SHALL 提供 `/content/review-queue` 页面（路由与导航入口），展示三组及其计数，每行 MUST 链到对应条目，
每组 MUST 有独立的空状态；存在更多结果时 SHALL 说明计数只覆盖显示的条目。
文案 MUST 同时存在于 `en` 与 `zh-CN`。

#### Scenario: 三组与计数可见
- **WHEN** 打开 `/content/review-queue`，接口返回三组各 1 条
- **THEN** 页面显示三组标题与各自的计数 1，以及每组的条目标题

#### Scenario: 每行链到条目
- **WHEN** 队列中有一行属于 `articles` 集合的条目 `item-1`
- **THEN** 该行标题链接到 `/content/articles/item-1`

#### Scenario: 分组空状态
- **WHEN** 某一组没有条目
- **THEN** 该组显示空状态文案，其他组不受影响

#### Scenario: 截断提示
- **WHEN** 接口返回 `truncated: true`
- **THEN** 页面提示还有更多条目、计数只覆盖显示的条目

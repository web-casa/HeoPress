# content/timeliness-marks Specification

## Purpose
让运营者把一个条目显式标记为"待更新"，带上简短的日期与原因，在列表与详情里都看得见，并且能解除——
标记经得起普通的内容更新，不会被一次保存悄悄抹掉。

## Requirements

### Requirement: 标记与解除标记
系统 SHALL 允许对未删除的条目设置"待更新"标记（标记时间、简短原因、可选截止时间），并 SHALL 允许解除该标记。
标记与解除 MUST 返回条目当前的标记；解除后三个字段均为空。标记 MUST NOT 改变条目的内容、状态或路由。
标记 SHALL 记录来源：手工标记接口 MUST 写入 `source = manual`，解除时 MUST 清空来源；自动扫描写入的来源
由 spec `content/stale-content-queue` 规定，手工接口 MUST NOT 写入或改写它不拥有的来源。
标记与解除 MUST 重置该条目的复核提醒水位（`needs_update_reminded_at`）：一次新的标记意味着新的截止时间，
新的截止时间必须重新获得提醒（spec `content/review-reminders`）。

#### Scenario: 标记一个条目
- **WHEN** 编辑对某条目 `PUT /api/v1/items/:collection/:id/timeliness`，body 为 `{ "reason": "价格已变", "dueAt": "2026-12-01T00:00:00Z" }`
- **THEN** 返回 200 与 `{ itemId, needsUpdateSince, reason, dueAt }`，`needsUpdateSince` 为当前时间，条目详情也带这三项，
  且存储的 `needs_update_source` 为 `manual`

#### Scenario: 不带截止时间
- **WHEN** 编辑只给 `{ "reason": "数据过期" }` 标记
- **THEN** 标记成功，`dueAt` 为空

#### Scenario: 解除标记
- **WHEN** 编辑对已标记的条目 `DELETE /api/v1/items/:collection/:id/timeliness`
- **THEN** 返回 200，`needsUpdateSince`、`reason`、`dueAt` 均为空，`needsUpdateSource` 也为空，条目其余字段不变

#### Scenario: 重新标记重置提醒水位
- **WHEN** 一个已经收到过复核提醒的条目被重新标记（带新的 `dueAt`）
- **THEN** 存储的 `needs_update_reminded_at` 为空，下一次到期时该条目会再次产生提醒

#### Scenario: 缺少原因
- **WHEN** 标记请求没有 `reason`，或 `reason` 只有空白
- **THEN** 返回 400，标记不变

### Requirement: 标记经受普通更新
普通内容修改 MUST NOT 清除已有标记；条目的内容更新、状态变更与发布 SHALL 保留标记的时间、原因与截止时间。

#### Scenario: 更新内容后标记仍在
- **WHEN** 一个已标记的条目被 `PATCH` 修改了 `data`，或状态从草稿改为归档
- **THEN** 条目仍带原来的 `needsUpdateSince`、`reason` 与 `dueAt`

#### Scenario: 替换内容后标记仍在
- **WHEN** 一个已标记的条目被 `PUT` 整体替换了 `data`
- **THEN** 条目仍带原来的标记

### Requirement: 权限
标记与解除 MUST 需要该集合的 `update` 权限，并 MUST 做版本校验（`If-Match` 或 `expectedVersion`）；
缺少期望版本 MUST 返回 428，版本已移动 MUST 返回 409 且不写入。只有 `read` 权限的调用者 MUST 能看到标记，
但 MUST NOT 修改它。

#### Scenario: 读者只读
- **WHEN** 只有 `read` 权限的 API Key 请求标记或解除
- **THEN** 返回 403，标记不变；同一调用者读取条目详情时仍能看到标记

#### Scenario: 版本已移动
- **WHEN** 标记请求携带的 `expectedVersion` 小于条目当前版本
- **THEN** 返回 409（`VERSION_CONFLICT`），标记不变

#### Scenario: 缺少版本
- **WHEN** 标记请求既没有 `If-Match` 也没有 `expectedVersion`
- **THEN** 返回 428，标记不变

### Requirement: 列表可见与筛选
条目列表 SHALL 在每一行返回标记字段，并 SHALL 支持 `?needs_update=true` 只返回已标记的条目；
该筛选 MUST 与既有的分页、状态与过滤条件叠加生效。

#### Scenario: 只看待更新
- **WHEN** 集合中一条已标记、一条未标记，调用 `GET /api/v1/items/:collection?needs_update=true`
- **THEN** 只返回已标记的那条，且带其标记字段

#### Scenario: 默认不筛选
- **WHEN** 请求不带 `needs_update`
- **THEN** 已标记与未标记的条目都返回

### Requirement: 审计与变更事件
标记与解除 SHALL 写入审计记录，并 SHALL 在同一个事务里写入 Change Feed 事件（变更字段标示为标记）。

#### Scenario: 标记留下审计
- **WHEN** 编辑标记一个条目
- **THEN** 审计中出现 `item_timeliness_marked`，记录标记前后的值，Change Feed 事件包含该条目

#### Scenario: 解除留下审计
- **WHEN** 编辑解除标记
- **THEN** 审计中出现 `item_timeliness_cleared`，记录解除前的值与空的新值

### Requirement: Studio 可见性与操作
Studio 的条目详情 SHALL 显示标记徽章（原因与截止时间）并提供标记与解除操作；条目列表 SHALL 在已标记的行上显示徽章，
并 SHALL 提供"只看待更新"开关。文案 MUST 同时存在于 `en` 与 `zh-CN` 的 `items` 命名空间。

#### Scenario: 详情显示徽章与操作
- **WHEN** 打开一个已标记的条目详情
- **THEN** 页面显示原因与截止时间，以及"解除标记"按钮

#### Scenario: 从详情标记
- **WHEN** 编辑在未标记的条目上填写原因（可选截止时间）并提交
- **THEN** 调用标记接口，成功后详情显示徽章

#### Scenario: 列表徽章
- **WHEN** 条目列表包含已标记的条目
- **THEN** 该行显示"待更新"徽章，打开"只看待更新"后列表请求带上 `needs_update=true`

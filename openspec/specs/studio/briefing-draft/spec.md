# studio/briefing-draft Specification

## Purpose
让运营者把当前站点已经算好的概览简报一键变成一篇可编辑的草稿：接口负责拼摘要、走正常写入路径、
按集合权限与站点范围裁剪数据，并在同一天、同一集合、同一周期内保持幂等，不制造重复条目。

## Requirements

### Requirement: 生成简报草稿

系统 SHALL 提供 `POST /api/v1/studio/overview/briefing/draft`，接受可选字段 `collection`（默认 `articles`）
与 `period`（`day` 或 `week`，默认 `day`），并在当前站点、目标集合中创建一条草稿条目。标题 SHALL 包含
UTC 日期（日：`<YYYY-MM-DD> 站点简报`；周：`<YYYY-MM-DD> 站点周报`），正文 SHALL 是概览 feed 已经算出的
简报数据的纯 HTML 摘要：所选周期内发布的条目（计数与最多 3 个例子）、需要处理的事项（放置草稿与待审积压的
计数与最久一条）、最近 7 天的发布与修改计数。正文 MUST NOT 包含脚本、样式或站外链接；条目标题、正文与链接
SHALL 经过 HTML 转义。

创建的条目 SHALL 带机器可读的 `data.briefingDraftKey`（`<UTC 日期>:<period>`）与 `data.briefingDraftPeriod`。
请求体不合法时 SHALL 返回 400。

#### Scenario: 生成当天草稿

- **WHEN** 一个对 `articles` 有 `create` 权限的 Studio 会话请求 `POST /api/v1/studio/overview/briefing/draft`，
  当天发布了 2 篇稿件、有 1 篇放置超过 3 天的草稿
- **THEN** 接口返回 201 与 `created: true`，条目标题为当天的 `<YYYY-MM-DD> 站点简报`，正文包含今日发布 2 篇、
  两篇的标题与站内链接，以及放置草稿 1 篇

#### Scenario: 未知集合

- **WHEN** 请求的 `collection` 在当前站点不存在
- **THEN** 接口返回 404，不创建任何条目

#### Scenario: 缺少创建权限

- **WHEN** 调用者对目标集合没有 `create` 权限
- **THEN** 接口返回 403，不创建任何条目

### Requirement: 幂等

同一天、同一站点、同一集合、同一周期内，第二次调用 SHALL 返回第一次创建的条目，响应 SHALL 带
`created: false` 且状态码为 200，MUST NOT 创建重复条目。查找 SHALL 通过正常的条目读取路径
（调用者的 `read` 权限与行规则生效）按 `data.briefingDraftKey` 匹配；只有 `create` 而没有 `read` 的调用者
查不到已有草稿时 MAY 创建新条目，但 MUST NOT 读到它无权读取的草稿内容。

#### Scenario: 第二次调用

- **WHEN** 同一天、同一集合、同一周期内第二次调用该接口
- **THEN** 返回第一次创建的同一 `id`，`created: false`，集合中该 key 的条目仍只有一条

#### Scenario: 另一周期是另一篇

- **WHEN** 同一天先创建日草稿，再以 `period: 'week'` 调用
- **THEN** 创建另一条周草稿，不覆盖也不复用日草稿

### Requirement: 审计与正常写入路径

草稿 SHALL 通过正常的条目写入路径创建（`ItemService.create`），因此 SHALL 产生修订、活动记录与 Change Feed
（outbox）事件；MUST NOT 使用裸 INSERT。首次创建成功后系统 SHALL 按既有审计模式写一条
`studio_briefing_draft_created` 审计，记录调用者、集合、条目 id、周期与 key；第二次调用（返回已有条目）
MUST NOT 再写一条创建审计。

#### Scenario: 首创建有审计与变更事件

- **WHEN** 接口首次创建一条草稿
- **THEN** 审计日志中有一条 `studio_briefing_draft_created`，Change Feed 中该条目的 `create` 事件存在

#### Scenario: 复用不重复审计

- **WHEN** 同一天第二次调用返回已有草稿
- **THEN** `studio_briefing_draft_created` 审计仍只有一条，条目数量不变

### Requirement: 数据范围

摘要中的计数、标题与链接 SHALL 只来自调用者有权读取的条目（与概览 feed 的 `readableScope` 一致）；
调用者无权读取的集合或行 MUST NOT 出现在正文里，也 MUST NOT 被计入数量。

#### Scenario: 无权读取的条目不出现在正文

- **WHEN** 站点有一个调用者无权读取的集合，其中一篇稿件在当天发布
- **THEN** 草稿正文不出现该稿件的标题，也不把它计入今日发布数

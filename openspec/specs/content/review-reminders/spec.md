# content/review-reminders Specification

## Purpose
让"待更新"标记的复核截止时间真正到期生效：每天一次，把已经到期、尚未提醒（或已超过重复间隔）的条目汇总成一条摘要，
送到该站点里真正能解除标记的人面前；提醒一次即记录水位，被忽略时按间隔再次出现，既不每天刷屏，也不会被忘记。

## Requirements

### Requirement: 到期判定与重复间隔
系统 SHALL 只对满足以下全部条件的条目生成复核提醒：`needs_update_since` 非空、`needs_update_due_at` 非空且
不晚于当前时刻、`deleted_at` 为空、且 `needs_update_reminded_at` 为空或早于重复间隔的起点。
重复间隔 SHALL 可配置（`HEOPRESS_REVIEW_REMINDER_DAYS`），默认 7 天；非正整数或无法解析的值 MUST 回落到默认值。
已解除标记的条目、未到期的条目、已删除的条目 MUST NOT 产生提醒。
判定 MUST 按 `needs_update_due_at` 升序取每站点有上限的一批；没有到期条目时 MUST 是完全的空操作。

#### Scenario: 到期的条目产生提醒
- **WHEN** 某站点有一个带手工标记、`due_at` 为十分钟前、从未提醒过的条目，提醒任务运行一次
- **THEN** 该条目被视为到期，进入摘要，并写入 `needs_update_reminded_at`

#### Scenario: 未到期不提醒
- **WHEN** 条目的 `due_at` 在明天，其余条件相同
- **THEN** 本轮没有任何通知，条目的 `needs_update_reminded_at` 仍为空

#### Scenario: 解除标记后不提醒
- **WHEN** 一个到期条目在提醒运行前被解除标记（`needs_update_since` 与 `due_at` 均为空）
- **THEN** 本轮没有通知，条目也不会得到已提醒时间

#### Scenario: 超过重复间隔再次提醒
- **WHEN** 一个到期条目的 `needs_update_reminded_at` 是 8 天前（默认间隔 7 天），提醒任务运行
- **THEN** 本轮再次为该条目发出提醒，并把已提醒时间更新为当前时刻

#### Scenario: 同一天第二次运行不重复
- **WHEN** 提醒任务在同一个到期条目上刚运行过一次（已提醒时间为当前时刻），当天再运行一次
- **THEN** 本轮不写通知、不写条目，`needs_update_reminded_at` 不变

### Requirement: 收件人与摘要
系统 SHALL 以**站点成员**为收件人范围：主角色成员、附加角色成员与持有直接策略的成员（去重），
并且 SHALL 只把到期条目所属集合的 `update` 权限授予的成员作为收件人——这是解除标记所需的同一个动作，
站点管理员经管理员旁路自动满足；API Key、Agent 与不属于该站点的人 MUST NOT 成为收件人。
每个收件人每次运行 MUST 最多收到一条摘要通知，摘要 MUST 列出他有权处理的最多五个条目标题、
其余条目的数量，以及指向 Studio 复核队列 `/content/review-queue` 的链接；MUST NOT 为单条目各发一条通知。
摘要内容 MUST 只包含该收件人的行规则允许他处理的条目。没有收件人时 MUST NOT 写入任何通知。

#### Scenario: 摘要与五个标题上限
- **WHEN** 某站点有 7 个到期条目，一个具备 `update` 权限的成员
- **THEN** 该成员恰好收到 1 条通知，正文列出 5 个标题、其余 2 条的数量与 `/content/review-queue` 链接

#### Scenario: 读者不收提醒
- **WHEN** 站点里只有一个只有 `read` 权限的成员，某条目到期
- **THEN** 本轮没有任何通知

#### Scenario: 管理员经旁路收到提醒
- **WHEN** 站点里只有一个管理员（`admin_access`），某条目到期
- **THEN** 管理员收到一条摘要通知

#### Scenario: 只有能处理该条目的成员被计入
- **WHEN** 同一站点里成员 A 对到期条目所属集合有 `update`，成员 B 只有 `read`
- **THEN** A 收到摘要，B 不收到

### Requirement: 已提醒水位与重置
系统 SHALL 在发出摘要的同一个事务里把摘要覆盖到的条目的 `needs_update_reminded_at` 写为当前时刻，
写入 MUST 受与读取相同的判定条件守卫（已被解除、改期或已提醒的行 MUST NOT 被写入）。
标记（`PUT …/timeliness`）与解除（`DELETE …/timeliness`）、以及自动陈旧扫描写入或清除标记时，
系统 MUST 把 `needs_update_reminded_at` 置空，使新的截止时间重新获得提醒。
写入已提醒时间 MUST NOT 改变条目的 `version` 或 `updated_at`，MUST NOT 写审计事件，也 MUST NOT 写 Change Feed 事件。

#### Scenario: 重置后重新提醒
- **WHEN** 一个条目本轮被提醒过，随后被解除并重新标记（新的 `due_at` 已到期）
- **THEN** 下一轮提醒再次通知，并把水位更新为新的时刻

#### Scenario: 提醒不是编辑
- **WHEN** 一个条目因提醒被写入 `needs_update_reminded_at`
- **THEN** 它的 `version` 与 `updated_at` 与提醒前相同，审计中没有对应的记录，Change Feed 中没有新事件

### Requirement: 定时任务与站点范围
复核提醒 SHALL 作为定时任务每天运行一次 `review-reminders`（08:00，进程时区；部署镜像为 UTC）。
每个站点的工作 MUST 在该站点的行级安全范围内执行，站点之间 MUST NOT 互相看到或改写条目与通知。
任务 MUST 在 `apps/cms/src/__tests__/helpers/db-access-inventory.ts` 登记为按站点迭代，并在关停时停止。

#### Scenario: 站点各自成范围
- **WHEN** 站点 A 有一个到期条目、站点 B 有另一个到期条目，提醒任务运行一次
- **THEN** 两个站点的成员各收到自己站点的一条摘要，通知与水位分别写在自己站点的行上

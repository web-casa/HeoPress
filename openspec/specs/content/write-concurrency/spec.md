# content/write-concurrency Specification

## Purpose
保证多个用户与多个 Agent 同时修改内容时不会静默覆盖他人修改，并让"人工保留"在所有发布路径上生效。

## Requirements

### Requirement: 基于版本的条件更新
每条内容 SHALL 拥有版本号。更新请求 MUST 携带期望版本；版本与当前不一致时 SHALL 返回冲突，且不得写入任何字段。
缺少期望版本的更新请求 MUST 被拒绝。

#### Scenario: 并发修改
- **WHEN** 用户 A 与用户 B 读取同一篇文章的版本 12，A 先保存成功（版本变为 13），B 随后基于版本 12 保存
- **THEN** B 的请求返回 409，响应包含当前版本 13 与已变化的字段，文章内容保持 A 保存后的状态

#### Scenario: 缺少版本
- **WHEN** Agent 发起不带期望版本的更新
- **THEN** 返回 428，内容不变

### Requirement: Hold 阻止所有发布路径
被标记为 Hold 的内容 SHALL NOT 通过任何途径发布，包括手动发布、批量发布、定时发布、Releases、自动发布与分支合并。
Hold MUST 只能由具备发布权限的人类用户解除。

#### Scenario: 定时发布遇到 Hold
- **WHEN** 一篇已安排定时发布的草稿在发布时刻之前被标记为 Hold
- **THEN** 到达发布时刻时不发布，并记录"因 Hold 跳过"

#### Scenario: Agent 尝试解除 Hold
- **WHEN** 使用 API Key 或 Agent 身份解除 Hold
- **THEN** 返回 403，Hold 保持不变

### Requirement: 晚到的 AI 结果不覆盖人工修改
AI 任务的结果 SHALL 以任务开始时的版本为基准。如果写回时内容已被人类用户修改，结果 MUST NOT 写回，并标记为已被取代且记录审计。

#### Scenario: 质检期间人工编辑
- **WHEN** AI 质检任务运行期间编辑手动修改了文章，随后质检结果返回
- **THEN** 质检结果不写回文章，审计记录显示该结果已被取代

### Requirement: 批量操作逐条结果
批量操作 SHALL 对每一条目分别返回结果，状态取值为 succeeded、unchanged、blocked、conflict、failed 之一，并附原因代码。
单条失败 MUST NOT 回滚其他条目的成功结果。

#### Scenario: 混合结果
- **WHEN** 批量发布 5 篇文章，其中 1 篇已发布、1 篇被 Hold、1 篇版本冲突、1 篇校验失败
- **THEN** 响应依次给出 succeeded、unchanged、blocked、conflict、failed，成功的那篇已发布

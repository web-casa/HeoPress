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

### Requirement: 基于版本的条件删除
删除条目的请求 MUST 携带期望版本，规则与更新相同：版本与当前不一致时 SHALL 返回冲突（409，含当前版本），且不得删除；缺少期望版本的删除 MUST 被拒绝（428）。
该要求 SHALL 适用于每一条删除途径：API、GraphQL、批量操作（逐条返回 conflict）、外部 Agent 的工具与计划执行、SDK、插件，以及内置 Agent。
后台界面 SHALL 以它显示的版本发起删除，遇到冲突时提示内容已被他人修改，且不删除。
同一事务内由系统随父条目一起执行的级联删除，以该事务读到的版本为准，不对外开放无版本删除。

#### Scenario: 删除与编辑并发
- **WHEN** 用户 A 与用户 B 都读到某篇文章的版本 12，B 保存修改（版本变为 13）后，A 基于版本 12 删除它
- **THEN** A 的删除返回 409 并给出当前版本 13，文章保持 B 保存后的状态且未被删除

#### Scenario: 缺少版本的删除
- **WHEN** API 客户端或 Agent 不带期望版本删除条目
- **THEN** 返回 428，条目不变

#### Scenario: 计划执行时内容已变化
- **WHEN** 一个已批准的删除计划执行时，其中一篇条目的版本已不同于计划记录的版本
- **THEN** 该条目的结果为 conflict 且未被删除，计划中其他条目照常执行

#### Scenario: 插件删除已被发布的条目
- **WHEN** 只有写入能力的插件按它读到的草稿版本删除条目，而该条目在此期间已被他人发布
- **THEN** 删除以版本冲突失败，已发布的条目保持不变

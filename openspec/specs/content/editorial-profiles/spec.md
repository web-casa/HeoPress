# content/editorial-profiles Specification

## Purpose
为每个站点定义可版本化的编辑策略，规定受众、文风、术语、引用与质量规则，供 AI 流水线与外部 Agent 生产内容时遵循，使不同站点的内容有各自的定位与新增价值。

## Requirements

### Requirement: 编辑策略版本化
每个站点 SHALL 拥有一份编辑策略，包含受众、文风、术语表、引用策略、结构规则、质量规则、发布规则与禁止主题。
每次修改 SHALL 生成新版本，历史版本 MUST 可读取。

#### Scenario: 修改编辑策略
- **WHEN** 编辑修改站点的文风并保存
- **THEN** 生成新版本，上一版本仍可查看

### Requirement: 运行记录引用策略版本
任何使用编辑策略的 AI 运行 SHALL 记录所用的编辑策略版本号。

#### Scenario: 追溯文风来源
- **WHEN** 审核者查看一篇 AI 改写文章的运行记录
- **THEN** 能看到生成时使用的编辑策略版本号

### Requirement: 外部读取当前策略
有权限的调用者（含外部 Agent）SHALL 能读取站点当前生效的编辑策略；无该站点权限的调用者 MUST 被拒绝。

#### Scenario: 越权读取
- **WHEN** 只有站点 A 权限的用户或 API Key 读取站点 B 的编辑策略
- **THEN** 请求被拒绝（凭证不属于站点 B 时为 401，属于但无成员资格时为 403 或 404），响应不含站点 B 的策略内容

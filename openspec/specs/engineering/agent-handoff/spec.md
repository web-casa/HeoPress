# engineering/agent-handoff Specification

## Purpose
保证不同 AI 编程 Agent（Codex、Claude Code 等）与人类开发者之间交接时，进度、验证状态和约束可以从仓库内文件完整恢复。

## Requirements

### Requirement: 交接记录格式
仓库 SHALL 在 `docs/handoffs/` 保存交接记录。每条记录 MUST 包含：当前 change、分支、最后提交、已完成与未完成任务编号、
实际运行过的测试命令与结果、风险与约束、下一步、验证快照。文档检查 MUST 拒绝缺少任一章节的记录。

#### Scenario: 缺少测试结果章节
- **WHEN** 新增的交接记录没有"测试命令与结果"章节
- **THEN** 文档检查失败并指出缺失的章节名

#### Scenario: 完整记录
- **WHEN** 交接记录包含全部必需章节
- **THEN** 文档检查通过

### Requirement: 验证快照只读
交接记录中的验证快照 SHALL 只包含只读命令，并为每条命令写明期望结果。文档检查 MUST 拒绝包含白名单之外命令的快照。

#### Scenario: 快照包含写操作
- **WHEN** 验证快照中出现 `git push` 或 `rm` 等非白名单命令
- **THEN** 文档检查失败，并指出该命令

#### Scenario: 接手方复验
- **WHEN** 新会话执行最新交接记录的验证快照，且某条命令输出与期望不一致
- **THEN** Agent 先报告漂移，再继续任何开发任务

### Requirement: 规格校验门禁
持续集成 SHALL 在每个合并请求上运行 OpenSpec 严格校验，校验失败 MUST 阻止合并。

#### Scenario: 规格格式错误
- **WHEN** 合并请求引入缺少场景的 Requirement
- **THEN** CI 校验任务失败，合并被阻止

### Requirement: 统一 Agent 入口
仓库 SHALL 以 `AGENTS.md` 作为所有 Agent 的唯一规则入口；`CLAUDE.md` MUST 只导入 `AGENTS.md`，不包含其他规则。

#### Scenario: CLAUDE.md 含额外规则
- **WHEN** `CLAUDE.md` 除导入语句外还包含其他内容
- **THEN** 文档检查失败

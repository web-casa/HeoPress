# engineering/docs-integrity Specification

## Purpose
防止文档与代码脱节：保证中英文档成对维护，并保证文档中提到的文件、环境变量与 API 路由在代码中真实存在。

## Requirements

### Requirement: 文档引用的代码必须存在
持续集成 SHALL 检查现行用户与开发文档中明确标注的文件路径、环境变量与 API 路由引用，规划与历史示例 SHALL 被排除。引用不存在于代码库时，检查 MUST 失败并列出失效引用。

#### Scenario: 文档引用已删除的文件
- **WHEN** 文档引用了一个已被删除的源码文件路径
- **THEN** 文档检查失败，并输出该文档与失效路径

#### Scenario: 引用全部有效
- **WHEN** 文档中的所有代码引用都存在
- **THEN** 文档检查通过

### Requirement: 中英文档对齐
文档 SHALL 以 zh-CN 为默认语言、en 为第二语言。私有规划、交接、调研、review 与 ADR 不要求双语。检查工具 SHALL 对现行用户与开发文档报告缺少对应语言版本或源文档已更新而译文未更新的文档。

#### Scenario: 中文文档更新后英文未更新
- **WHEN** 中文文档内容变化而对应英文文档未变化
- **THEN** 对齐检查报告该英文文档为"过期"

# engineering/license-compliance Specification

## Purpose
从第一天起保证所有随产品分发的依赖都允许以 AGPL-3.0-only 开源并同时出售商业授权，避免后期替换依赖。

## Requirements

### Requirement: 依赖许可证白名单
持续集成 SHALL 检查所有随产品分发的依赖的许可证，只允许白名单中的宽松许可证（MIT、BSD、Apache-2.0、ISC、PostgreSQL、Zlib 等）。
出现 GPL、AGPL、SSPL、BSL 或无法识别许可证的依赖时，检查 MUST 失败并列出该依赖。以动态链接方式使用的 LGPL 原生库 SHALL 只能通过维护者确认的例外清单放行。

#### Scenario: 引入 GPL 依赖
- **WHEN** 合并请求新增一个 GPL-3.0 许可证的 npm 包
- **THEN** 依赖许可证检查失败，并列出该包名与许可证

#### Scenario: 例外清单中的 LGPL 原生库
- **WHEN** 依赖树中包含已列入例外清单、以动态链接方式使用的 LGPL 图片处理原生库
- **THEN** 检查通过，且该库出现在 NOTICE 的第三方说明中

#### Scenario: 无法识别许可证
- **WHEN** 新增依赖的许可证字段缺失
- **THEN** 检查失败，需要维护者人工确认后加入例外清单

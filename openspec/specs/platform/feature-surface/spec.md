# platform/feature-surface Specification

## Purpose
明确产品对外暴露的功能面：哪些功能被移除、哪些默认关闭、哪些保留可用，以及全新安装时的数据库基线。该规格由 P02 建立：移除 Cloudflare 运行时、SCIM、Web Push、Firebase 同步与 ClickHouse CDC 管道，六项可选功能默认关闭并可由管理员通过配置开启，Change Feed、GDPR、Insights、插件市场与轻后台保持可用，全新安装只执行一个生成的初始迁移。

## Requirements

### Requirement: 已移除功能不可访问
系统 SHALL NOT 提供 SCIM、Web Push、Firebase 同步、ClickHouse CDC 管道管理的任何端点。
对这些路径的请求 MUST 返回 404，且这些资源 MUST NOT 出现在 OpenAPI 文档、SDK 与后台菜单中。

#### Scenario: 请求 SCIM 端点
- **WHEN** 客户端请求 SCIM 用户列表路径
- **THEN** 返回 404

#### Scenario: OpenAPI 不含已移除资源
- **WHEN** 获取 OpenAPI 文档
- **THEN** 文档中不包含 SCIM、Push、CDC 管道、Firebase 相关路径

### Requirement: 默认关闭的功能
GraphQL、多 Agent 编辑部、内容目标与漂移检测、外部身份签发方、登录异常评分、Prometheus 指标 SHALL 在全新安装中默认关闭。
关闭时功能 MUST 不执行或不调度；存在对应端点时 MUST 返回 404，后台不显示入口；管理员 SHALL 能通过配置开启。

#### Scenario: GraphQL 默认关闭
- **WHEN** 在默认配置下请求 GraphQL 端点
- **THEN** 返回 404

#### Scenario: 管理员开启 GraphQL
- **WHEN** 管理员在配置中开启 GraphQL 并重启服务
- **THEN** GraphQL 查询按调用者权限返回数据，且查询深度与成本限制生效

### Requirement: 保留功能可用
Change Feed、GDPR 数据权利、Insights 仪表盘、插件市场 SHALL 在默认配置下可用。

#### Scenario: Change Feed 产生事件
- **WHEN** 有权限的用户创建一条内容
- **THEN** 订阅该站点的拉取消费者能读到对应的 `items.create` 事件

#### Scenario: GDPR 数据导出
- **WHEN** 管理员为某用户发起数据导出
- **THEN** 系统生成该用户数据的导出文件并记录审计日志

### Requirement: 全新安装的数据库基线
全新安装 SHALL 通过单一初始迁移创建完整数据库结构，且 MUST NOT 创建已移除功能的数据表。

#### Scenario: 全新安装
- **WHEN** 在空的 PostgreSQL 18 数据库上执行迁移
- **THEN** 迁移一次完成，数据库中不存在 SCIM、Firebase、Push、CDC 管道相关的表

### Requirement: 保留轻后台与插件开发契约
系统 SHALL 保留内容编辑、发布、权限、Insights、GDPR 与插件市场的统一轻后台，并保留插件 SDK、加载与签名验证的开发契约。删除演示市场应用 MUST NOT 删除实际插件市场与 SDK；后台 SHALL 沿用 MFA、恢复及登录限流。

#### Scenario: 裁剪后编辑并安装插件
- **WHEN** 授权编辑登录后台编辑草稿，管理员通过 SDK 构建并安装签名插件
- **THEN** 编辑与安装功能可用，演示应用被删除不影响真实市场或后台安全功能

# extensions/briefing-route Specification

## Purpose
定义官方日报插件如何把简报发布为公开页面：声明自己的集合与路由、为两个渲染引擎提供默认模板，
并让这些页面进入站点统一的收录、sitemap 与订阅源机制，而不新增扩展点或公开新的数据。

## Requirements

### Requirement: 官方插件声明自己的简报集合
随仓库发布的官方日报插件（`examples/plugin-briefing-daily/`，清单名 `heopress-briefing-daily`）
SHALL 声明一个 `briefings` 集合，安装后机器名为 `<namespace>__briefings`。
该集合 MUST 至少含 `title`、`slug`、`locale`、`excerpt`、`body`、`briefing_date`、`period` 字段；
`slug` 是条目路由所必需的。插件 MUST 只申请 `ext:collections`、`ext:routes`、`ext:briefing-sections`
与 `items:read:articles`，MUST NOT 申请写、发布、网络或密钥能力。
集合条目 MUST 走主线的写入、修订、Hold 与发布守卫，MUST NOT 由插件直接写库。

#### Scenario: 启用后安装集合
- **WHEN** 站点启用官方日报插件
- **THEN** 站点上出现 `heopress_briefing_daily__briefings` 集合，字段与清单一致，其他站点不受影响

#### Scenario: 插件不写内容
- **WHEN** 检查官方日报插件的能力清单
- **THEN** 其中没有 `items:write:*`、`items:publish:*`、`http:fetch:*` 或 `secrets:*`

### Requirement: 简报的列表与条目路由
官方插件 SHALL 声明两条公开路由：`/briefing`（列表，分页）与 `/briefing/:slug`（条目，集合的 permalink）。
两条路由 MUST 各有一个 Classic（Liquid）与一个 Astro 默认模板；模板 MUST 只读取页面数据契约，
MUST NOT 注入脚本、JSON-LD、canonical 或 robots，MUST NOT 引用插件之外的代码。
主题 SHALL 能用自己的 `ext/<namespace>/<template>` 覆盖任一默认模板。

#### Scenario: 两种引擎渲染同一份数据
- **WHEN** 同一站点分别由 Classic 渲染与 Astro 静态构建 `/briefing/` 与 `/briefing/<slug>/`
- **THEN** 两种引擎的状态码、标题、canonical 与列表条目一致

#### Scenario: 主题覆盖
- **WHEN** 主题为 `briefing` 模板提供了自己的版本
- **THEN** 条目页面使用主题模板，数据仍来自插件的集合

### Requirement: 简报页面的收录与发现
已发布的简报条目页面 SHALL 与普通条目页面使用同一个收录判定：可收录时进入 sitemap 与集合订阅源，
`noindex` 或未发布时 MUST NOT 进入。列表页 SHALL 按插件声明的 `pageSize` 分页，MUST 只列出该语言下
公开的条目。`/briefing` 与 `/briefing/:slug` MUST NOT 与系统路径、语言前缀、已有内容路径或重定向冲突；
冲突时启用 MUST 被拒绝并列出冲突路径。

#### Scenario: 已发布简报进入 sitemap 与订阅源
- **WHEN** 一个已发布、可收录的简报条目存在
- **THEN** `/sitemap-1.xml` 与 `/feed/briefings.xml` 都包含它的绝对地址

#### Scenario: 未发布或 noindex 的简报不出现
- **WHEN** 一个简报条目仍是草稿，另一个已发布但 `noindex`
- **THEN** 列表页与订阅源都不列出草稿，订阅源不列出 noindex 条目，sitemap 也不列出它

#### Scenario: 路由冲突
- **WHEN** 站点已有内容路径 `/briefing/`，插件仍声明 `/briefing/:slug`
- **THEN** 启用被拒绝，并列出冲突的路径

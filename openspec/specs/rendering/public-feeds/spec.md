# rendering/public-feeds Specification

## Purpose
定义公开站点的订阅源：站点订阅源读取哪个集合、哪些集合级地址存在、条目如何被收录资格与开关过滤，
以及为什么 CMS 应答与静态构建必须给出同一份文档。

## Requirements

### Requirement: 站点订阅源的集合可配置
站点 SHALL 有一个可配置的订阅源集合（`site-seo-settings` 的 `discovery.feedCollection`），默认 `articles`；
该值 MUST 是集合机器名（`[a-z][a-z0-9_]*`，允许插件命名空间形式）。
`/feed.xml` 与 `/atom.xml`（默认语言）以及按语言变体 SHALL 列出该集合的最新条目；改变设置后，
下一次应答 MUST 反映新集合，MUST NOT 继续返回旧集合的文档。
站点订阅源 MUST 只使用站点自己的公开条目，MUST NOT 读取其他站点的数据。

#### Scenario: 默认集合是文章
- **WHEN** 站点没有设置 `feedCollection`，请求 `/feed.xml`
- **THEN** 文档列出该站点最新的已发布文章，不列出来自其他集合的条目

#### Scenario: 站点把订阅源指向简报集合
- **WHEN** 站点把 `feedCollection` 设为插件集合的机器名，随后请求 `/feed.xml`
- **THEN** 文档列出该集合的已发布简报，不再列出文章

### Requirement: 集合级订阅源覆盖插件集合
除站点订阅源外，系统 SHALL 为 `pages` 以及每个已启用插件路由声明的集合提供集合级订阅源：
`/feed/<collection>.xml` 与 `/atom/<collection>.xml`，并 SHALL 提供按语言的 `<collection>.<locale>.xml` 变体。
插件集合的地址 SHALL 优先使用集合的本地名（`<namespace>__<collection>` 的 `<collection>` 部分）；
本地名在多个插件之间重名时 MUST 回退到机器名，且两个插件各自只暴露自己的集合。
站点订阅源已经使用的集合 MUST NOT 再有集合级地址：一个订阅源只有一个地址。
不在上述范围内的集合名 MUST 返回 404，MUST NOT 变成对任意集合的探测。

#### Scenario: 简报集合有自己的订阅源
- **WHEN** 简报插件已启用并声明了 `briefings` 集合，请求 `/feed/briefings.xml`
- **THEN** 返回该集合的 RSS 2.0 文档，条目的链接是 `/briefing/<slug>/` 的绝对地址

#### Scenario: 本地名重名时回退到机器名
- **WHEN** 两个已启用插件都声明了本地名 `terms` 的集合
- **THEN** `/feed/terms.xml` 不是任何一个插件的订阅源，而两个集合的机器名地址各自返回自己的文档

#### Scenario: 站点订阅源的集合没有重复地址
- **WHEN** `feedCollection` 为 `articles`（默认），请求 `/feed/articles.xml`
- **THEN** 返回 404；站点订阅源只在 `/feed.xml` 与 `/atom.xml`

### Requirement: 收录资格与开关
订阅源 SHALL 只列出同时满足以下条件的条目：在公开投影中存在、已发布、`noindex` 不生效（与页面的收录判定
同一个结果）、canonical 指向自身。未发布、已删除、`noindex` 或 canonical 指向别处的条目 MUST NOT 出现。
`feeds` 开关关闭时，所有订阅源路径 MUST 返回 404，MUST NOT 返回空文档或只含 channel 的文档。

#### Scenario: noindex 条目不进入订阅源
- **WHEN** 一篇已发布文章的 SEO 设置为 `noindex,follow`
- **THEN** `/feed.xml` 中没有该条目的链接，但它的页面仍可访问

#### Scenario: 草稿不进入订阅源
- **WHEN** 一个集合里只有草稿条目
- **THEN** 该集合的订阅源是空 channel（或 404，若集合没有公开条目地址），草稿的标题与链接都不出现

#### Scenario: 关闭订阅源是 404
- **WHEN** 站点的 `discovery.feeds` 为 `false`
- **THEN** `/feed.xml`、`/atom.xml` 与集合级订阅源都返回 404

### Requirement: 文档形状
站点与集合级订阅源 SHALL 是 RSS 2.0（`/feed*.xml`）或 Atom（`/atom*.xml`）。RSS 文档 MUST 含
`channel` 的 `title`、`link`、`description`，每个条目 MUST 含标题、指向条目 canonical 地址的绝对 `link`、
稳定的 `guid`、`pubDate`（有发布时间时）与转义后的文本；Atom 文档 MUST 含 `feed` 的 `id`、`title`、
`updated` 与每个条目的 `id`、`title`、`link`、`updated`。值 MUST 按 XML 转义，XML 1.0 不能容纳的字符
MUST 被移除。条目 MUST 按发布时间从新到旧排列，MUST 最多 20 条；不足 20 条时 MUST 只列实际存在的条目。

#### Scenario: 转义与顺序
- **WHEN** 集合中最新的条目标题含 `&`、`<` 或引号，且发布时间晚于另一条
- **THEN** 文档中的标题被转义，较新的条目排在较旧的条目之前，`pubDate` 是 RFC 822 时间

#### Scenario: 上限 20 条
- **WHEN** 一个集合有 25 条可收录条目
- **THEN** 订阅源只列出最新的 20 条，且不重复

### Requirement: 与页面同一投影路径
订阅源 MUST 由与页面相同的公开投影读取路径生成，MUST NOT 引入第二个「什么算公开」的判定。
Astro 静态构建 MUST 使用与 CMS 应答相同的订阅源字节；page-data 快照 MUST 包含站点订阅源与集合级订阅源文件。
CMS 与静态构建对同一站点版本 MUST 给出相同的订阅源正文与内容类型。

#### Scenario: 静态构建包含订阅源
- **WHEN** 对一个已发布简报的站点导出 page-data 并构建 Astro 站点
- **THEN** 快照的 `files` 含 `/feed.xml` 与 `/feed/briefings.xml`，构建产物中的字节与 CMS 应答相同

#### Scenario: 投影之外的条目不存在
- **WHEN** 一个条目没有进入公开投影（例如仍在草稿、已删除或被行规则隐藏）
- **THEN** 订阅源与静态产物都不包含它

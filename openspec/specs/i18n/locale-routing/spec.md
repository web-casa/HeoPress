# i18n/locale-routing Specification

## Purpose
定义多语言站点中各语言版本的 URL 组织方式与语言切换行为，保证每个语言版本有独立、可被搜索引擎单独抓取的 URL。

## Requirements

### Requirement: 三种语言 URL 策略
站点 SHALL 支持子目录（`/en/…`）、子域名（`en.example.com`）、独立域名（`example.cn`）三种语言 URL 策略。
每个语言版本 SHALL 拥有独立的 slug。

#### Scenario: 子目录策略
- **WHEN** 站点使用子目录策略，访问 `/zh/astro-jiao-cheng/`
- **THEN** 路由解析结果指向该文章的中文版本（公开 HTTP 渲染由后续引擎提供）

#### Scenario: 独立域名策略
- **WHEN** 中文版本位于 `example.cn`，访问 `example.cn/astro-jiao-cheng/`
- **THEN** 路由解析结果指向该文章的中文版本（公开 HTTP 渲染由后续引擎提供）

### Requirement: 子目录语言前缀
子目录策略 SHALL 支持两种模式："默认语言在根路径、其他语言带前缀"与"全部语言带前缀"；后者访问根路径 SHALL 重定向到默认语言首页。
每种语言的前缀 SHALL 可自定义（例如 `zh-cn`、`pt-br`、`zh-tw`），同站点内 MUST 唯一，且 MUST NOT 与保留路径或已有顶层路径冲突。

#### Scenario: 默认语言在根路径
- **WHEN** 站点默认语言为英文、模式为"默认语言在根路径"，访问 `/guide/` 与 `/zh/guide-cn/`
- **THEN** 前者解析为英文版本，后者解析为中文版本

#### Scenario: 全部语言带前缀
- **WHEN** 站点默认语言为 `zh-cn`、模式为"全部语言带前缀"，访问 `/`
- **THEN** 重定向到 `/zh-cn/`

#### Scenario: 前缀与已有路径冲突
- **WHEN** 管理员把某语言前缀设为已被页面占用的顶层路径 `about`
- **THEN** 保存失败并列出冲突路径

### Requirement: 不按浏览器语言替换内容
同一 URL SHALL 始终返回同一语言的内容，MUST NOT 根据 `Accept-Language` 请求头切换正文语言。

#### Scenario: 不同浏览器语言
- **WHEN** 两个 `Accept-Language` 不同的请求访问同一 URL
- **THEN** 两者得到相同的语言路由解析结果

### Requirement: 语言切换指向实际译文
语言切换数据 SHALL 指向同一翻译组中对应语言的已发布译文。某语言没有已发布译文时 MUST NOT 生成该语言的切换项。

#### Scenario: 缺少日文译文
- **WHEN** 一篇文章只有英文与中文的已发布版本
- **THEN** 语言切换数据只包含英文与中文

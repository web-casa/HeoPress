# migration/wordpress-import Specification

## Purpose
让已有 WordPress 站点的运营者把内容、媒体与 SEO 数据迁入 HeoPress，并保证旧链接可追踪、重复导入不产生重复内容。

## Requirements

### Requirement: WXR 导出转换为导入包
系统 SHALL 支持从 WordPress 导出文件（WXR）生成导入包，包含文章、页面、分类、标签、作者与媒体，
并把 Yoast、Rank Math、AIOSEO 的标题、描述、canonical 与 noindex 映射到条目的 SEO 字段。

#### Scenario: 含 Yoast 字段的文章
- **WHEN** 导入一篇设置了 Yoast 自定义标题与描述的文章
- **THEN** 生成的导入包条目中 `seoTitle` 与 `seoDescription` 等于 Yoast 的值

#### Scenario: 三种 SEO 插件同时存在
- **WHEN** 同一篇文章同时有 Yoast 与 Rank Math 的标题字段
- **THEN** 取 Yoast 的值，并在预演报告中记录一条说明来源的 note

### Requirement: 安全解析
解析 WXR SHALL NOT 解析 DOCTYPE 或 ENTITY 声明，SHALL 限制输入体积与元素深度，SHALL 只读取调用方给出的字节。

#### Scenario: 含外部实体的文件
- **WHEN** WXR 文件含 `<!DOCTYPE` 或 `<!ENTITY`
- **THEN** 转换被拒绝并返回明确错误，不产生导入包

### Requirement: 旧链接记录
条目 SHALL 记录它在旧站点的路径；使用 `?p=<id>` 形式的站点 SHALL 额外生成旧路径到新路径的 `redirect` 记录；
无法确定旧路径的条目 SHALL 在预演报告中列出，不猜测。

#### Scenario: 朴素固定链接
- **WHEN** 原站点固定链接为 `?p=123`，文章 ID 为 123
- **THEN** 导入包包含一条 `/?p=123` 指向该文章新路径的 `redirect` 记录

### Requirement: 预演报告
转换 SHALL 产出报告，列出条目与媒体数量、无法映射的字段、未知区块与位置、缺失的媒体、SEO 字段来源与缺失、
旧链接无法确定的条目。

#### Scenario: 未知区块
- **WHEN** 文章含转换器不认识的 Gutenberg 区块
- **THEN** 该区块内容按 HTML 保留，报告记录区块名与位置

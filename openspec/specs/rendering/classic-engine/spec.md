# rendering/classic-engine Specification

## Purpose
定义 Classic 渲染引擎如何在一个进程内为多个独立域名渲染已发布内容，包括状态码、缓存失效与站点之间的错误隔离。

## Requirements

### Requirement: 按域名渲染站点
渲染服务 SHALL 根据请求的 Host 确定站点，只返回该站点的已发布内容。一个站点的内容 MUST NOT 通过另一个站点的域名访问到。

#### Scenario: 两个站点
- **WHEN** 分别请求 `a.example.com/` 与 `b.example.com/`
- **THEN** 各自返回本站点的首页内容

#### Scenario: 跨站点路径
- **WHEN** 通过 `a.example.com` 请求只存在于站点 B 的文章路径
- **THEN** 返回 404

#### Scenario: 草稿不可见
- **WHEN** 请求一篇处于草稿状态的文章路径
- **THEN** 返回 404

### Requirement: 状态码语义
不存在的路径 SHALL 返回 404；已删除的已发布内容 SHALL 返回 410；存在重定向记录的路径 SHALL 返回 301 并指向目标路径。

#### Scenario: 已删除的文章
- **WHEN** 请求一篇曾发布后被删除的文章路径
- **THEN** 返回 410

#### Scenario: 旧 slug
- **WHEN** 请求修改 slug 前的旧路径
- **THEN** 返回 301，Location 为新路径

### Requirement: 发布后及时更新
内容或主题发布后，对应公开页面 SHALL 在 10 秒内反映新版本。渲染响应 SHALL 携带 ETag，条件请求在内容未变时 SHALL 返回 304。

#### Scenario: 发布新文章
- **WHEN** 编辑发布一篇新文章
- **THEN** 10 秒内该文章页面可访问，首页列表包含该文章

#### Scenario: 条件请求
- **WHEN** 客户端带上次响应的 ETag 再次请求未变化的页面
- **THEN** 返回 304

### Requirement: 站点之间的错误隔离
某个站点的模板渲染错误 SHALL 只影响该站点，并返回该站点的错误页；错误响应 MUST NOT 包含堆栈或内部路径。

#### Scenario: 主题出错
- **WHEN** 站点 A 的文章模板抛出错误
- **THEN** 站点 A 返回错误页且不含堆栈，站点 B 的页面正常返回

### Requirement: 公开域名不暴露管理面
公开站点域名 MUST NOT 提供后台与管理 API。

#### Scenario: 在公开域名访问后台
- **WHEN** 通过站点公开域名请求后台路径或 API 路径
- **THEN** 返回 404

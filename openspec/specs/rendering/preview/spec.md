# rendering/preview Specification

## Purpose
让编辑与审核者在发布前，通过签名的限时链接在真实站点外观下预览草稿内容与未发布的主题版本，且预览内容不会被搜索引擎收录。

## Requirements

### Requirement: 签名限时预览
系统 SHALL 为指定的草稿条目或主题版本生成签名、限时的预览链接（默认 1 小时）。过期或签名无效的链接 MUST 被拒绝。

#### Scenario: 有效预览
- **WHEN** 审核者在有效期内打开草稿的预览链接
- **THEN** 看到用站点当前主题渲染的草稿页面

#### Scenario: 过期链接
- **WHEN** 打开超过有效期的预览链接
- **THEN** 返回 403

### Requirement: 预览不被收录与缓存
预览响应 SHALL 带 `X-Robots-Tag: noindex`，且 MUST NOT 进入页面缓存或被 CDN 缓存。

#### Scenario: 预览响应头
- **WHEN** 请求预览链接
- **THEN** 响应包含 `X-Robots-Tag: noindex` 与禁止缓存的 Cache-Control

### Requirement: 预览范围与当前授权
预览链接 SHALL 仅由有权限用户创建，访问时 MUST 验证指定站点、条目或主题版本及当前授权。过期、撤销或跨站复用 MUST 被拒绝；令牌 MUST NOT 写入日志或向第三方泄露。

#### Scenario: 跨站复用预览
- **WHEN** 在站点 B 使用仅允许站点 A 条目的预览令牌
- **THEN** 返回 403，不读取站点 B 草稿

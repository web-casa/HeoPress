# 草稿与主题预览

编辑与审核者在发布前，可以用签名、限时的链接，在站点的真实外观下预览**草稿条目**或**未发布的主题版本**。预览不会被搜索引擎收录，也不会进入任何缓存。

实现：`apps/cms/src/services/rendering/preview-service.ts`（链接与校验）、`apps/cms/src/routes/preview-links.ts`（管理接口）、
`apps/cms/src/routes/internal-preview.ts`（渲染服务专用的内部接口）、`apps/site-classic/src/preview.ts` 与 `apps/site-classic/src/app.ts`（预览来源上的路由）、
`packages/public-site/src/theme/postprocess.ts`（预览模式的 HTML 处理）。

## 配置

| 变量 | 所在服务 | 说明 |
|---|---|---|
| `HEOPRESS_PREVIEW_ORIGIN` | CMS、site-classic | 预览来源，例如 `https://preview.admin.example.com`。不设置时预览关闭（创建链接返回 503）。必须与管理来源及任何站点公开域名都不同 |
| `HEOPRESS_INTERNAL_SECRET` | CMS、site-classic | 服务间共享密钥，至少 32 个字符；CMS 未设置时内部预览接口不存在（404） |
| `HEOPRESS_CMS_INTERNAL_URL` | site-classic | 渲染服务访问 CMS 的内网地址（默认 `http://cms:1989`） |
| `HEOPRESS_PREVIEW_MEDIA_ORIGINS` | site-classic | 预览页面允许加载图片与媒体的来源（逗号分隔，通常是媒体域名；只用于正文中出现的地址） |
| `HEOPRESS_PUBLIC_URL` | site-classic | 管理来源；与预览来源相同时预览关闭 |

预览来源的域名解析到 Caddy，由 Caddy 转给 site-classic（与公开站点相同）。站点公开域名上**没有**任何预览路由。
渲染服务发现预览来源同时是某个站点的公开域名时拒绝预览（404 并记录错误）。

## 创建与撤销

```http
POST /api/v1/preview-links
X-HeoPress-Site: <站点 ID>
{ "kind": "item", "collection": "articles", "target_id": "<条目 ID>", "ttl_seconds": 3600 }
{ "kind": "theme", "target_id": "<主题版本 ID>" }

→ 201 { "data": { "id": "…", "url": "https://preview…/<站点 ID>/<令牌>", "expires_at": "…" } }

DELETE /api/v1/preview-links/<id>   → 204（创建者或站点管理员）
```

- 草稿预览：创建者必须能读取该集合，且该条目满足其读取规则（行级规则）；主题版本预览：创建者必须是站点管理员，版本必须已封存（上传即封存，不要求已发布）。
- 有效期默认 1 小时，60 秒到 24 小时。令牌是 256 位随机值，只在创建响应中出现一次；数据库只存它的 SHA-256。
- 只能由已登录用户创建（预览每次都要核对创建者的当前权限）。

## 打开预览

1. 打开链接 `https://preview…/<站点 ID>/<令牌>`：渲染服务把令牌交给 CMS 内部接口核对，成功后设置 Cookie
   `heopress_preview`（`Secure; HttpOnly; SameSite=Strict; Path=/<站点 ID>/`，有效期到链接过期为止），并 303 到 `/<站点 ID>/view`——令牌只出现在第一次请求中。
2. `/<站点 ID>/view` 渲染预览：
   - 草稿：用站点当前主题渲染草稿的条目页；字段按公开投影的规则过滤（只公开字段、富文本净化），再收窄到创建者可读的字段。
   - 主题版本：用该版本渲染站点首页（已发布的文章）。
3. 预览页用到的主题资源在 `/<站点 ID>/assets/<版本 ID>/<SHA-256>.<扩展名>`，同样凭 Cookie 校验；只提供被预览的版本（主题预览）或站点当前版本（草稿预览）的资源。

**每次请求**（兑换、页面、资源）都由 CMS 重新核对：链接属于路径中的站点（只在该站点内查找，A 站的令牌放在 B 站路径下什么也找不到，也不会读取 B 站的草稿）、
未过期、未撤销、创建者账号仍为活动状态并且**现在**仍有权限。任何一项不满足都返回同样的 403，不说明原因。

## 响应

预览来源上的所有响应（403、303、资源在内）都带：

```
Cache-Control: no-store, private
X-Robots-Tag: noindex, nofollow
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'self' data: <媒体来源>; media-src …;
                         style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'
```

预览页面的 HTML 额外处理（正文也包括在内）：

- 移除 `<form>`、`<iframe>`、`<object>`、`<embed>` 以及 `prefetch` / `preload` / `preconnect` / `dns-prefetch` / `prerender` 类 `<link>`；
- 指向预览之外的 `<a>`、`<area>` 去掉 `href`（文字保留），`ping`、`formaction` 一并去掉；
- 图片、视频、音频与样式表只能来自预览本身；来自媒体来源的，只有系统内容（条目净化后的正文）中出现过的**同一 URL** 才保留——主题不能用草稿数据拼出媒体地址；
- 会发起请求的 CSS（`url(`、`image-set`、`@import`、反斜杠转义）所在的 `style` 属性与 `<style>` 元素被移除；其他元素上指向预览之外的 URL 属性（如 SVG `<use href>`、`cite`）被去掉。

预览不读也不写页面缓存（`docs/zh-CN/rendering/page-cache.md`），也不经过 CDN 缓存。

## 日志与隔离

- 令牌只在链接、兑换请求的路径与 Cookie 中出现：渲染服务调用 CMS 时把令牌放在请求体中（不放在 URL），两边都不记录令牌；Caddy 的访问日志应过滤预览来源的路径。
- 内部接口 `/internal/preview/*` 只供渲染服务使用：共享密钥认证（常量时间比较）、拒绝经代理转发的请求、按站点限流（每分钟 600 次）；Caddy 对外对 `/internal*` 返回 404。
- 渲染数据库角色仍然读不到草稿、预览链接表与未发布的主题版本：这些只经内部接口返回。
- 预览不计入站点分析。
- 预览来源上的任何失败（包括数据库或 CMS 异常）同样带上述预览响应头返回 500。

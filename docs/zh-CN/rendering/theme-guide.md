# 主题开发指南

HeoPress 的公开网站由站点主题渲染：一组 Liquid 模板加上静态资源，按版本上传、检查后发布到某个站点。本指南面向主题作者（人或 AI）。
引擎、沙箱与检查的实现细节见 `docs/zh-CN/rendering/theme-engine.md`。

## 许可证

主题只依据主题契约编写（页面数据契约 `packages/contracts/src/theme/index.ts` 为 Apache-2.0）时，可以使用任意许可证发布，包括闭源商业主题；
这是 HeoPress AGPL-3.0 许可的插件与主题例外（ADR-0008）。复制或修改 HeoPress 自身源码（包括内置主题之外的核心代码）不在此例外之内。

## 主题由什么组成

| 部分 | 要求 |
|---|---|
| 页面模板 | 必须有 `home`、`item`、`taxonomy`、`search`、`error` 五个，分别对应首页、条目页、分类 / 标签 / 作者页、搜索页、错误页 |
| 局部模板 | 放在 `partials/` 下，名称只用小写字母、数字、`-`、`_` 与 `/`，不写扩展名 |
| 资源 | 小写相对路径加扩展名，如 `css/site.css`；类型限于 CSS、JavaScript、PNG、JPEG、GIF、WebP、AVIF、SVG、ICO、WOFF、WOFF2；单个 ≤ 2 MB，一个版本合计 ≤ 20 MB |

参考实现是内置主题 `packages/public-site/src/theme/builtin.ts`：站点没有发布任何主题时就用它渲染。

## 页面数据

模板只能读取页面数据契约中的数据，顶层名称为：

- `site`：`name`、`locale`（当前页面语言）、`locales`、`homeUrl`；
- `page`：`type`、`locale`、`path`、`status`、`query`（搜索词）；
- `item`：条目页与分类 / 标签 / 作者页的条目——`id`、`collection`、`title`、`url`、`locale`、`publishedAt`、`fields`（其他公开字段，如 `item.fields.excerpt`）、
  `sponsor.sponsored`、`sponsor.name`；
- `list`：卡片列表——`id`、`title`、`excerpt`、`url`、`publishedAt`、`sponsored`；
- `pagination`：`page`、`prevUrl`、`nextUrl`；
- `alternates`：其他语言版本（`locale`、`url`）；
- `nav`：导航链接（`label`、`url`）；
- `seo`：`{% seo_head %}` 使用的数据。

读取不存在的变量（例如 `site.secret`、`item.sponsor.secret`、`list | map: 'secret'`）会在发布前报错并给出变量名。可能缺失的字段用 `{% if item.fields.x %}` 或 `| default:` 读取。

## 必需的系统标签

正文、SEO 头部（含页面唯一的 JSON-LD 图）与赞助披露只能由系统标签输出，内容由系统生成，主题无法修改。主题不能输出自己的 JSON-LD（没有 `json_ld` 标签，
任何分支中的 `ld+json` 脚本都会被拒绝，`<script>` 的 `type` 必须直接写出、不能由模板计算）。主题的 JavaScript 也不得在页面中插入结构化数据：
检查器只能检查服务器输出的页面，脚本在浏览器中的行为不在保证范围内，这类主题违反本约定。需要额外的结构化数据时，写在条目的“结构化数据（JSON-LD）”字段，
或由扩展通过 `StructuredDataContribution` 贡献（见 `site-classic.md`），系统把它们合并进页面唯一的图。系统标签的用法：

```liquid
<head>
  <meta charset="utf-8">
  {% seo_head %}                      {% # 每个页面恰好一次，必须在 <head> 内 %}
  <link rel="stylesheet" href="{{ 'css/site.css' | asset_url }}">
</head>
<body>
  <article>
    <h1>{{ item.title }}</h1>
    {% if item.sponsor.sponsored %}{% sponsor_disclosure item %}{% endif %}   {% # 在正文之前 %}
    {% item_body %}                   {% # 条目页恰好一次 %}
  </article>
  {% for c in list %}
    {% card c %}                      {% # 列表项的容器：指向赞助条目的链接必须在它的卡片内 %}
      <a href="{{ c.url | url }}">{{ c.title }}</a>
      {% if c.sponsored %}{% sponsor_disclosure c %}{% endif %}
    {% endcard %}
  {% endfor %}
</body>
```

- 站点开启“显式披露”时，赞助条目页必须在正文之前输出 `{% sponsor_disclosure item %}`，每个赞助卡片内必须输出一次 `{% sponsor_disclosure c %}`；缺少时该版本不能在开启披露的站点上发布，
  站点在使用缺少插槽的版本时也不能开启显式披露。披露关闭时这些标签不输出内容，所以总是写上即可。
- 站点开启“链接标记为 sponsored”时，系统会给赞助条目正文中的站外链接加 `rel="sponsored"`，主题不能去掉。
- 披露区块必须对访客可见（不能用 CSS 隐藏）。系统只能检查它在页面中的位置，可见性是主题审核要求。
- 系统标签不能放在 `<template>`、`<noscript>`、带 `hidden` / `inert` 的元素、HTML 注释、SVG / MathML 中，也不能被 `capture` 后再输出。

## 输出与 URL

- `{{ }}` 的输出一律经过 HTML 转义；没有输出原始 HTML 的方式（`raw`、`echo`、`cycle` 等不可用）。
- 输出只能放在文本或加引号的属性值中；`on*`、`style`、`srcdoc` 属性，`<script>`、`<style>` 内，注释中都不允许；SVG / MathML 的属性中不允许输出。
- `href`、`src`、`action` 等 URL 属性中的输出必须以 `url` 或 `asset_url` 过滤器结尾：`url` 只放行 `http:`、`https:`、`mailto:` 与站内相对地址，其他输出 `#`。
- 主题自己写在模板里的标记同样不能有事件属性、`javascript:` 链接、`<base>`、`<meta http-equiv="refresh">`、SVG 动画元素。
- 控制结构（`if`、`for`、`case`、`unless`、`capture`、`card`）的每个分支都要标签配平：不能在分支里打开或关闭分支外的元素，也不能写半个标签。

## 资源

用 `{{ '路径' | asset_url }}` 引用本版本的资源，路径必须是字符串字面量且存在于本版本中。地址形如 `/_theme/<版本 ID>/<SHA-256>.<扩展名>`，内容不变，浏览器与 CDN 可以永久缓存。
资源由站点自己的域名提供；SVG 单独打开时不能执行脚本。

## 沙箱限制

- 只能 `include` / `render` 本版本内的模板，名称必须是字符串字面量；最多嵌套 8 层，展开后不超过 100 万字符。
- 模板只存在于该版本的内存映射里，渲染时从不读取文件系统：绝对路径、`..`、符号链接都“找不到”；名称不合规则的模板在发布检查和渲染引擎中都会被拒绝。
- 不能读取原型、`constructor` 等内部属性，不能用变量作属性名（`x[变量]`）。
- 每次渲染有时间、内存、过滤器字符串与数组长度、`capture` 大小、输出大小（2 MB）的上限；超出即渲染失败，返回站点的错误页（`error` 模板）。

## 发布流程

站点管理员通过管理 API 操作：

| 请求 | 作用 |
|---|---|
| `POST /api/v1/themes/versions` `{ name, templates: { home: "…", … }, assets: [{ path, contentType, base64 }] }` | 上传一个版本：封存后不可修改，同时完成发布前检查，结果在 `checks` 中 |
| `GET /api/v1/themes` | 所有版本、检查结果与当前生效的版本 |
| `POST /api/v1/themes/versions/:id/activate` | 发布、切换或回滚到该版本，立即生效 |

发布前检查包括上述静态检查，以及用样例数据（含赞助条目与赞助卡片、带有恶意字符串的标题）渲染每个页面模板两次（显式披露关闭与开启）。
`checks.ok` 为真才能发布；`checks.disclosureOk` 为真才能在开启显式披露的站点上发布。检查失败的条目在 `checks.issues` 中列出模板与原因。
修改主题就是上传新版本；曾发布的版本永久保留，可以随时回滚。

## 起步主题

内置三套起步主题（`packages/public-site/src/theme/starters.ts`），都是普通主题：模板加一个样式表，经过同样的检查、引擎与后处理，可以作为编写自己主题的起点。

| 名称 | 风格 |
|---|---|
| `news` | 资讯：卡片网格、摘要与日期 |
| `tech` | 技术博客：单栏列表、等宽站名、代码块样式 |
| `minimal` | 极简：衬线单栏、只列标题与日期 |

站点管理员安装后再激活（安装不会改变站点外观）：

```http
POST /api/v1/themes/starters/news          → 201，返回新版本（已检查、已封存）
POST /api/v1/themes/versions/<id>/activate → 生效
```

新站点不会自动安装起步主题：没有激活版本的站点使用内置主题。三套主题都适配窄屏（单栏、无横向滚动），带跳转到正文的链接、地标区域、带标签的搜索框、可见的焦点样式，
正文文字对比度不低于 4.5:1。验收：`pnpm --filter @heopress/public-site e2e` 以样例数据（另加超长单词标题）渲染每套主题的每种页面，在桌面、手机与 320 px 宽度下截图，
检查无横向溢出、链接有下划线、导航可见，并用 axe（WCAG 2 A/AA）检查无任何发现；CI 作业 `starter-themes` 保留截图。

# WordPress 站点迁入指南（v1.1）

本指南说明如何把 WordPress 站点的内容迁入 HeoPress。转换器把 WordPress 导出文件（WXR）转成**导入包**，
之后的预演、导入、批次激活与 URL 对照沿用既有导入流程（见[《Astro 站点迁入指南》](astro-import.md)的 3–6 节），
所以这里只讲 WordPress 特有的部分。

## 1. 导出 WXR

在 WordPress 后台「工具 → 导出」选择「所有内容」下载 XML 文件。文件包含文章、页面、媒体、分类、标签、作者与
SEO 插件的自定义字段（Yoast / Rank Math / AIOSEO 都写在 `wp:postmeta` 里）。导出文件不包含插件、主题与用户密码。

## 2. 转换为导入包

有两种输入，产出同一个导入包：

- **WXR 文件**（推荐，字段最全）：`heopress import wordpress export.xml --source-site … --default-locale … --out …`
- **REST API**（不必下载导出文件，但字段更少）：`heopress import wordpress --rest https://example.test --source-site … --default-locale … --out …`。
  请求经平台出站防护（连接时校验地址、重定向逐跳复查、响应体与时间有上限），不会访问内网地址。

转换器是纯函数，输入 WXR 字节与选项，输出导入包记录与预演报告：

- `sourceSite`：来源实例名（小写字母、数字、`_`、`-`），与目标站点、WordPress 内容 ID 一起构成幂等键；
  两个来源实例的同名 ID 不会互相覆盖。
- `defaultLocale` / `locales`：目标站点的语言。
- `collections`：`wp:post_type` 到集合的映射，默认 `post → articles`、`page → pages`。
- `permalinkStructure`：原站点的固定链接结构（如 `/%postname%/`）。为 `?p=` 形式时，转换器会为每篇文章写一条
  `redirect`（`/?p=<id>` → 导入后的路径）。
- `targetPermalinks`：目标集合的固定链接模板，用于生成重定向目标（默认 `/:slug`）。
- `readMedia`：按 `_wp_attached_file` 读取媒体文件的回调；没有提供的媒体会在报告中列为缺失，不会伪造。

输出是一个导入包目录（`bundle.ndjson` + `media/`），可直接交给 `heopress import` 的预演与导入子命令。

## 3. 预演报告要看什么

`wordpress-report.json` 列出：

| 项 | 含义 |
|---|---|
| `items` | 条目总数、按 `wp:post_type` 的数量、已发布与草稿数 |
| `media` | 媒体数与缺失的文件（`readMedia` 没读到，或扩展名不在允许类型内，例如 `.svg`） |
| `unmappedMeta` | 未映射的 `wp:postmeta` 键与出现次数（供后续补充映射） |
| `seo` | 有 SEO 字段的条目数、来源插件（Yoast / Rank Math / AIOSEO）、缺失 SEO 字段的条目 |
| `unknownBlocks` | 转换器不认识的 Gutenberg 区块名与所在条目（内容仍按 HTML 保留） |
| `legacyPathUnknown` | 无法确定旧路径的条目（不猜测） |
| `redirects` | 生成的旧链接重定向数 |

同一篇文章同时有多个插件的 SEO 字段时，按 Yoast → Rank Math → AIOSEO 取第一个非空值，并在条目上记一条来源说明。

## 4. 限制

- 旧链接可访问的前提是运营者控制旧域名并把该域名绑定到目标站点；转换器只记录旧路径与重定向，不改原站、不猜测域名。
- 只导入内容与媒体；WordPress 插件、主题、评论、用户密码与权限不迁移。
- Gutenberg 区块的**分隔注释被去掉**，区块自身的 HTML 保留（核心块的内容本身就是合法 HTML），导入时再经过既有的 HTML 清洗；
  不认识的区块（含 `jetpack/*` 这类命名空间块）内容照常保留，并在报告与条目 note 中列出。
- REST 不暴露 SEO 插件字段（Yoast / Rank Math / AIOSEO 通常没有注册到 REST），也不暴露 `_wp_attached_file`：
  预演报告的 `rest.seoNotExposed` 会说明，媒体按 `source_url` 的路径记录；需要完整 SEO 数据时请用 WXR。

# Astro 站点迁入指南

本指南说明如何把以 Markdown / MDX + frontmatter 维护内容的 Astro 站点迁入 HeoPress：先转换为**导入包**，预演、导入、批次激活，
最后在切换前用 **URL 对照**证明旧链接全部可访问。全过程可重复执行，不会产生重复条目；激活前导入的内容不会出现在前台、sitemap 或 IndexNow 推送中。

命令行入口是 CMS 的 `heopress import`（`apps/cms/scripts/cli.ts`），在 `apps/cms` 目录下运行：

```bash
npx tsx scripts/cli.ts import <子命令> ...
```

## 1. 准备目标站点

1. 在 HeoPress 中建好站点，安装站群预设（`heopress preset upgrade --site <id>`）。
2. 在站点内容设置中配置语言（含默认语言）、语言前缀、尾斜杠策略和各集合的固定链接。导入**不会**修改站点设置，
   预演报告会列出导入包与站点设置的差异（缺少的语言、不同的尾斜杠或固定链接）。
3. 媒体导入需要站点绑定带公开访问地址的存储（与编辑器上传相同）；没有公开地址时导入会失败并提示。
4. 分类、标签和作者按名称或 slug 匹配站点已有条目；匹配不到的会在预演报告中列为"未转换"，不会自动创建。

## 2. 编写映射配置

映射配置是一个 JSON 文件，例如：

```json
{
  "sourceSite": "blog-example",
  "defaultLocale": "en",
  "locales": ["en", "zh", "id"],
  "localeAliases": { "zh": "zh-CN" },
  "localePrefixes": { "zh-CN": "zh" },
  "trailingSlash": "always",
  "components": { "Callout": { "as": "blockquote" } },
  "collections": [
    {
      "source": "blog",
      "collection": "articles",
      "locale": { "from": "suffix" },
      "permalink": "/blog/:slug",
      "fields": { "title": "title", "description": "excerpt", "heroImage": "seo_image", "pubDate": "@publishedAt", "tags": "@tags", "draft": "@draft" }
    }
  ],
  "redirects": { "rules": { "/rss": "/rss.xml" } }
}
```

- `collections[].source`：`src/content/` 下的目录；`collection`：HeoPress 集合。
- `fields`：frontmatter 字段 → HeoPress 字段。以 `@` 开头的是特殊目标：`@publishedAt`、`@updatedAt`、`@tags`、`@categories`、
  `@author`、`@draft`（为真时导入为草稿）、`@sponsored`、`@sponsorName`、`@internalOnly`、`@slug`、`@translationKey`。
- 语言识别 `locale.from`：`directory`（`docs/zh/guide.md`）、`suffix`（`post.zh.mdx`）或 `field`（frontmatter 字段）。
  识别不到时使用默认语言并在报告中注明。
- 翻译组 `translationKey.from`：`slug`（去掉语言部分后的文件路径相同即为同一组，默认）或 `field`。
- `permalink`：旧站 URL 模式，非默认语言自动加上语言前缀；`trailingSlash` 决定旧路径是否带尾斜杠。
- 旧重定向：默认读取 `public/_redirects`、`vercel.json` 与 `astro.config.*` 中的 `redirects`，再加上 `redirects.rules`。
  带动态参数（`[slug]`）的规则不会猜测转换，会在报告中列出，需要手工补充。

## 3. 转换与校验

```bash
npx tsx scripts/cli.ts import astro <Astro 站点根目录> --mapping heopress-import.json --out ./bundle
npx tsx scripts/cli.ts import validate ./bundle
```

转换输出 `bundle/bundle.ndjson`、`bundle/media/` 与 `bundle/astro-report.json`。报告中需要关注：

- `missingFields`：映射引用但条目中缺少的字段（以及缺少的条目数）；
- `unmappedFields`：frontmatter 中没有映射、不会导入的字段；
- `unknownComponents`：无法识别的 MDX 组件（文件与行号）。它们**不会被丢弃**，而是保留为自定义组件区块
  （`data-block-type="custom-component"`，组件名与属性保存在区块上），公开页面不渲染其内容，需要人工替换；
- `notes`：找不到的图片、保留为文本的表达式等。

正文中引用的本地图片（相对路径、`public/` 下的绝对路径、`import` 后用于 `<Image>` 的图片）进入媒体清单，引用改写为
`heopress-media:<id>`，导入时替换为存储地址。只读取站点根目录内的文件。

导入包格式见 `docs/schemas/heopress.import-bundle.v1.schema.json`（`import schema` 子命令输出同一份）。导入包不得包含密钥或凭据：
名称像密钥的字段（`apiKey`、`password`、`token` 等）或像私钥、带密码 URL 的值都会使校验失败并指出位置。

校验还会检查：媒体路径必须是 `media/` 内的普通相对路径（拒绝 `..`、绝对路径、反斜杠和指向外部的符号链接），
文件大小与 SHA-256 与清单一致，文件头与声明的类型一致（不接受 SVG），以及单文件、总大小与条目数量上限。

## 4. 预演、导入与激活

```bash
npx tsx scripts/cli.ts import dry-run --site <站点 id> --bundle ./bundle --actor <用户 id>
npx tsx scripts/cli.ts import run --site <站点 id> --bundle ./bundle --batch <批次 id> --report-hash <报告哈希> --actor <用户 id>
npx tsx scripts/cli.ts import activate --site <站点 id> --batch <批次 id> --actor <用户 id>
```

- **预演**在事务中完整执行一次导入后回滚，报告新增、更新、未变化、冲突、失败、未转换内容、路径变化与安全问题，不存储媒体。
- **导入**必须带上预演的报告哈希；站点或导入包在预演后发生变化时返回 409，需要重新预演。外部 ID 按 `astro:<sourceSite>` 命名空间去重：
  重复导入同一包不增加条目，只更新导入包中有变化的条目；在 HeoPress 中被人编辑过或已经公开的条目不会被覆盖（报告为冲突）。
  所有条目都以草稿写入。
- **激活**在一个事务中重新核验批次内每个条目：未被 Hold、不是仅内部条目、没有不安全内容（导入时被清洗掉脚本等内容的条目需要人工检查）、
  自导入后未被修改、激活者对条目有发布权限。任一不满足即整批不激活并列出原因；缺少标题或描述等 SEO 问题只作提示。
  激活后旧站已发布的条目一起公开，写入导入包中的重定向以及路径发生变化的条目的 301，条目保留"历史导入"标记（批次记录）。
  重定向统一按 301 写入。

## 5. 切换前的 URL 对照

```bash
npx tsx scripts/cli.ts import compare --urls https://www.example.com/sitemap-index.xml --new-base https://preview.example.com --out url-report.json
```

`--urls` 可以是旧站 sitemap（含 sitemap 索引）或每行一个 URL 的文件。工具逐个请求旧站 URL 与新站预览中的同一路径，比较状态码、
canonical、hreflang 与标题（canonical 与 hreflang 按路径比较）。新站经 301 到达的页面视为可访问；返回 404 且没有重定向的旧 URL 会被列出。

对确实预期的差异，在 JSON 文件中逐条说明原因后用 `--explanations` 传入：键为路径（说明该 URL 的全部差异）或 `路径#类型`
（类型为 `status`、`canonical`、`hreflang`、`title`）。只有全部差异都有说明时报告才是 `switchable: true`，否则命令以退出码 2 结束，
站点保持"不可切换"。请求经过平台出站防护，不访问内网地址。

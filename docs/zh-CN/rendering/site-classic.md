# 经典渲染服务（site-classic）

`apps/site-classic` 是公开网站的渲染进程：一个进程服务所有站点，按请求的域名确定站点，只读取公开投影（见 `docs/zh-CN/rendering/public-projection.md`）。
后台与 API 仍由 CMS 提供，公开域名上没有任何管理入口。

实现：`apps/site-classic/src/app.ts`（路由与状态码）、`apps/site-classic/src/read-port.ts`（公开投影读取）、`apps/site-classic/src/host.ts`（可信代理与 Host）、
`apps/site-classic/src/view-model.ts`（页面数据）、`apps/site-classic/src/html.ts`（内置最小错误页）；路径解析与 CMS 共用 `packages/public-site/src/resolve-path.ts`。

## 运行

```bash
DATABASE_URL=<所有者> HEOPRESS_RENDER_PASSWORD=<密码> pnpm --filter @heopress/database app-role --render   # 迁移后创建渲染角色
DATABASE_URL=<渲染角色> pnpm --filter @heopress/site-classic start
```

| 环境变量 | 说明 |
|---|---|
| `DATABASE_URL` | 渲染角色的连接串（只能读公开投影） |
| `PORT` | 监听端口，默认 `2027` |
| `HEOPRESS_TRUSTED_PROXIES` | 可信代理的地址或 CIDR（逗号分隔）；只有来自它们的 `X-Forwarded-Host` 才被采信，且取最右一个值（最近的代理写入的值；代理若追加而不覆盖，左边的值可能来自客户端）；格式错误或前缀越界的条目被忽略 |
| `HEOPRESS_RENDER_DB_POOL` | 页面数据（未命中时的读取）的数据库连接池大小，默认 `10` |
| `HEOPRESS_RENDER_LOOKUP_DB_POOL` | 页面缓存查找与域名查找的连接池大小，默认 `4`。与页面数据分开：缓存命中不会等待未命中占用的连接 |
| `HEOPRESS_RENDER_WORKERS` | 渲染线程数（1–64），默认为本进程可用的 CPU 数减 1（留给处理缓存命中的事件循环），最少 2、最多 8。可用 CPU 按进程的 CPU 亲和性计算（容器的 `--cpuset-cpus`）；4 vCPU 的服务器默认 3 个 |
| `HEOPRESS_RENDER_HOST_MEMO_MS` | 本进程记住域名记录的时间，单位 ms（0–2000，默认 `1000`；`0` 为每个请求都读取）。删除或迁移的域名最多在这段时间内仍按原样应答，在 10 秒一致性预算之内 |
| `HEOPRESS_RENDER_CACHE_MB` | 本进程页面缓存（第一级）的大小，单位 MB，默认 `64` |
| `HEOPRESS_PREVIEW_ORIGIN` 等 | 预览配置，见 `docs/zh-CN/rendering/preview.md` |

取值不是范围内的整数时，渲染服务报错退出（不会悄悄改用默认值）。启动日志写明渲染线程数、页面缓存大小与域名记忆时间。

`DATABASE_URL` 与 `HEOPRESS_INTERNAL_SECRET` 也可以用 `DATABASE_URL_FILE`、`HEOPRESS_INTERNAL_SECRET_FILE` 指向文件（Docker secrets）。

## Docker 部署

镜像：`docker build -f docker/Dockerfile --target site-classic -t heopress-site-classic .`——只含打包后的 `dist/serve.mjs` 与主题 worker `dist/render-worker.mjs`，
监听 2027，健康检查 `GET /healthz`（只回应本机回环地址的请求；访客请求的 `/healthz` 只是站点的普通路径）。

`docker/docker-compose.yml` 包含 `site-classic` 服务（只在 Compose 网络内，不发布端口；只读根文件系统、`/tmp` 为 tmpfs、去掉全部 capabilities、`no-new-privileges`；镜像中没有 npm 等包管理器）。启动顺序：

1. CMS（API 进程，不是 worker）启动时执行迁移；设置了 `HEOPRESS_RENDER_PASSWORD`（或 `HEOPRESS_RENDER_PASSWORD_FILE`）时，接着以所有者身份创建或收紧渲染角色 `heopress_render`
   （与是否执行迁移无关；幂等，失败则 CMS 不启动；角色在别处创建时设 `HEOPRESS_SKIP_RENDER_ROLE=true`）。口令（可打印 ASCII）以 SCRAM-SHA-256 校验值发送，明文不会出现在数据库日志中；之后入口脚本从 CMS 与 worker 的进程环境中清除渲染口令与连接串（worker 也拿不到预览共享密钥）。
   使用 `docker-compose.domains.yml` 时，未配置渲染角色（又未设 `HEOPRESS_SKIP_RENDER_ROLE=true`）的 CMS 拒绝启动。
2. CMS 健康后启动 `site-classic`，以渲染角色连接（`HEOPRESS_RENDER_DATABASE_URL` 或 `_FILE`，开发默认密码 `heopress_render_dev`；生产覆盖文件不提供默认值，缺少时渲染服务拒绝启动并反复重启）。
3. 投影：迁移 0040 为所有尚未建过投影的既有站点（P06 之前的站点）写入重建标记，worker 的重建任务几秒内补齐；补齐前站点返回 503 维护页。

生产覆盖文件只在 `127.0.0.1` 上发布 CMS 端口（供本机反向代理），TLS 覆盖文件完全去掉它。必需配置见 `docker/.env.example` 的“Public sites”一节。

对外入口用 `docker-compose.domains.yml`（`docker/Caddyfile.domains`）：

| 访问 | 去向 |
|---|---|
| 管理域名（`PUBLIC_DOMAIN`） | CMS（后台、API），`/internal*` 404 |
| 站点域名、预览来源（按需签发证书，证书闸门只对已激活域名与预览来源的主机名放行） | `site-classic` |
| 站点域名与预览来源上的 `/admin*`、`/api*`、`/internal*` | Caddy 直接 404，不转发到任何服务（渲染服务自身也拒绝） |
| 证书闸门拒绝的域名 | 不签发证书（TLS 握手失败） |

`docker/scripts/smoke-caddy-routing.sh` 用 Caddy 镜像运行这份配置（以本地 CA 代替 ACME，CMS 与渲染服务用回显桩代替），逐项检查上表，CI 作业 `caddy-routing` 运行它。
只用 `docker-compose.tls.yml`（单一管理域名）时没有站点域名，公开站点需要 `docker-compose.domains.yml`。

## 请求如何处理

1. 请求目标按原样读取（不做 URL 规范化）：`/路径?查询`，或绝对形式 `http://域名/路径`（此时以其中的域名代替 `Host`）。路径首段是 `admin`、`api`、`internal`（不区分大小写）→ 404，
   任何域名、任何方法都一样，别名域名也不跳转。
2. 域名：`Host`，或可信代理给出的 `X-Forwarded-Host`。未知、待验证、已停用的域名 → 纯文本 `Not found`（404），**不回退到默认站点**。之后只接受 `GET` / `HEAD`，其他方法 405。
3. 每个请求在一个只读、可重复读的事务内读取该站点的数据（同一快照）：站点有待重建标记（或从未建过投影）→ 503（`Retry-After`），连重定向也不返回；其他站点不受影响。
4. 路径解析（与 CMS 相同的规则，见 `docs/zh-CN/i18n/locale-routing.md`）：别名域名、旧路径、重定向记录、语言前缀、结尾斜杠一次 301 到最终地址。
5. 结果：

| 结果 | 状态码 |
|---|---|
| 公开条目 | 200：文章 / 页面；分类、标签、作者页附带其文章列表 |
| 某语言的根路径 | 200：首页，该语言最新文章列表 |
| `/search`（`?q=`，按标题不区分大小写匹配） | 200，`noindex` |
| 曾公开、已删除的条目原路径 | 410 |
| 其他 | 404 |

列表每页 10 篇，`?page=N` 翻页；`page` 不是正整数、或超出最后一页 → 404。错误页不含堆栈与内部路径。

语言只由域名与路径决定：同一地址无论 `Accept-Language` 是什么，响应正文完全相同。

## 页面

页面由主题引擎渲染（见 `docs/zh-CN/rendering/theme-engine.md`）：渲染服务在读取事务内准备好页面数据，事务结束后才交给渲染池，模板运行期间不占用数据库连接。
使用站点当前生效的主题版本（见 `docs/zh-CN/rendering/theme-guide.md`），没有时使用内置主题；主题资源在 `/_theme/<版本 ID>/<SHA-256>.<扩展名>` 提供，只提供本站已发布版本的资源，带永久缓存头。页面的 `<head>` 由系统生成（见下节“页面头部与收录”）。主题渲染失败 → 500 与该站点的错误页；渲染池已满 → 503（`Retry-After`）。

## 页面头部与收录（P07）

`{% seo_head %}` 输出的内容由 SEO 数据层 `@heopress/seo-geo` 计算，渲染服务只负责转义与序列化。渲染后 HTML 中的标题、canonical、robots、hreflang、
社交元数据与 JSON-LD 和数据层对象逐项一致，由快照测试 `apps/site-classic/src/__tests__/head-snapshot.test.ts` 保证（快照的变化即头部输出的变化，需随评审提交）：

- **标题**：站点的标题模板（`{title}`、`{site}`，默认 `{title} · {site}`）；条目填了 SEO 标题时直接用它；首页为站点名称。
- **描述**：SEO 描述，否则摘要；站点的描述模板（`{description}`、`{title}`、`{site}`）只在有描述时套用。
- **canonical**：页面在主域名下的绝对地址；条目的 `canonical_url` 是绝对 http(s) 地址时以它代替。不可收录的页面不输出 canonical。
- **robots**：按“站点默认 → 页面类型默认（首页、条目、分类标签作者页）→ 集合默认 → 条目自身的收录设置”依次决定，搜索页与错误页始终不收录。
  可收录页面带站点的摘要与预览指令（`max-image-preview` 默认 `large`）；不可收录页面只有 `noindex`（及 `nofollow`），并带同样内容的 `X-Robots-Tag` 响应头（随缓存应答在 200、HEAD、304 上一致回放）。
- **条目的收录设置**（`seo_robots`）：`index,follow`（默认）跟随上面的默认值；`index` 无论默认值都收录；`noindex,…` / `…,nofollow` 按字面生效。
  分类、标签、作者自预设第 2 版起也有该字段（已有站点在预设升级后获得）。
- **hreflang**：翻译组中已发布且可收录的成员（含自身）与组的 x-default，跨站成员只在双方开启跨站翻译时出现；页面自身不可收录时不输出（见 `docs/zh-CN/i18n/translation-groups.md`）。
- **社交元数据**：Open Graph（类型、标题、描述、地址、站点名、语言、绝对地址的图片、文章发布时间与修改时间）与 `twitter:card`。
  修改时间是已发布内容的真实修改时间（见 `docs/zh-CN/rendering/public-projection.md`“真实修改时间”），不是条目行的更新时间。
- **列表页**：可收录的首页、分类、标签、作者列表的第 N 页（N > 1）canonical 指向自身（`…?page=N`）；超出最后一页（或页码无效）返回 404；站内搜索结果页始终 `noindex`、不输出 canonical。

- **结构化数据**（JSON-LD）：每个页面只有一个 `<script type="application/ld+json">`，其中是一个图，节点以稳定的 `@id` 互相引用：
  站点身份（`<站点根>#identity`，见下）、WebSite（`<该语言首页>#website`）、WebPage（`<页面地址>#webpage`；分类、标签、作者页为 CollectionPage）、
  面包屑（`#breadcrumb`：首页 → 文章的主分类 → 文章，或首页 → 分类页）与文章（`#article`，站点类型为 `news` 时 NewsArticle、`blog` 时 BlogPosting，其他为 Article，
  含标题、描述、发布与真实修改时间、作者与发布者），主图片为一个 `#primaryimage` 节点；条目填写了问答字段时另有 FAQPage（`#faq`，最多 50 个问题），只来自该字段。作者取文章公开的作者条目；个人站点没有作者时为站点身份本人；其他情况不写作者。
  不可收录的页面（含 noindex、canonical 指向别处的页面、搜索与错误页）只描述站点：站点身份与 WebSite。JSON 中的 `<`、`>`、`&` 与行分隔符都转义，任何值都结束不了脚本。
- **贡献的结构化数据**（P07 任务 2.9、2.10）：图中还可以有两类贡献节点，都由 CMS 校验后物化进公开投影（渲染服务不加载扩展代码）：
  - 条目自己的结构化数据（预设第 4 版的 `structured_data` 字段，JSON-LD 文本：一个节点、节点列表，或带 schema.org `@context` 的节点 / `@graph`）。
    节点用 `#名称`（或本页地址加 `#名称`）命名，未命名的得到 `#custom-<序号>`；页面通过 WebPage 的 `about` 引用它们。
  - 扩展的贡献（契约 `StructuredDataContribution`，写在扩展清单的 `structuredData` 中，安装时校验）：扩展在站点上启用并被授予 `seo:structured-data` 能力时生效。
    `scope: "item"` 的节点出现在指定集合（`collections`，缺省为全部）条目的页面上，值 `{ "$field": "<字段>" }` 取该条目的公开字段；
    `scope: "site"` 的节点在站点每个可收录页面上相同，不能取条目字段。每个扩展至多 8 个贡献，每个节点至多 4096 字节。
    扩展的安装、启用、升级、停用、卸载经投影闸门在同一事务中重新物化该站点的贡献并提升渲染版本，缓存的页面随之更新；贡献带指纹，按条目应用。
  语法限制：`@type` 必须是 schema.org 类型名；除 `@type`、`@value`、`@language` 与引用（只有 `@id` 的对象）外的关键字、不是属性名的键、嵌入节点自带的 `@id`
  都被移除；嵌套最多 8 层、列表最多 100 项、文本最多 10000 字符；条目的结构化数据至多 16 KB、10 个节点；扩展的条目节点填入字段值后至多 8 KB；每个页面上本页的贡献节点合计至多 64 KB，站点节点另计至多 64 KB（两者互不占用）。
  **最终资格检查**在全部贡献合并后进行：节点的 `@id` 与归属由核心决定（贡献方写的 `@id` 被忽略，条目指向别处地址的节点被拒绝），站点身份类型由核心认定；
  核心才写的类型（WebSite、各类页面、FAQPage、BreadcrumbList）或页面已有的类型（如它的文章）、已被占用的 `@id` 都按冲突处理，节点不重复输出；
  站点级节点不得带条目字段的值（例如把一篇不可收录文章的正文放进自称站点级的节点），这些字段被移除；站点节点不能是文章类型，
  它只能引用站点身份与其他站点节点（不引用页面节点或各语言首页的 WebSite），因此在每种语言的每个页面上都相同；每页至多一个文章节点；
  不可收录的页面与 canonical 指向别处的页面不输出任何贡献节点；
  指向被移除节点或本页不存在节点的引用一并清理。每项移除都留下诊断（同一项只记一次），站点管理员可在 Studio 的“设置 → Content”底部或
  `GET /api/v1/site/structured-data` 查看扩展的站点节点、被拒绝的贡献与各页面的诊断。
- **站点身份**：站点代表的主体——组织、个人或本地商家——及其名称、标志（个人为头像）、邮箱、电话、地址与官方资料链接（`sameAs`），
  由站点管理员在 Studio 的“设置 → Identity”填写（新建站点后先进入这一页），API 为 `GET / PUT /api/v1/site/identity`（`{ ...身份, version }`，版本过期返回 409）。
  身份节点只含填写了的字段，未设置身份时不输出身份节点，也不写发布者——不编造。身份随投影写入 `lumibase_public_sites.identity`，渲染角色读不到原表。

站点 SEO 设置改动后立即生效：设置写入公开快照并递增该站点的渲染版本，旧缓存不再命中。

**发现输出的统一过滤**：sitemap、订阅源、llms.txt 等发现文件的条目由同一函数生成（`discoveryPageOf`，再经 `@heopress/seo-geo` 的 `sitemapEntry` / `feedEntry` / `llmsEntry`），
它使用与页面头部相同的收录判定、描述与 hreflang 成员，修改时间取真实修改时间。不可收录的页面在所有发现输出中都没有条目，但页面本身照常可抓取（带 `noindex`），
抓取者才能读到这一指令；canonical 指向别处的页面是声明的副本，同样不列出；搜索结果页不是条目，不进入任何发现输出。noindex 与 robots 只是给遵守协议的客户端的信号，不是访问控制。

## 发现文件（P07）

发现文件由渲染服务按站点、按域名生成，与页面一样经页面缓存（缓存键含站点渲染版本，发布、下架、改设置都会提升版本，下一次请求即重新生成，所以发布后立即出现）。
每个域名只列出地址在该域名上的页面（sitemap 协议的要求）：子目录语言的页面在主域名上列出，语言入口域名只代为应答、不重复列出；别名域名先 301 到主域名。

| 路径 | 内容 | 类型 |
|---|---|---|
| `/sitemap.xml` | sitemap 索引：各分片（及开启时的新闻 sitemap），每项带该分片最新的 `lastmod` | `application/xml` |
| `/sitemap-<N>.xml` | 分片：每片至多 10,000 条（低于协议上限 50,000）且至多 45 MiB（低于协议上限 50 MiB；语言关联多的页面先达到字节上限）；先是可收录的各语言首页，再按语言与路径列出可收录页面，`lastmod` 为真实修改时间，带语言关联（`xhtml:link`）；超出最后一片为 404 | `application/xml` |
| `/sitemap.txt` | 每行一个地址，至多 50,000 个 | `text/plain` |
| `/feed.xml`、`/atom.xml` | 站点的 RSS 2.0 / Atom：站点默认语言最新 20 篇可收录文章，全文（`content:encoded` / `content`）中的链接都转为绝对地址 | `application/rss+xml` / `application/atom+xml` |
| `/feed/pages.xml`、`/atom/pages.xml` | 集合级订阅源（站点订阅源已是文章，所以集合级只有 `pages`） | 同上 |
| `/feed.<语言>.xml`、`/atom/pages.<语言>.xml` 等 | 其他语言的订阅源：语言须与站点语言的写法完全一致，且不是默认语言 | 同上 |
| `/llms.txt` | 站点名称与简介、页面（`pages`，按标题，至多 50）、最近文章（至多 30）与发现文件（订阅源、sitemap、新闻 sitemap、`llms-full.txt`）的链接，Markdown 格式；站点关闭 `discovery.llms` 时 404 | `text/plain` |
| `/llms-full.txt` | 同样的开头，再逐篇给出页面与最新文章的 Markdown 全文（标题、描述、地址、发布与修改时间、正文），至多 200 篇、5 MB | `text/plain` |
| `/robots.txt` | 爬虫策略（见下）、本域名的 sitemap 索引与新闻 sitemap（开启时）、默认语言的订阅源（注释行） | `text/plain` |
| `/<文件名>` | 站点根文件（见下），按扩展名决定类型 | 见下 |
| `/news-sitemap.xml` | 新闻 sitemap（站点开启时）：最近 48 小时内首次发布的可收录文章（至多 1,000 篇），出版物名称（未填时为站点名）、语言（ISO 639，中文为 `zh-cn` / `zh-tw`）、发布时间与标题 | `application/xml` |

- 每个页面的 `<head>` 用 `<link rel="alternate">` 声明本语言的 RSS 与 Atom（站点关闭订阅源时不声明，订阅源路径返回 404）。
- 每个订阅源只有一个地址：订阅源的语言只由路径决定（与应答的域名无关），默认语言不带后缀，其他写法（大小写不同、默认语言带后缀、`/rss.xml`、`/feed/articles.xml`）都是 404，
  因此不同地址不会生成相同内容的多个缓存条目。
- 新闻 sitemap 的应答带过期时间：最早一篇文章离开 48 小时窗口（或下一篇定时文章进入窗口）的时刻，进程内缓存与共享缓存都不在此之后使用它；文章离开窗口后仍在普通 sitemap 中。
- XML 中的值全部转义，并去掉 XML 1.0 不能容纳的字符。测试用 libxml2（`xmllint-wasm`）按本项目依据各协议编写的 XML Schema 校验 sitemap、新闻 sitemap、RSS 与 Atom。

页面缓存、`ETag` / 304 与失效机制见 `docs/zh-CN/rendering/page-cache.md`；草稿与主题预览（只在预览来源上提供）见 `docs/zh-CN/rendering/preview.md`。

### 爬虫策略与 robots.txt（P07 任务 3.2）

已知爬虫清单在 `packages/seo-geo/src/crawlers.ts`（名称、运营方、用途、文档链接，随版本更新），用途分为训练（`training`）、AI 搜索（`search`）、
用户触发抓取（`user-fetch`）与普通搜索引擎（`search-engine`）。站点 SEO 设置的 `crawlers` 部分：

- `purposes`：按用途允许或禁止（未设置为允许）；普通搜索引擎不受用途影响；
- `overrides`：按单个爬虫（清单 ID 或自定义 ID）覆盖，优先于用途；
- `custom`：站点自己的爬虫（ID、robots 中的产品标记——只允许字母、数字、`.`、`_`、`-`，不能换行——与用途），至多 50 个；ID 或产品标记（不区分大小写）与已知清单或另一个自定义爬虫相同时，整个设置更新返回 400（自定义爬虫不能借用途规则挡住某个已知爬虫）；
- `contentSignal`：开启时在 `User-agent: *` 组中输出 `Content-Signal: search=yes, ai-input=<AI 搜索>, ai-train=<训练>`。

`robots.txt` 先是对所有爬虫的 `Allow: /`，再把所有被禁止的爬虫放在一组 `Disallow: /` 中，最后是 `Sitemap:` 行与订阅源注释。设置修改立即生效（渲染版本随之提升）。

### 站点根文件（P07 任务 3.8）

站点管理员可在 Studio 的“设置 → Root files”或 `GET / PUT / DELETE /api/v1/site/root-files/<文件名>` 管理站点根路径上的文本文件（`PUT` 的正文为文件文本本身，`Content-Type: text/plain`，SDK 采用此方式；也可为 JSON `{ "content": "…" }`。两种方式都在读取时按上限截断，不受全局 JSON 正文上限影响），
如搜索引擎验证文件、`ads.txt`、`app-ads.txt`、`manifest.webmanifest`：

- 文件名：一个路径段，字母、数字、`.`、`_`、`-`，不以 `.` 开头（没有 `.env`、`.git`），扩展名为 `txt`、`html`、`htm`、`xml`、`json`、`webmanifest` 之一；
  类型由扩展名决定（写入者不能指定）；
- 系统生成的文件名（`robots.txt`、`sitemap*.xml`、`sitemap.txt`、`news-sitemap*.xml`、`llms*.txt`、订阅源、IndexNow 密钥文件 `<32 位十六进制>.txt`）一律拒绝（409）；
- 只能是文本（不含制表、换行、回车以外的控制字符），至多 512 KB，每站至多 100 个；
- 应答带 `X-Content-Type-Options: nosniff` 与 `Content-Security-Policy: sandbox; default-src 'none'`；
- 写入与删除记入站点审计日志（`root_file_written`、`root_file_deleted`），并经投影闸门提升渲染版本，修改立即生效。
  渲染角色只能通过视图 `lumibase_render_root_files` 读取当前站点的文件名、类型、内容与哈希。

### IndexNow（P07 任务 3.4、3.6）

站点在 SEO 设置中开启 `discovery.indexNow` 后，CMS 生成一个 32 位十六进制的密钥（`discovery.indexNowKey`，之后保留；随设置公开），
渲染服务在站点的每个域名上以 `/<密钥>.txt` 提供它（关闭时 404；根文件不能使用这个名字）。推送端点从官方端点中选择（`discovery.indexNowEndpoint`，默认 `https://api.indexnow.org/indexnow`），
不能填写任意地址。

- **何时推送**：文章或页面发布、内容（标题、摘要、正文）修改、改路径（新旧地址都推送）、改为不收录、下架、删除。只换主题、只改 SEO 字段不推送。
  开启时已公开的内容只记为基线，不推送；关闭期间的变化在重新开启后推送。
- **怎样推送**：事件消费者只把站点放入持久队列（同一事件只入队一次）；worker 每 5 秒处理到期的站点（变更后等待 10 秒，合并一批），
  比较公开投影中可列出的地址（可收录、canonical 指向自身）及其内容指纹与上次推送的记录，得出新增、修改与需要撤回的地址；
  每个请求只含一个域名的地址、至多 10,000 个，地址必须属于该站点当前的公开域名；不跟随跳转。同一站点同时只有一个 worker 处理（租约）。
- **失败与补推**：非 200 / 202 的应答或超时（结果未知）不更新记录，队列行延后重试（30 秒起翻倍，至多 1 小时）；
  每 15 分钟为所有开启 IndexNow 的站点排一次对账，事件丢失的变化也会被比较出来并推送。
  每个站点最近一次的结果记录在 `lumibase_indexnow_sites`（时间、状态、错误、累计推送地址数）。

### Markdown 副本（P07 任务 4.2）

站点开启 `discovery.markdownCopies`（默认开启）时，可收录且 canonical 指向自身的文章与页面在“去掉结尾斜杠加 `.md`”的地址上提供 Markdown 副本
（`/2026/10/hello/` → `/2026/10/hello.md`）：标题、描述、地址、发布与修改时间，然后是正文（富文本转换为 Markdown，链接与图片为绝对地址）。

- 响应类型 `text/markdown; charset=utf-8`，带 `X-Robots-Tag: noindex` 与 `Link: <页面地址>; rel="canonical"`（200、HEAD、304 相同）；
- HTML 页面的 head 声明 `<link rel="alternate" type="text/markdown" href="….md">`，不可收录或 canonical 指向别处的页面不声明，也没有副本（404）；
- 真实路由优先：路径本身是条目，或会跳转到一个条目（如结尾斜杠、旧路径），或是已删除页面的 410，都按原样应答，不提供副本；
- 站点关闭副本后 `.md` 地址 404，HTML 不再声明。


# SEO / GEO 功能说明

HeoPress P07（任务 6.3）。本文逐项说明站点 SEO / GEO 设置与相关功能的效果和限制。

**先说清楚：这些功能让页面更容易被抓取、解析与理解，不承诺任何排名、收录或被 AI 引用。** 搜索引擎和 AI 系统是否收录、如何排序、是否引用，由它们自行决定；
本系统输出的是标准、可核验的信号（canonical、robots 指令、结构化数据、sitemap 等），以及帮助你发现问题的报告。

设置保存在 `lumibase_site_seo_settings`，接口为 `GET|PUT /api/v1/site/seo-settings`（读取：站点成员；修改：管理员），字段定义见
`packages/contracts/src/schemas/site-seo-settings.ts`。修改后站点的公开输出立即按新设置生成（渲染缓存随站点版本更换）。

## 标题与描述模板

| 设置 | 效果 | 限制 |
|---|---|---|
| `titleTemplate` | 页面 `<title>` 的模板，可用 `{title}`、`{site}`；留空为 `{title} · {site}` | 条目填写了 SEO 标题时直接使用 SEO 标题，不套模板；首页标题为站点名称 |
| `descriptionTemplate` | 描述的模板，可用 `{description}`、`{title}`、`{site}` | 条目没有描述（SEO 描述、摘要、描述都为空）时不输出描述，不会只输出模板 |

模板不含 `{title}` 或 `{description}` 时，所有页面的标题或描述会相同，站点审计会报告 `meta/duplicate-title` / `meta/duplicate-description`。

## 收录

| 设置 | 效果 | 限制 |
|---|---|---|
| `index.site` | 站点默认是否允许收录 | 关闭后页面输出 `noindex`，这不是访问控制：页面仍可被访问 |
| `index.collections` | 按集合覆盖站点默认 | 条目自己的 `seo_robots` 优先于集合与站点默认 |
| `index.pageTypes` | 按页面类型（首页、条目、分类）覆盖 | 搜索页与错误页永远不收录，不受设置影响 |

不可收录的页面同时带 `X-Robots-Tag` 响应头，不进入 sitemap、feed、llms、Markdown 副本与 IndexNow。声明了指向别处的 canonical 的页面视为重复页，同样不列出。
**robots 与 noindex 不构成隐私或访问控制**：不想公开的内容不应发布。

## 摘要与预览指令

`snippet.maxSnippet`、`snippet.maxImagePreview`（默认 `large`）、`snippet.maxVideoPreview` 写入可收录页面的 robots 指令。是否采纳由搜索引擎决定。

## 爬虫策略（robots.txt）

| 设置 | 效果 | 限制 |
|---|---|---|
| `crawlers.purposes` | 按用途（训练、AI 搜索、为用户抓取）允许或禁止已知 AI 爬虫 | 普通搜索引擎不受用途影响，只受单独覆盖影响 |
| `crawlers.overrides` | 按爬虫 ID 单独允许或禁止 | 覆盖优先于用途 |
| `crawlers.custom` | 追加本站自己的爬虫（ID、产品标记、用途） | 不能与已知清单的 ID 或产品标记重名 |
| `crawlers.contentSignal` | 在 `robots.txt` 中输出 Content-Signal 行 | 这是一种声明，是否遵守取决于爬虫 |

`robots.txt` 只是请求，**不阻止不遵守它的抓取**。已知爬虫清单见 `packages/seo-geo/src/crawlers.ts`，随版本更新。

## 发现文件

| 设置 | 效果 | 限制 |
|---|---|---|
| `discovery.feeds` | RSS / Atom feed（`/feed.xml`、`/atom.xml` 及按集合、按语言的 feed） | 只含可收录的页面 |
| `discovery.llms` | `/llms.txt` 与 `/llms-full.txt` | 每个列表最多查看最近发布的 2,000 条候选；`llms.txt` 不是搜索引擎或 AI 系统承诺读取的标准 |
| `discovery.markdownCopies` | 每个可收录条目页的 Markdown 副本（`/<路径>.md`），响应带 `X-Robots-Tag: noindex` 与指向页面的 canonical | 真实存在的 `.md` 路由优先；副本无法承载嵌入内容（iframe、视频等），站点审计会提示 |
| `discovery.newsSitemap` / `newsPublicationName` | 新闻 sitemap（`/news-sitemap.xml`，最近两天的文章） | 只对新闻类站点有意义 |
| `discovery.indexNow` / `indexNowEndpoint` | 发布、更新、下架、改路径、删除时通过 IndexNow 通知（只发往官方端点，密钥文件在站点根路径） | 只是“请来抓取”的通知；不支持 IndexNow 的搜索引擎不会因此加快 |

sitemap（`/sitemap.xml`、分片与 `/sitemap.txt`）总是生成，只含可收录、canonical 指向自身的页面。站点根文件（验证文件、`ads.txt`）在“设置 → Root files”管理。

## 结构化数据（JSON-LD）

系统为每个页面生成一份 JSON-LD 图（站点身份、页面、面包屑、作者、FAQ 等），并合并条目自定义的结构化数据与扩展的贡献；无效或不允许的部分会被剔除并在
“结构化数据报告”与站点审计（`jsonld/invalid`）中说明。主题不能自行输出 JSON-LD。结构化数据帮助解析，**不保证富结果展示**。

## 站点审计、站内链接与变更影响

见 `docs/zh-CN/seo/links-and-audit.md`：可清零的问题清单（稳定规则编号）、失效链接与孤立内容、下架 / 删除 / 改路径前的影响预览。

## 线上可达性体检（设置 → Reachability）

设置只说明了站点“应该”输出什么；CDN、反向代理、防火墙与静态托管平台可能改掉响应。体检向站点的线上域名实际发出请求，与设置推导出的预期结果逐项比对：

- **只针对已验证域名**：只能体检本站已验证且启用、承载页面的域名（主域名与语言入口域名，最多 5 个）。未绑定、待验证、已停用、属于其他站点的域名，以及只做跳转的别名，
  一律拒绝（`422 DOMAIN_NOT_VERIFIED`）；运行时再核对一次，期间被停用的域名跳过、不发请求。
- **预期结果**由最终收录资格、站点开关与部署平台的支持情况生成：`robots.txt`、sitemap（`/sitemap.xml`、`/sitemap.txt`）总是应可访问；
  `llms.txt` / `llms-full.txt`、feed、新闻 sitemap、Markdown 副本按开关判断，关闭时应**不公开**（返回 404 等非 2xx 即为正常，不报告为故障）。
  此外抽样首页、最多 2 个可列出的页面及其 Markdown 副本、1 个不可收录页面：可收录页面应返回 HTML 且不带 noindex；不可收录页面应**正常返回 200 并带 noindex**
  （`X-Robots-Tag` 或 robots meta；页面有多个 robots / googlebot meta 标签时，任何一个含 noindex 即视为 noindex），它的 Markdown 副本应不存在——“可访问”与“可被发现”分开判断。
  副本地址被其他路由占用的页面不检查副本（站点审计的 `markdown/address-taken` 会报告）。
  每个被体检的域名都按**它自己的地址**抽样：子目录策略下的语言入口域名也回答该语言的内容路径（如 `fr.example.com/salut/`，其 canonical 在主域名的 `/fr/salut/`），
  因此入口域名同样检查首页、页面、不可收录页面与模拟爬虫；Markdown 副本只在 canonical 地址提供，入口域名上的 `.md` 地址应不公开。
  样本按语言分别选取：对被检域名所服务的每种语言（有自己入口域名的语言优先，最多 20 种）各查看最近发布的 100 条，
  因此即使主语言发布量远大于其他语言，入口域名仍能抽到本语言的页面；不可收录页面的样本只在这些候选中寻找，找不到时不检查。
- **会报告的问题**：无法访问、404、错误状态码、被跳转、被挑战页拦截、响应类型错误（例如 `.md` 副本以 `application/octet-stream` 返回）、
  可收录页面带 noindex、不可收录页面缺少 noindex、已关闭或不合资格的内容仍被返回（多为 CDN 缓存或旧部署残留）、线上 `robots.txt` 与站点爬虫策略不一致（例如 CDN 托管的 robots.txt）。
- **AI 爬虫模拟请求**：以 GPTBot、OAI-SearchBot、ChatGPT-User、ClaudeBot、Claude-SearchBot、Claude-User、PerplexityBot、Perplexity-User、CCBot 的 User-Agent 请求首页，
  与普通浏览器请求的结果比较。robots 允许但被 403 / 挑战页拦截时报告“robots 允许但被拦截”；站点本就禁止的爬虫被拦截不算故障。
  **这些都是模拟结果，可能与真实爬虫不同**：请求来自 HeoPress 服务器而不是爬虫运营方的地址，CDN 可能按来源地址区别对待。
  爬虫请求没有应答（超时、连接中断）而浏览器请求正常时，会再请求一次；仍无应答记为“无法判断”（inconclusive），不报告为拦截。
- **AI 爬虫访问量骤降提示**：结合 AI 流量统计，某个站点允许的 AI 爬虫在最近 3 个完整日之前的 14 天中至少 7 天有访问，并且最近 3 个完整日为零（stopped），
  或最近 3 天的日均访问降到原来的五分之一或以下（含恰好五分之一；“原来”按它**有访问的日子**计算日均，且至少每天 5 次）时（dropped），
  提示可能被 CDN 或防火墙拦截。当天不计入。站点 robots 禁止的爬虫访问减少属于预期，不提示。
- **修复建议**按所选部署平台给出：自有服务器（Caddy / Nginx）、Cloudflare 代理、Cloudflare Pages、Vercel、Netlify。例如类型错误会给出该平台设置响应头的写法
  （Cloudflare Pages / Netlify 的 `_headers`、Vercel 的 `vercel.json`、Caddy 的 `header` 指令），爬虫被拦截会指向该平台的机器人与防火墙设置。

运行方式：管理员在“设置 → Reachability”选择域名与部署平台后点击 “Run check”（`POST /api/v1/site/reachability/run`，正文 `{ hosts?, platform? }`；无正文即体检全部可体检域名，正文不是 JSON 对象时返回 `400 VALIDATION`），后台任务在一分钟内执行；
同一站点两次体检至少间隔一分钟。报告（`GET /api/v1/site/reachability`，站点成员可读）只保留最近一次，存于 `lumibase_reachability_reports`。SDK 为
`client.site.reachability()` 与 `client.site.runReachability()`。

安全与限制：所有请求都经过出站 SSRF 防护（连接时校验地址，解析到内网或云元数据地址的域名被拒绝并在报告中说明；不带凭据与 Cookie；单次请求 10 秒超时；不跟随跳转），
逐个发出、间隔 250 毫秒，单次体检最多 4 分钟，超时后剩余请求标为“未请求”。体检只说明当时从 HeoPress 服务器看到的结果，不能证明搜索引擎或 AI 爬虫一定能访问或收录。

实现：`packages/seo-geo/src/reachability.ts`（预期结果、判定、模拟爬虫、访问量提示、平台建议）、`apps/cms/src/services/site-network/reachability.ts`（请求、租约与报告）。

## AI 流量（设置 → AI traffic）

- 渲染服务识别已知 AI 爬虫（按 User-Agent 中的产品标记，包括名称不含 “bot” 的，如 `ChatGPT-User`、`Perplexity-User`；清单见 `packages/seo-geo/src/crawlers.ts`，
  普通搜索引擎不计入）与 AI 助手的引荐（按 referrer 主机；只有没有 referrer 时才看 `utm_source`，且只认助手自己的域名，如 `utm_source=chatgpt.com`；
  助手清单见 `packages/seo-geo/src/ai-traffic.ts`），按站点、按天、按用途、按页面计数；缓存命中也计入，`llms.txt`、`robots.txt`、sitemap、Markdown 副本与 feed
  分别计入其资源类型。返回 4xx / 5xx 的访问统一计在 `(not found)` 下；每个站点每天最多记录 10,000 个不同路径（不论哪个爬虫读取），之后的新路径计在 `(other)` 下。只记录清单中的爬虫与助手。
- **隐私**：不保存访客 IP、User-Agent、referrer 或查询串。访客地址只保存为假名化的哈希：渲染进程启动时生成、从不保存的密钥对“日期、主机、地址”做 HMAC，
  无法还原出地址，但同一天、同一主机的多次访问会得到相同的哈希（可以看出是同一访客的多次访问，不能看出是谁）。明细保留 7 天后删除，按天汇总长期保留，
  汇总中不含哈希。预览请求、管理路径与查询中带令牌的请求不记录。
- **权限**：只有站点成员能查看本站数据（`GET /api/v1/site/ai-traffic`）；渲染服务的数据库角色只能通过受校验的写入函数记录访问（使用独立的小连接池，写入有超时，
  过多时直接丢弃），不能读写分析表本身。
- **限制**：伪装成浏览器的爬虫无法识别，伪装成 AI 爬虫的请求也会被计入；被识别的访问量说明“被读取”，不等于“被引用”或带来流量。

实现：`apps/site-classic/src/ai-traffic.ts`（渲染端识别与记录）、`apps/cms/src/services/site-network/ai-traffic.ts`（查询与清理）、
`packages/database/drizzle/0088_record_crawl_hit_known_agents.sql`（受限写入函数的当前版本）。

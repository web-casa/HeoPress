# rendering/markdown-negotiation Specification

## Purpose
定义公开站点同一 URL 的 Markdown 内容协商：站点如何开启、`Accept` 如何判定、协商应答带哪些头、
缓存与条件请求如何区分两个变体，以及哪些应答永远不受 `Accept` 影响。静态部署目标（Cloudflare Pages、
Netlify、Vercel）的边缘协商是另一个 change，本规格不覆盖。

## Requirements

### Requirement: 站点开关与默认关闭

站点 SHALL 有一个 Markdown 内容协商开关（`site-seo-settings` 的 `discovery.markdownNegotiation`），默认 `false`。
该开关 MUST 与其他 SEO 设置经同一个设置接口读写，MUST NOT 需要额外的端点或表单才能生效。
开关关闭时，任何 `Accept` 头 MUST 得到与开启该能力之前完全相同的应答：同样的状态码、正文与响应头，
MUST NOT 出现 `Vary`，MUST NOT 出现 `text/markdown` 的应答。
打开或关闭开关 MUST 在下一次请求生效，MUST NOT 继续返回按旧开关缓存的应答。

#### Scenario: 默认关闭

- **WHEN** 站点没有设置 `discovery.markdownNegotiation`，请求页面地址并带 `Accept: text/markdown`
- **THEN** 返回 HTML，响应没有 `Vary` 头，也没有 `text/markdown` 的内容类型

#### Scenario: 打开开关后立即生效

- **WHEN** 站点把 `discovery.markdownNegotiation` 设为 `true` 后再次请求同一地址并带 `Accept: text/markdown`
- **THEN** 返回该页的 Markdown，而不是按旧开关缓存的 HTML

### Requirement: 同一地址按 Accept 返回 Markdown

站点开启协商、且请求的 `Accept` 明确包含 `text/markdown` 并把它的质量值严格排在 HTML 之前时，
该页自己的地址 SHALL 返回该页的 Markdown 正文。正文 MUST 与同一页 `.md` 副本的正文相同
（标题、描述、地址、发布时间与修改时间，然后是正文）。
`Accept` 缺失、为空、格式错误、只含通配（`*/*`、`text/*`）、`text/markdown` 与 `text/html` 优先级相同、
或 `text/markdown` 的质量值为 `0` 时，MUST 返回 HTML。
`Accept` 中的大小写与 `q` 参数的其他参数（例如 `charset`）MUST NOT 改变判定。

#### Scenario: 明确请求 Markdown

- **WHEN** 站点开启协商，请求头为 `Accept: text/markdown, text/html;q=0.5`
- **THEN** 返回该页的 Markdown 正文，与请求该页 `.md` 地址得到的正文相同

#### Scenario: 更高的 q 值

- **WHEN** 请求头为 `Accept: text/html;q=0.5, text/markdown;q=0.9`
- **THEN** 返回该页的 Markdown 正文

#### Scenario: 浏览器默认请求

- **WHEN** 请求头为 `Accept: */*`，或请求不带 `Accept`
- **THEN** 返回 HTML

#### Scenario: 并列优先级与畸形请求头

- **WHEN** 请求头为 `Accept: text/markdown, text/html`、`Accept: text/markdown;q=0.5, text/html;q=0.5`
  或 `Accept: text/markdown;q=abc`
- **THEN** 返回 HTML

### Requirement: 协商应答的头

Markdown 应答 MUST 是 `Content-Type: text/markdown; charset=utf-8`，并带 `X-Robots-Tag: noindex` 与
`Link: <页面地址>; rel="canonical"`（页面地址是该页面的规范地址）。
Markdown 应答与同一页的 HTML 应答 MUST 都带 `Vary: Accept`（仅当站点开启协商且该页可协商时）。
两个变体的 `ETag` MUST 不同；`If-None-Match` 匹配同一变体时 MUST 返回 304，且 304 MUST 回放与 200 相同的表示头；
`HEAD` MUST 回放与 `GET` 相同的状态与头。

#### Scenario: 四个响应头

- **WHEN** 站点开启协商，请求一个可收录条目页并带 `Accept: text/markdown`
- **THEN** 响应头含 `text/markdown; charset=utf-8`、`X-Robots-Tag: noindex`、指向页面 canonical 的 `Link` 与 `Vary: Accept`

#### Scenario: HTML 变体也带 Vary

- **WHEN** 同一页在开启协商时以 `Accept: text/html` 请求
- **THEN** 返回 HTML，且响应带 `Vary: Accept`

#### Scenario: 条件请求

- **WHEN** 用 Markdown 应答的 `ETag` 作为 `If-None-Match` 再次请求同一地址并带 `Accept: text/markdown`
- **THEN** 返回 304，且 `Vary`、`X-Robots-Tag` 与 `Link` 与 200 相同

### Requirement: 缓存按变体分离

页面缓存 MUST 把表示形式作为键的一部分：先缓存的 HTML MUST NOT 回答 Markdown 请求，先缓存的 Markdown
MUST NOT 回答 HTML 请求；两个方向 MUST 各自命中自己的条目。
一个地址的缓存条目 MUST 最多两个（HTML 与 Markdown），MUST NOT 随 `Accept` 头的具体写法增长。

#### Scenario: 先 HTML 后 Markdown

- **WHEN** 站点开启协商，同一地址先以 `Accept: text/html` 请求，再以 `Accept: text/markdown` 请求
- **THEN** 第二次返回 Markdown 正文与 `text/markdown` 类型，不是第一次缓存的 HTML

#### Scenario: 先 Markdown 后 HTML

- **WHEN** 同一地址先以 `Accept: text/markdown` 请求，再以 `Accept: text/html` 请求
- **THEN** 第二次返回 HTML，不是第一次缓存的 Markdown

### Requirement: 只协商页面

只有可收录且 canonical 指向自身的条目页 SHALL 协商。下列应答 MUST 与 `Accept` 无关（与不发送 `Accept` 时相同）：
404、301、410、503、搜索页、列表页（首页、分类、标签、作者与插件列表页）、订阅源与 sitemap 等发现文件、
`.md` 副本地址，以及不可收录或 canonical 指向别处的条目页。

#### Scenario: 404、301 与 410 忽略 Accept

- **WHEN** 站点开启协商，对不存在的路径、会重定向的路径与已删除条目的原路径分别发送 `Accept: text/markdown`
- **THEN** 分别得到 404、301 与 410，响应体与不发送 `Accept` 时相同，且不是 `text/markdown`

#### Scenario: 搜索页与订阅源忽略 Accept

- **WHEN** 站点开启协商，对搜索页与 `/feed.xml` 发送 `Accept: text/markdown`
- **THEN** 搜索页仍是 HTML，订阅源仍是 RSS，内容类型都不变成 `text/markdown`

#### Scenario: `.md` 副本地址不受影响

- **WHEN** 站点开启协商，对某页的 `.md` 地址发送 `Accept: text/html`
- **THEN** 仍返回该页的 Markdown 副本（`text/markdown`、`noindex` 与 canonical `Link`），与不发送 `Accept` 时相同

#### Scenario: 不可收录的条目页不协商

- **WHEN** 一个条目的收录设置是 `noindex`（或它的 canonical 指向别的地址），请求它的地址并带 `Accept: text/markdown`
- **THEN** 返回 HTML，响应没有 `text/markdown` 的内容类型

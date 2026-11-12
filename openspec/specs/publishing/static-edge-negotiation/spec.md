# publishing/static-edge-negotiation Specification

## Purpose
让静态目标（Cloudflare Pages、Vercel、Netlify、Caddy 后面的 VPS）在页面**自己的地址**上兑现 Classic 引擎的 Markdown 内容协商承诺，
并如实说明每个目标的表达方式与限制：可收录、canonical 指向自身的页面在 `Accept` 偏好 Markdown 时返回该页 `.md` 副本的内容与表示头，
两个变体都带 `Vary: Accept`。配置型目标（Vercel、VPS）只能按请求头文本匹配，据此保守降级；代码型目标（Cloudflare Pages 的
Pages Function、Netlify 的 Edge Function）逐例实现运行时规则，其前提（平台执行 `_worker.js`；Netlify 打包 Edge Functions 并读取
生成的 `netlify.toml`）写在支持矩阵的说明与部署后体检里。

本能力**扩展**静态响应契约（`publishing/frontend-deployments`）：契约继续负责每个文件的类型、`noindex`、副本的 canonical `Link`、
301 与 410，并新增 `markdown-negotiation` 特性、协商规则与预算。`markdown-canonical` 只描述 `.md` 副本本身，不代表同一地址会协商。

## Requirements

### Requirement: 协商特性与页面集合
静态契约 SHALL 有一个与 `markdown-canonical` 分开的 `markdown-negotiation` 特性，取值 `yes` / `degraded` / `no`，
每个非 `yes` MUST 带说明。契约 SHALL 只对「可收录、canonical 指向自身」的页面生成协商规则，规则即该页的 `.md` 副本；
站点的 `discovery.markdownNegotiation` 关闭、或没有 Markdown 副本时 MUST NOT 生成任何协商规则。
快照 SHALL 携带该开关（可选字段，旧快照视为关闭）。

#### Scenario: 开关关闭时不生成任何规则
- **WHEN** 站点未开启 `discovery.markdownNegotiation`，部署到任一目标
- **THEN** 生成的配置里没有协商规则，产物与加入该能力之前逐字节相同

#### Scenario: 不可收录或 canonical 指向别处的页面不协商
- **WHEN** 某页 noindex，或它的 `.md` 副本声明的 canonical 指向别的地址
- **THEN** 该页不在协商规则里，其地址按普通页面回答

#### Scenario: 协商开关打开但没有副本
- **WHEN** 站点开启协商但关闭 `.md` 副本
- **THEN** 不生成协商规则，部署记录写警告说明它需要 Markdown 副本

### Requirement: 预算与降级
每个平台 SHALL 保持其文档化的配置预算：Vercel 2048 条路由、Cloudflare Pages 100 条 header 规则与 2000 条重定向
（协商不进 `_headers`，不占这两项）。放不下的协商规则 MUST 降级为该页只回 HTML 并写警告，而不是让部署失败；
只有基础契约本身超限时才拒绝部署。Cloudflare 的 Pages Function 超过自查体积时 MUST 写警告，不阻止部署。

#### Scenario: Vercel 路由放不下
- **WHEN** 站点的协商规则加上其余路由超过 2048 条
- **THEN** 多出的页面保留 HTML（`.md` 副本仍可访问），部署成功并在记录里给出数量警告

#### Scenario: 部署记录承载降级
- **WHEN** 任一目标无法完整兑现协商
- **THEN** 降级原因出现在部署记录的警告里，矩阵的说明与之一致

### Requirement: 回放判定
系统 SHALL 提供一个纯函数，按 `(平台, 地址, Accept, 方法)` 回放**生成的**规则，给出边缘会送哪个文件、哪些表示头与响应体。
配置型目标（Vercel、VPS）读回生成的配置；代码型目标（Cloudflare Pages、Netlify）MUST 在隔离的 `node:vm` 上下文里执行生成的模块，
Netlify 的桩 `context` MUST 以 `next()` 返回该地址的资源响应、以 `rewrite(url)` 返回该 URL 的资源响应，并 MUST 只在
`netlify.toml` 声明了该函数时才判定有规则。回放 MUST 覆盖 Markdown 偏好、`text/html`、`*/*`、`text/*`、缺头、`q=0`、
非协商路径、直接取 `.md` 与 HEAD，SHALL 证明代码型目标与运行时逐例一致、配置型目标只在运行时也会回 Markdown 的请求上回 Markdown。

#### Scenario: 每个平台都能回答「会送哪个文件」
- **WHEN** 对一个生成的配置回放 `Accept: text/markdown` 的页面地址
- **THEN** Cloudflare Pages、Netlify、Vercel、VPS 都报告该页的 `.md` 副本

#### Scenario: 通配符与缺头回 HTML
- **WHEN** 回放 `Accept: */*`、`text/*` 或缺失
- **THEN** 所有目标都报告页面本身，且协商页面的回答带 `Vary: Accept`

#### Scenario: 运行时与静态规则的一致性
- **WHEN** 用属性测试对照生成的代码型目标与运行时的判定，或在格式良好的头上检查配置型目标
- **THEN** 代码型目标与运行时逐例相同；配置型目标回 Markdown 时运行时一定也回 Markdown（配置型可能少给，不会多给）

#### Scenario: HEAD 与 GET 的文件和头相同
- **WHEN** 回放一个协商页面地址的 HEAD 请求
- **THEN** 报告的文件与表示头与 GET 相同，响应体为空

### Requirement: 文档与部署后体检
文档 SHALL 用中文说明每个目标的做法、受限情形、预算与降级，并给出部署后对一个可协商页面抽查的只读步骤
（`Accept: text/markdown`、`text/html`、`*/*` 与直接取 `.md`；VPS 另在重载前校验 Caddyfile），
同时 MUST 说明 CI 的回放只证明规则、不证明平台的真实行为，并 MUST 写出代码型目标的前提
（Cloudflare Pages 执行 `_worker.js`；Netlify 打包 Edge Functions 且读取生成的 `netlify.toml`）。
支持矩阵中 Netlify 的 `markdown-negotiation` SHALL 为 `degraded`，其说明 MUST 点名两件事：该函数只在 Netlify 从仓库构建时被注册，本仓库的部署路径只上传文件、不发送 Deploy API 的 `edge_functions`，因此经本路径部署的站点不协商；以及平台限制。

#### Scenario: 部署后确认承诺成立
- **WHEN** 运维按文档对一个已部署的可协商页面执行四条 `curl`
- **THEN** Markdown 请求得到 `text/markdown` 且带 `noindex`、canonical `Link` 与 `Vary`，HTML 请求得到页面且带 `Vary`，`.md` 副本行为不变

#### Scenario: 诚实说明未证明的部分
- **WHEN** 读者查文档了解该能力的保证
- **THEN** 文档明确区分「CI 已证明的规则」与「部署后要验证的平台行为」，并写出 Netlify 的前提（Edge Functions 已部署、`netlify.toml` 被读取）

### Requirement: 每平台的协商表达与 Netlify Edge Function
部署 SHALL 用目标平台自己的配置或代码表达协商：Cloudflare Pages 的 Pages Function（`_worker.js`）与 Netlify 的 Edge Function
（`netlify/edge-functions/negotiate.ts`，由 `netlify.toml` 的 `[[edge_functions]]` 以 `path = "/*"`、`function = "negotiate"` 声明）
MUST 从有界的协商路径表查表判定，并 MUST 用与运行时相同的 `Accept` 规则比较 `q` 值；Vercel 的 `has`/`missing` 路由与 VPS 的
Caddy matcher MUST 只在运行时也会回 Markdown 的请求上回 Markdown。

#### Scenario: Cloudflare Pages 同一地址返回 Markdown
- **WHEN** 部署目标为 Cloudflare Pages 且请求一个协商页面的地址带 `Accept: text/markdown`
- **THEN** 产物中的 `_worker.js` 把该请求交给该页的 `.md` 副本，并补上 Markdown 的类型、`noindex`、canonical `Link` 与 `Vary`

#### Scenario: Vercel 与 VPS 的配置表达
- **WHEN** 部署目标为 Vercel 或 VPS 且站点有可协商页面
- **THEN** `vercel.json` 含 `accept` 条件的 `has`/`missing` 改写路由与 `Vary` 头路由，`Caddyfile.static` 含每个页面地址的 matcher、表示头与 `rewrite`

#### Scenario: Netlify 的 Edge Function 同一地址返回 Markdown
- **WHEN** 部署目标为 Netlify 且站点有可协商页面，请求一个协商页面的地址带 `Accept: text/markdown`
- **THEN** 产物含 `netlify/edge-functions/negotiate.ts` 与声明它的 `netlify.toml`；函数从有界路径表命中该页，用运行时规则判定为 Markdown，
  改写为 `.md` 副本，两个答案都带 `Vary: Accept`，Markdown 答案另带类型、`noindex` 与 canonical `Link`

### Requirement: 协商应答的表示头与放行
协商命中时，Markdown 答案 MUST 带 `Content-Type: text/markdown; charset=utf-8`、`X-Robots-Tag: noindex` 与该页 canonical `Link`；
两个变体 MUST 带 `Vary: Accept`，且 MUST 与响应已有的 `Vary` 合并而不是覆盖。代码型目标 MUST 对非协商路径与 GET/HEAD 以外的
方法原样放行，不用规则改写。站点没有协商规则时 MUST NOT 生成任何协商产物，`_headers` 与 `_redirects` 的输出 MUST 与加入该能力之前逐字节相同。

#### Scenario: 两个变体都带 Vary 且合并已有的值
- **WHEN** 协商页面的地址收到一个偏好 Markdown 的请求，而静态资源自身的响应已带 `Vary: Accept-Encoding`
- **THEN** 两个答案的 `Vary` 都含 `Accept`，且 Markdown 答案保留 `Accept-Encoding`（合并，不是覆盖）

#### Scenario: 非协商路径与写方法原样放行
- **WHEN** 请求的地址不在协商路径表里，或方法不是 GET/HEAD
- **THEN** 代码型目标直接交给下一环，不改写、不添加表示头

#### Scenario: Netlify 没有协商规则
- **WHEN** 站点的协商开关关闭或没有 Markdown 副本
- **THEN** 不生成 `netlify/edge-functions/negotiate.ts`，也不生成 `netlify.toml`，`_headers` 与 `_redirects` 与加入该能力之前逐字节相同

### Requirement: 协商产物与平台配置目录
Netlify 的 Edge Function 与 `netlify.toml` 是部署器生成的平台配置：产物扫描 MUST 把它们所在的路径视为平台配置冲突
（`netlify/` 目录与 `netlify.toml` 同等对待），运维者自带的同类文件 MUST 被拒绝部署，而不是与生成物一起打包。
生成物 MUST 只包含有界路径表与声明，不读取、不合并外部 `netlify.toml`。

#### Scenario: 产物自带 Netlify 目录
- **WHEN** 构建产物里有一个 `netlify/edge-functions/` 下的文件
- **THEN** 产物扫描报 `platform-config`，部署被拒绝，线上版本不变

#### Scenario: 干净产物
- **WHEN** 产物只含页面、资源与发现文件
- **THEN** 扫描不报平台配置冲突，部署继续

# publishing/static-edge-negotiation Specification

## Purpose
让静态目标（Cloudflare Pages、Vercel、Netlify、Caddy 后面的 VPS）在页面**自己的地址**上兑现 Classic 引擎的 Markdown 内容协商承诺，
并如实说明每个目标在哪些情况下做不到：可收录、canonical 指向自身的页面在 `Accept` 偏好 Markdown 时返回该页 `.md` 副本的内容与表示头，
两个变体都带 `Vary: Accept`；配置无法表达的目标（Netlify）在支持矩阵与部署记录中明确标为不可用。

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

### Requirement: 每平台的协商表达
部署 SHALL 用目标平台自己的配置表达协商：Cloudflare Pages 上传一个有界路径表的 Pages Function（`_worker.js`），
Vercel 在 `vercel.json` 用 `has`/`missing` 条件把地址改写到副本，VPS 在 `Caddyfile.static` 用 matcher 与 `rewrite`；
Markdown 答案 MUST 带 `Content-Type: text/markdown; charset=utf-8`、`X-Robots-Tag: noindex` 与该页 canonical `Link`，
且两个变体都带 `Vary: Accept`。Netlify MUST NOT 生成伪造的支持：其 `_headers`/`_redirects` 不能按 `accept` 变化，
特性为 `no`，部署记录说明 Markdown 仍在各页 `.md` 地址。

#### Scenario: Cloudflare Pages 同一地址返回 Markdown
- **WHEN** 部署目标为 Cloudflare Pages 且请求一个协商页面的地址带 `Accept: text/markdown`
- **THEN** 产物中的 `_worker.js` 把该请求交给该页的 `.md` 副本，并补上 Markdown 的类型、`noindex`、canonical `Link` 与 `Vary`

#### Scenario: Cloudflare Pages 其他请求原样通过
- **WHEN** 请求的地址不协商、或 `Accept` 不偏好 Markdown
- **THEN** 请求原样交给静态资源，协商路径表不随请求增长、也不在请求时扫描页面数据

#### Scenario: Vercel 与 VPS 的配置表达
- **WHEN** 部署目标为 Vercel 或 VPS 且站点有可协商页面
- **THEN** `vercel.json` 含 `accept` 条件的 `has`/`missing` 改写路由与 `Vary` 头路由，`Caddyfile.static` 含每个页面地址的 matcher、表示头与 `rewrite`

#### Scenario: Netlify 明确不可用
- **WHEN** 站点开启协商且部署目标为 Netlify
- **THEN** 不生成任何协商文件，部署记录写警告说明该目标做不到，支持矩阵该特性为 `no`

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
系统 SHALL 提供一个纯函数，按 `(平台, 地址, Accept)` 回放**生成的**规则，给出边缘会送哪个文件与哪些表示头：
Vercel 读回 `vercel.json` 的路由条件，VPS 读回 `Caddyfile.static` 的 matcher 与 `rewrite`，Cloudflare 执行生成的 `_worker.js`；
Netlify 报告「无规则」。回放 MUST 覆盖 Markdown 偏好、`text/html`、`*/*`、`text/*`、缺头、`q=0`、非协商路径与直接取 `.md`，
并 SHALL 证明 `_worker.js` 与运行时的判定逐例一致、配置型目标只在运行时也会回 Markdown 的请求上回 Markdown。

#### Scenario: 每个平台都能回答「会送哪个文件」
- **WHEN** 对一个生成的配置回放 `Accept: text/markdown` 的页面地址
- **THEN** Cloudflare、Vercel、VPS 都报告该页的 `.md` 副本，Netlify 报告页面本身

#### Scenario: 通配符与缺头回 HTML
- **WHEN** 回放 `Accept: */*`、`text/*` 或缺失
- **THEN** 所有目标都报告页面本身，且协商页面的回答带 `Vary: Accept`

#### Scenario: 运行时与静态规则的一致性
- **WHEN** 用属性测试对照 `_worker.js` 与运行时的判定，或在格式良好的头上检查配置型目标
- **THEN** `_worker.js` 与运行时逐例相同；配置型目标回 Markdown 时运行时一定也回 Markdown（配置型可能少给，不会多给）

### Requirement: 文档与部署后体检
文档 SHALL 用中文说明每个目标的做法、受限与不可用的情形、预算与降级，并给出部署后对一个可协商页面抽查的只读步骤
（`Accept: text/markdown`、`text/html`、`*/*` 与直接取 `.md`；VPS 另在重载前校验 Caddyfile），
同时 MUST 说明 CI 的回放只证明规则、不证明平台的真实行为。

#### Scenario: 部署后确认承诺成立
- **WHEN** 运维按文档对一个已部署的可协商页面执行四条 `curl`
- **THEN** Markdown 请求得到 `text/markdown` 且带 `noindex`、canonical `Link` 与 `Vary`，HTML 请求得到页面且带 `Vary`，`.md` 副本行为不变

#### Scenario: 诚实说明未证明的部分
- **WHEN** 读者查文档了解该能力的保证
- **THEN** 文档明确区分「CI 已证明的规则」与「部署后要验证的平台行为」，并把不可用的目标（Netlify）写在矩阵与部署记录里

---
version: 2
lastUpdated: 2026-11-12T08:22:28.816Z
sourceLang: zh-CN
contentHash: 28911a77a9555a2d
---

# 静态前台部署

使用 Astro 引擎的站点（见《Astro 静态引擎》）可以把静态产物部署到自有服务器（VPS）、Cloudflare Pages、Vercel 或 Netlify。
后端始终只运行在 VPS 上；部署目标只托管构建好的文件。

实现：

- `apps/cms/src/services/deployment/providers/cloudflare-pages.ts`：Cloudflare Pages 适配器（Direct Upload）；
- `apps/cms/src/services/deployment/providers/vercel.ts`、`apps/cms/src/services/deployment/providers/netlify.ts`：Vercel、Netlify 适配器（含静态上传）；
- `apps/cms/src/services/deployment/static/contract.ts`：静态目标响应契约与运行时功能支持矩阵；
- `apps/cms/src/services/deployment/static/edge-negotiation.ts`：同一地址 Markdown 协商的每平台生成物（Cloudflare 的 `_worker.js`、
  Netlify 的 Edge Function 与 `netlify.toml`、Vercel 路由、Caddy matcher）与回放判定；
- `apps/cms/src/services/deployment/static/scan.ts`：上传前的产物扫描；
- `apps/cms/src/services/deployment/static/static-deployer.ts`：部署、确认丢失后的核对、回滚与部署后体检；
- `apps/cms/src/services/deployment/static/static-site.ts`：后台开关（启用引擎、主题、部署目标）与视图；
- Studio：设置 › 高级 › 部署 › 「静态站点（Astro 引擎）」。

## 选择部署目标

1. 在「部署」页连接目标（令牌加密存储，接口与日志中不出现）：
   - Cloudflare Pages：项目填 `<账户 ID>/<项目名>`，API 令牌需要「Cloudflare Pages：编辑」权限；
   - Vercel：项目 ID 或名称，团队项目写成 `team_xxx/<项目>`；**Vercel 免费 Hobby 计划不允许商业用途**，后台在选择 Vercel 时提示；
   - Netlify：站点 ID。
2. 在「静态站点」中勾选「使用 Astro 引擎构建」，选择主题（`official:starter` 或 `operator:<名称>`）与部署目标；不选目标即为自有服务器。
   保存后立即请求一次构建；更换目标后，当前已上线的构建会部署到新目标。

## 部署流程

1. 构建通过校验并在本机原子上线后，为该世代（generation）登记一条部署请求，同时把该修订的响应契约保存在 `<root>/<siteId>/contracts/<generation>.json`。
2. worker 每 15 秒处理请求：扫描产物 → 按平台生成配置文件 → 以新的生产部署上传 → 轮询直到平台确认上线或失败。
3. 平台确认上线后才更新 `deployed_generation` / `deployed_revision`；`publishedRevision`（站点渲染版本）、`activeRevision`（本机已构建）与 `deployedRevision`（目标已确认）分开记录。
4. 上传失败时线上仍是上一个版本，部署记录为失败并附错误摘要与（脱敏的）平台日志。
5. 每次部署带一个标记（Cloudflare 的 `commit_message`、Vercel 的 `meta.heopressMarker`、Netlify 的 `title`）。上传出错或 worker 中途退出导致确认丢失时，
   先按标记向平台查询：找到就沿用该部署，找不到才重新请求部署，避免重复部署。

各平台接口（2026-10-28 对照官方文档与 Wrangler 源码核对）：

| 平台 | 上传方式 |
|---|---|
| Cloudflare Pages | `upload-token` → `pages/assets/check-missing` → `pages/assets/upload` → `pages/assets/upsert-hashes` → `deployments`（multipart：`manifest`、`branch`、`_headers`、`_redirects`）；资产键为 `blake3(base64 内容 + 扩展名)` 前 32 位十六进制 |
| Vercel | 每个文件 `POST /v2/files`（`x-vercel-digest` 为 SHA-1）→ `POST /v13/deployments`（`files`、`target: production`、`projectSettings.framework: null`）；路由写在 `vercel.json` |
| Netlify | 文件摘要部署：`POST /sites/{id}/deploys`（路径 → SHA-1）→ 对 `required` 中的文件 `PUT /deploys/{id}/files/{path}` → 状态为 `ready` 即上线 |

Vercel 的 Git 触发改为重新部署最近一次生产部署（`deploymentId`）：原实现只发送 `gitSource.ref`，接口要求同时给出仓库。Netlify 没有公开的构建日志接口，
日志改为部署对象的 `error_message` 与 `summary.messages`。

## 静态目标响应契约与功能支持矩阵

页面数据快照新增 `routes`：由 Classic 引擎逐一回答重定向规则的来源路径与撤回条目的路径得到（301 与目标地址、410）。部署时按平台写入：

| 功能 | VPS | Cloudflare Pages | Vercel | Netlify |
|---|---|---|---|---|
| noindex 响应头 | 支持 | 支持 | 支持 | 支持 |
| Markdown 副本 canonical（`Link`） | 支持 | 受限：`_headers` 最多 100 条规则，超出时副本仍为 noindex 但不带 `Link` | 支持 | 支持 |
| 301 重定向 | 支持 | 支持（最多 2000 条，超出拒绝部署） | 支持（最多 2048 条路由） | 支持 |
| 撤回内容 410 | 支持 | 受限：`_redirects` 不能返回 410，按 404 回答 | 支持 | 支持 |
| 同一地址 Markdown 协商 | 受限：Caddy 只按 `Accept` 头文本匹配 | 支持：随产物上传 `_worker.js`（Pages Function） | 受限：`vercel.json` 只按 `accept` 头文本匹配 | 受限：产物含 Edge Function（`netlify/edge-functions/negotiate.ts`）与声明它的 `netlify.toml`，但**本部署路径只上传文件、不发送 Deploy API 的 `edge_functions`**，经它部署的站点不会注册该函数 |
| RSS / Atom | 支持 | 支持 | 支持 | 支持 |
| 站内搜索、草稿预览、访问分析 | 不可用 | 不可用 | 不可用 | 不可用 |

VPS 生成 `<root>/<siteId>/Caddyfile.static`，在服务 `current` 目录的站点块中 `import` 即可。受限项会写入部署记录的警告；无法表达的契约（规则数超限）拒绝部署。

## 同一地址的 Markdown 协商（v1.2 P11 任务 4.5）

> **Netlify 的前提**：Edge Function 要真正生效，必须由**会打包它的部署方式**发布——Netlify 的 Git 连续部署，或 Netlify CLI **12.2.8 及以上**的手动部署（更早的 CLI 会报部署错误）。本仓库的 Netlify 适配器走 Deploy API 的文件摘要上传，只上传普通文件、不发送 `edge_functions`，因此经它部署的站点不会注册该函数，协商不生效；矩阵里 Netlify 的该项标为 `degraded`（受限）就是这个原因，不是配置写法的问题。

站点开启 `discovery.markdownNegotiation`（默认关闭）后，Classic 引擎在页面**自己的地址**上按 `Accept` 返回该页的 Markdown
（见《Classic 渲染服务》的「Markdown 内容协商」）。静态目标不运行这段代码，所以部署时把同一承诺写进各平台自己的配置：
只有可收录、canonical 指向自身的文章与页面协商（与 `.md` 副本、sitemap 同一个收录判定），答案就是该页的 `.md` 副本。

| 目标 | 做法 | 支持 |
|---|---|---|
| Cloudflare Pages | 随产物上传 `_worker.js`（Pages Function，advanced mode）：内置可协商路径表（查表判定，不在请求时扫描）、与运行时相同的 RFC 9110 规则；命中则改写为该页 `.md` 副本并补类型、`noindex` 与 canonical `Link`，两个变体都带 `Vary: Accept`；其他请求原样交给静态资源 | 支持（受 Pages Functions 计划限制：请求数、CPU、bundle 大小） |
| Vercel | `vercel.json` 的 `routes`：一条 `Vary: Accept` 头路由，加每页一条带 `has`/`missing` 条件的改写路由（`accept` 含 `text/markdown`、不含 `text/html`/`text/*`/`*/*`、不以 `q=0` 拒绝） | 受限：只按请求头**文本**匹配，不比较 `q` |
| VPS（Caddy） | `Caddyfile.static` 中每页一个 `@negotiate_md_N`（CEL 表达式：`path(...)` 与 `Accept` 正则）与 `rewrite` 到 `.md`；页面地址带 `header Vary "Accept"` | 受限：同上 |
| Netlify | 随产物上传 `netlify/edge-functions/negotiate.ts`（Edge Function，Deno 运行时）：同样的可协商路径表与同一份 RFC 9110 规则；非协商路径与 GET/HEAD 以外的方法原样交给下一环，命中则 `context.rewrite` 到该页 `.md` 副本并补表示头，两个变体都带 `Vary: Accept`；同时生成 `netlify.toml`，用 `[[edge_functions]]`（`path = "/*"`、`function = "negotiate"`）声明路由 | 受限（**本部署路径只上传文件，不发送 Deploy API 的 `edge_functions`，因此这里部署的站点不会注册该函数、也不会协商**；只有在 Netlify 自己从仓库构建（Git 构建）且产物含这两个文件时才生效。受 Edge Functions 计划限制：调用次数、每请求 50 ms CPU、bundle 20 MB） |

**受限意味着什么**（Vercel 与 VPS）：配置只能读请求头文本。Cloudflare Pages 与 Netlify 是代码（Pages Function / Edge Function），
按运行时同一套规则比较 `q` 值，不受下表限制。

| 请求 | 静态目标 | Classic 引擎 |
|---|---|---|
| 只列出 `text/markdown`（以及不覆盖 HTML 的类型） | Markdown | Markdown |
| 浏览器默认头、`text/html`、`*/*`、`text/*`、缺头 | HTML | HTML |
| `text/markdown;q=0`、`text/markdown;q=0.000` | HTML | HTML |
| `text/markdown;q=0.9, text/html;q=0.5` | HTML（看两者都出现） | Markdown（`q` 更高） |
| `text/markdown, */*` | HTML | HTML（并列） |
| 其它 `q` 值、畸形 `q` | 不比较：出现即接受（`q=0` 除外） | 按 RFC 9110 计算 |

也就是说静态目标只在运行时会回 Markdown 的请求上回 Markdown（保守方向）；唯一的偏差是它可能把 `q` 值偏好 Markdown、
但同时列出 HTML 的请求当作 HTML。Cloudflare Pages 的 `_worker.js` 按运行时同一套规则判定，不受此限。

**预算与降级**：

- Vercel 2048 条路由：协商占 1 条 `Vary` 路由 + 每页 1 条改写路由；放不下的页面保留 HTML（`.md` 副本仍可访问），部署记录给出数量警告。
- Cloudflare Pages：`_headers` 的 100 条规则不受影响（协商不进 `_headers`）；`_worker.js` 超过 256 KiB 时部署记录提醒核对 Pages Functions 的 bundle 上限。
  路径表是显式列表，不随请求增长，也不在请求时扫描页面数据。
- Netlify：Edge Function 里同样是显式路径表（查表判定），`_headers` / `_redirects` 不因协商改变；平台限制是每请求 50 ms CPU、
  每月调用次数按套餐、bundle 20 MB 压缩后。部署路径必须真的注册 Edge Functions 并读取生成的 `netlify.toml`：本仓库的 Netlify 部署器目前只上传文件、不发送 `edge_functions`，所以矩阵是 `degraded` 而不是 `yes`；CI 不证明这一步，
  由下面的体检确认。
- VPS：每个可协商页一行 matcher 加一段 header 块；站点关闭 `.md` 副本时静态目标不协商（没有可改写到的文件），部署记录会说明。
  非 ASCII 的页面路径在快照里是百分号编码形式，而 Caddy 的 `path` matcher 会先解码请求路径，两者对不上时该页在 VPS 上不协商（保守失败，体检能发现）；
  页面 slug 通常是 ASCII，本变更不为它发明解码规则。
- 关闭协商（默认）时这一节的所有规则都不生成，产物与加入该能力之前逐字节相同。

**部署后体检**：CI 只能证明生成的规则（下面「回放」）。真实平台行为要在每次部署后对一个可协商页面抽查四条，全部符合才算该目标成立
（Netlify 还先确认部署里确实带上了 `netlify/edge-functions/negotiate.ts` 与 `netlify.toml`，且函数已被平台识别——这是 `yes` 的前提）：

```bash
curl -sI -H 'Accept: text/markdown' https://www.example.com/hello/
curl -sI -H 'Accept: text/html' https://www.example.com/hello/
curl -sI -H 'Accept: */*' https://www.example.com/hello/
curl -sI https://www.example.com/hello.md
```

- 第 1 条：`content-type: text/markdown; charset=utf-8`、`x-robots-tag: noindex`、`link: <https://www.example.com/hello/>; rel="canonical"`、`vary: accept`；
- 第 2、3 条：HTML 类型与 `vary: accept`，且没有 `link`（第 3 条在配置受限的目标上也必须是 HTML）；
- 第 4 条：副本仍是 `text/markdown` 且带 `noindex` 与 `link`（协商不改变副本本身）。

VPS 在重载前先校验配置：`caddy validate --config /etc/caddy/Caddyfile`（已 `import` 本片段），失败时重载不会替换正在运行的配置。

**CI 能证明的部分**：`apps/cms/src/services/deployment/static/edge-negotiation.ts` 的 `replayEdgeNegotiation` 读回生成的配置
（`vercel.json` 路由、`Caddyfile.static` 的 matcher 与 `rewrite`），并把 `_worker.js` 与 Netlify 的
`netlify/edge-functions/negotiate.ts` 按生成内容在隔离的 `node:vm` 上下文里执行（Netlify 的桩 `context`：
`next()` 返回该地址的资源响应、`rewrite(url)` 返回该 URL 的响应；`netlify.toml` 没有声明该函数时按「无规则」处理），
给出 `(平台, 地址, Accept, 方法)` 会送哪个文件、哪些表示头与什么响应体；用例见
`apps/cms/src/services/deployment/static/__tests__/edge-replay.test.ts`。属性测试还证明两个代码型目标（Cloudflare Pages、Netlify）
与运行时的判定逐例一致。它证明规则本身，不证明平台真的这样执行——后者只能靠上面的体检。

## 回滚

「回滚到上一次部署」把上一次成功部署的世代重新部署到目标，并新增一条回滚记录。上线前先用当前快照检查旧产物：含有站点已不再发布的页面或文件（撤回、下线、410）
即拒绝，需要重新构建；赞助披露策略按当前设置检查。部署对账不会把回滚自动"纠正"回去，下次构建会正常部署新版本。

## 产物扫描

上传前读取产物中的每个文件，发现以下任一项即拒绝部署（线上版本不变，记录列出文件与规则，摘录已脱敏）：私钥、各平台令牌、JWT、带密码的连接串、
`JWT_SECRET` 等赋值、本机 `JWT_SECRET` / `ENCRYPTION_KEY` 的值；CMS 自己的地址（`HEOPRESS_PUBLIC_URL`、`HEOPRESS_STUDIO_URL`、`HEOPRESS_PREVIEW_ORIGIN`）及 `/admin`、`/studio`、`/api/v1` 链接；
回环与内网地址、页面数据接口、数据库表名；`.env*`、`.git`、`package.json`、source map、密钥证书、平台配置文件
（`_headers`、`_redirects`、`_worker.js`、`vercel.json`、`.vercel`、`netlify.toml`、`netlify/` 目录、`Caddyfile.static`——
这些由部署器生成，产物不得自带；自己的 `netlify/edge-functions/` 会被当成冲突而拒绝部署）。

## 部署后可达性体检

部署成功后按 P07 的体检规则对站点的已验证域名执行一次可达性体检，平台为部署目标，结果（问题、平台对应的修复方式）写入部署记录并在 Studio 中显示。
站点没有已验证域名时记为跳过。

## 测试

```bash
pnpm --filter @heopress/cms exec vitest --run src/services/deployment
DATABASE_URL=<应用角色> DATABASE_OWNER_URL=<所有者> pnpm --filter @heopress/cms exec vitest --run src/__tests__/static-deploy.db.integration.test.ts
```

真实部署的冒烟测试需要凭据，不在 CI 中运行：`apps/cms/scripts/p11-deploy-smoke.ts`（用法见文件头）。

# 静态前台部署

使用 Astro 引擎的站点（见《Astro 静态引擎》）可以把静态产物部署到自有服务器（VPS）、Cloudflare Pages、Vercel 或 Netlify。
后端始终只运行在 VPS 上；部署目标只托管构建好的文件。

实现：

- `apps/cms/src/services/deployment/providers/cloudflare-pages.ts`：Cloudflare Pages 适配器（Direct Upload）；
- `apps/cms/src/services/deployment/providers/vercel.ts`、`apps/cms/src/services/deployment/providers/netlify.ts`：Vercel、Netlify 适配器（含静态上传）；
- `apps/cms/src/services/deployment/static/contract.ts`：静态目标响应契约与运行时功能支持矩阵；
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
| RSS / Atom | 支持 | 支持 | 支持 | 支持 |
| 站内搜索、草稿预览、访问分析 | 不可用 | 不可用 | 不可用 | 不可用 |

VPS 生成 `<root>/<siteId>/Caddyfile.static`，在服务 `current` 目录的站点块中 `import` 即可。受限项会写入部署记录的警告；无法表达的契约（规则数超限）拒绝部署。

## 回滚

「回滚到上一次部署」把上一次成功部署的世代重新部署到目标，并新增一条回滚记录。上线前先用当前快照检查旧产物：含有站点已不再发布的页面或文件（撤回、下线、410）
即拒绝，需要重新构建；赞助披露策略按当前设置检查。部署对账不会把回滚自动"纠正"回去，下次构建会正常部署新版本。

## 产物扫描

上传前读取产物中的每个文件，发现以下任一项即拒绝部署（线上版本不变，记录列出文件与规则，摘录已脱敏）：私钥、各平台令牌、JWT、带密码的连接串、
`JWT_SECRET` 等赋值、本机 `JWT_SECRET` / `ENCRYPTION_KEY` 的值；CMS 自己的地址（`HEOPRESS_PUBLIC_URL`、`HEOPRESS_STUDIO_URL`、`HEOPRESS_PREVIEW_ORIGIN`）及 `/admin`、`/studio`、`/api/v1` 链接；
回环与内网地址、页面数据接口、数据库表名；`.env*`、`.git`、`package.json`、source map、密钥证书、平台配置文件（由部署器生成，产物不得自带）。

## 部署后可达性体检

部署成功后按 P07 的体检规则对站点的已验证域名执行一次可达性体检，平台为部署目标，结果（问题、平台对应的修复方式）写入部署记录并在 Studio 中显示。
站点没有已验证域名时记为跳过。

## 测试

```bash
pnpm --filter @heopress/cms exec vitest --run src/services/deployment
DATABASE_URL=<应用角色> DATABASE_OWNER_URL=<所有者> pnpm --filter @heopress/cms exec vitest --run src/__tests__/static-deploy.db.integration.test.ts
```

真实部署的冒烟测试需要凭据，不在 CI 中运行：`apps/cms/scripts/p11-deploy-smoke.ts`（用法见文件头）。

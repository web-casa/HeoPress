# MCP 授权：OAuth 2.1、个人访问令牌与工具约束

外部 Agent（Claude Code、Codex、WorkBuddy 等）通过实例级 MCP 端点 `POST /api/v1/agents/mcp` 操作 HeoPress。
每个调用者只能在自己授权的站点与工具组内操作；身份与授权范围只来自令牌。工具清单见 [MCP 工具参考](./mcp-tools.md)。

实现：`apps/cms/src/services/agent-access/`（授权服务、工具目录与约束）、`apps/cms/src/routes/agent-access.ts`（OAuth 端点、授权页接口、个人令牌）、
`apps/cms/src/routes/agents-mcp.ts`（MCP 端点）。表：`lumibase_oauth_clients`、`lumibase_agent_grants`、`lumibase_oauth_codes`、
`lumibase_oauth_tokens`、`lumibase_agent_idempotency`（迁移 `0106_p10_oauth`）。

## 端点

| 端点 | 用途 |
|---|---|
| `GET /.well-known/oauth-protected-resource/api/v1/agents/mcp` | 受保护资源元数据（RFC 9728），`resource` 为 MCP 端点 URL |
| `GET /.well-known/oauth-authorization-server` | 授权服务器元数据（RFC 8414），只声明 `S256` |
| `POST /api/v1/oauth/register` | 动态客户端注册（RFC 7591），按 IP 限流（默认每小时 20 次，`HEOPRESS_OAUTH_REGISTER_LIMIT`） |
| `GET /api/v1/oauth/authorize` | 校验请求后把浏览器送到 Studio 授权页 |
| `POST /api/v1/oauth/token` | 授权码换令牌、刷新令牌 |
| `POST /api/v1/oauth/revoke` | 吊销（RFC 7009） |
| `GET/POST /api/v1/agent-access/consent` | 授权页读取请求、提交决定（只限登录 Studio 的人） |
| `GET /api/v1/agent-access/grants`、`POST /api/v1/agent-access/tokens`、`DELETE /api/v1/agent-access/grants/:id` | 已连接的 Agent 与个人访问令牌 |

公开地址取自 `HEOPRESS_PUBLIC_URL`（生产环境必须设置，否则按请求来源推导）；Studio 不与 CMS 同源时用 `HEOPRESS_STUDIO_URL` 指明，授权页位于私有后台路径下的 `/agent-access/consent`。

## 授权流程

1. 客户端调用 MCP 端点得到 401 与 `WWW-Authenticate: Bearer resource_metadata="…"`，据此发现授权服务器。
2. 客户端注册（或使用客户端 ID 元数据文档：客户端 ID 是 https URL，服务器经出站安全边界读取，不跟随跳转、5 秒、64 KiB，内网地址被拒绝）。
3. 授权请求必须带 `code_challenge` 与 `code_challenge_method=S256`；`resource` 只能是本 MCP 端点；`scope` 可选（`mcp:read mcp:content …`），作为授权页可选工具组的上限。
4. 用户在 Studio 授权页勾选站点（只能是自己所属的站点；实例管理员可选全部站点）与工具组（只读、内容编辑、发布、站点设置、主题）。
5. 返回客户端的重定向带 `code`、`state` 与 `iss`；授权码 60 秒有效、只能用一次。
6. 令牌端点校验客户端、重定向 URI（完全一致；回环地址 http 允许端口不同）、PKCE 与 `resource`，签发访问令牌（1 小时）与刷新令牌（30 天，每次刷新轮换）。

令牌是不透明随机串，数据库只存 SHA-256。

## 安全规则

- **受众绑定**：令牌只对签发时的 MCP 端点 URL 有效；请求其他 `resource` 返回 `invalid_target`。
- **授权码单次使用**：重放已用的授权码返回 `invalid_grant`，并吊销该授权签发的全部令牌。
- **刷新轮换与重放检测**：旧刷新令牌再次出现时吊销整个授权。
- **实时权限交集**：每次调用都检查令牌的站点与工具组、用户仍为启用状态且 `token_version` 未变（改密或重置密码即失效）、用户仍是该站点成员，
  然后以该用户身份向 Studio 使用的同一 REST 接口发出内部请求，实时 RBAC、行级安全、Hold 与发布检查照常生效。降权、移出站点、禁用账号立即生效。
- **身份只来自令牌**：工具参数中的 `userId`、`actor`、`createdBy`、`userCreated` 等字段被移除，按令牌所属用户执行，并写审计事件 `mcp_identity_argument_ignored`。
- **授权决定只能由人在 Studio 做出**：授权页与个人令牌接口拒绝 API Key、前台用户与任何 Agent 令牌。
- **注册安全**：重定向 URI 只能是 https、回环地址 http 或私有 scheme（如 `cursor://`），禁止片段、用户信息与 `javascript:`/`data:`/`file:` 等；
  只支持 `authorization_code` 与 `refresh_token`。元数据中的 logo、主页等 URL 从不抓取。

## 个人访问令牌

命令行 Agent（Claude Code、Codex）在 Studio 的「设置 › Agent 访问」创建个人访问令牌（前缀 `hpo_pat_`），同样选择站点与工具组，有效期 1–365 天，明文只显示一次，可随时吊销（吊销后返回 401）。

```json
{ "mcpServers": { "heopress": { "type": "http", "url": "https://cms.example.com/api/v1/agents/mcp", "headers": { "Authorization": "Bearer hpo_pat_…" } } } }
```

## API Key

站点 API Key 仍可用于 MCP（新端点与旧的 `/api/v1/mcp`），只作用于其所属站点，工具组取自 `metadata.mcpToolGroups`，**未设置时只读**。
站点管理员用 `PATCH /api/v1/api-keys/:id/mcp-tool-groups`（`{"mcpToolGroups":["read","content"]}`）调整，变更写审计 `api_key_mcp_tool_groups_updated`。
已有通过旧端点写入的 API Key 需要按此补设工具组。

## 工具约束

- 内容与站点工具必填 `siteId`，一次只作用于一个站点；传站点数组或 `siteIds` 的写调用返回 `PLAN_REQUIRED` 并指向 `plans_submit`。
- 站点枚举、新建站点用 `scope: { "instance": true }`，计划查询用 `scope: { "planId": "…" }`；批量计划用 `siteIds` 或 `instance`（二选一），没有隐式的“全部站点”。
  `instance` 在提交时被固化为站点 ID 清单，之后新建的站点不会加入；新建的站点也不会自动加入当前授权。
- 修改已有资源必填 `expectedVersion`；新建必填 `idempotencyKey`，不要求版本。
- 删除、主题发布等高危操作即使只涉及一个站点也不直接执行，返回 `PLAN_REQUIRED`。
- 不在授权内的站点或工具组、或实时权限拒绝：HTTP 403（`WWW-Authenticate: Bearer error="insufficient_scope"`），JSON-RPC 错误 `-32003`，`data.code` 给出原因（`SITE_NOT_AUTHORIZED`、`TOOL_GROUP_NOT_GRANTED` 等）。
- 请求体上限 4 MiB，超过返回 413。
- 按 URL 上传图片：主机必须在站点设置 `agents.imageHostAllowlist`（主机名数组，子域名匹配）中；经出站安全边界抓取，不跟随跳转，只接受 JPEG/PNG/GIF/WebP/AVIF，最大 10 MiB。
- 批量计划工具 `plans_submit` 解析并固化范围、分级后提交计划，`plans_get` / `plans_revise` 读取与修改自己的计划；审批与执行只在后台由人完成，没有任何 MCP 工具能审批计划，详见[批量操作计划](./batch-plans.md)。

## 多用户、多 Agent 同时操作

多个用户可以同时用各自的 Agent（OAuth 连接器或个人访问令牌）连接同一个实例，彼此互不影响：

- 每个令牌只代表其所属用户与授权时勾选的站点、工具组；访问他人站点返回 403（`SITE_NOT_AUTHORIZED`），参数中伪造的用户字段被忽略。
- 一个用户的批量计划对其他用户的 Agent 不可见（`PLAN_NOT_FOUND`），也不能被其修改。
- 两个 Agent 以同一 `expectedVersion` 同时修改同一条内容时只有一个成功，另一个得到 409 冲突结果（`status: 409`），需重新读取后再改，不会静默覆盖。
- 涉及多个站点的修改只会生成待审批的计划；任何 Agent 令牌都不能审批。

以上行为由集成测试 `apps/cms/src/__tests__/p10-multi-agent.db.integration.test.ts` 覆盖。

## 审计

实例级事件（授权、拒绝、吊销、个人令牌）写入系统事件（`source = agents`）；与站点相关的事件（伪造身份参数、白名单拒绝）写入该站点的审计日志。

## 行级安全

可选的 RLS 策略（`packages/database/migrations/rls-policies.sql`）对上述五张表启用强制 RLS：应用角色只能在设置了 `app.agent_access = 'on'` 的事务中读写，授权服务是唯一这样做的代码。

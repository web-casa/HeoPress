# MCP 协议版本与客户端兼容矩阵

本页说明 Agent MCP 端点 `POST /api/v1/agents/mcp` 支持的协议版本、锁定的 SDK 版本、各外部客户端的验证状态，以及如何自己验证一个客户端。
授权方式见 [MCP 授权](./mcp-authorization.md)，工具清单见 [MCP 工具参考](./mcp-tools.md)。

## 协议版本

| 项 | 值 |
|---|---|
| 传输 | Streamable HTTP，只有 `POST`（JSON-RPC 2.0 单个请求对象，响应为 `application/json`）；不提供服务端推送流，`GET` 返回 405 |
| 支持的协议版本 | `2025-06-18`（默认）、`2025-03-26`（`apps/cms/src/services/mcp-service.ts` 的 `SUPPORTED_PROTOCOL_VERSIONS`） |
| 版本协商 | `initialize` 请求的 `protocolVersion` 在支持列表中就原样返回，否则返回默认版本，由客户端决定是否继续 |
| `MCP-Protocol-Version` 请求头 | 可省略（按协商结果处理）；给出不支持的版本时返回 400，`error.data.supported` 列出支持的版本 |
| `Origin` 请求头 | 可省略（命令行与服务端客户端不带）；带了就必须是本站公开地址（`HEOPRESS_PUBLIC_URL`）、请求自身的源，或 `CORS_ALLOWED_ORIGINS` 中的源，否则 403（`ORIGIN_NOT_ALLOWED`，防 DNS 重绑定）。生产环境不放行 localhost |
| 通知 | 没有 `id` 或方法以 `notifications/` 开头的消息返回 202、无响应体；`notifications/cancelled` 被接受但不改变任何状态（每个调用同步完成，没有可取消的进行中任务） |
| 请求体上限 | 4 MiB（413） |

### 响应与错误格式

- 工具调用成功或业务失败都是 `result`：`content` 为一段文本（结构化结果的 JSON），`structuredContent` 为同一对象，`isError` 表示业务失败（如 `VERSION_REQUIRED`、`VERSION_CONFLICT`）。
- 协议错误是 JSON-RPC `error`：`-32700` 不是合法 JSON、`-32600` 不是单个 JSON-RPC 2.0 请求对象（含批量数组）、`-32601` 方法不支持、`-32602` 参数错误；读不出请求 `id` 时 `id` 为 `null`。
- 认证失败：HTTP 401，`WWW-Authenticate: Bearer resource_metadata="…", error="invalid_token"`。
- 超出授权（站点、工具组、实时权限）：HTTP 403，JSON-RPC 错误码 `-32003`，`error.data.code` 给出原因，`WWW-Authenticate` 带 `error="insufficient_scope"`。
- 错误输出不含令牌、密钥、连接串、堆栈或 SQL（`p10-mcp-protocol-security` 测试逐类检查）。

## SDK 版本锁定

- `@modelcontextprotocol/sdk` 在 `apps/cms` 与 `packages/mcp-server` 中锁定为精确版本 **1.32.1**（不带 `^`），CI 用 `pnpm install --frozen-lockfile` 安装，不追最新。
- 升级 SDK 是一次显式变更：改两个 `package.json` 与锁文件，跑下面的协议测试与 SDK 客户端会话测试，并更新本页。
- SDK 客户端可能知道比服务端更新的协议版本；协商后以服务端返回的版本为准（测试“the pinned MCP SDK client completes a session”验证）。

## 客户端兼容矩阵

状态说明：**自动** = CI 中每次运行；**待实测** = 需要真实账号或客户端，由维护者手动验证后更新本表。

| 客户端 | 连接方式 | 协议版本 | 状态 | 说明 |
|---|---|---|---|---|
| 官方 MCP SDK 1.32.1（TypeScript，Streamable HTTP 客户端） | 个人访问令牌 / OAuth（SDK 的 `discover…`、`registerClient`、`startAuthorization`、`exchangeAuthorization`、`refreshAuthorization`） | 协商结果（`2025-06-18`） | 自动 | `p10-agent-access`（OAuth 全流程）、`p10-mcp-protocol-security`（会话、按协议版本的响应/取消/错误格式、脚本化一致性运行） |
| `apps/cms/scripts/mcp-conformance.mjs` | 个人访问令牌 | 协商结果 | 自动（经真实 HTTP 监听） | 同一脚本可对任何部署运行，见下文 |
| Claude Code | 个人访问令牌（`--header "Authorization: Bearer …"`）或 OAuth | — | 待实测 | P10 任务 5.3 |
| Codex | 个人访问令牌（`bearer_token_env_var`） | — | 待实测 | P10 任务 5.3 |
| WorkBuddy | OAuth（动态客户端注册 + PKCE） | — | 待实测 | P10 任务 5.4；如平台限制（如不支持动态注册或资源指示器）无法完成，记录具体限制 |
| 千问办公（自定义 MCP） | 待确认 | — | 待实测 | P10 任务 5.5；记录平台是否支持 Streamable HTTP、Bearer 令牌或 OAuth |

## 验证一个客户端

1. 在 Studio“设置 → Agent 访问”创建个人访问令牌：只勾选一个测试站点，工具组“只读、内容编辑、发布”，有效期 1 天。
2. 先用脚本确认端点与令牌可用（令牌只从环境变量读取，不会打印）：

   ```bash
   HEOPRESS_MCP_URL=https://cms.example.com/api/v1/agents/mcp \
   HEOPRESS_MCP_TOKEN=<个人访问令牌> \
   node apps/cms/scripts/mcp-conformance.mjs --write <站点 ID>
   ```

   输出一份 JSON 报告：协商的协议版本、工具清单、授权站点，以及（`--write` 时）幂等创建草稿 → 读取 → 按版本发布的单站演示，全部 `ok` 时退出码为 0。
3. 在客户端中配置同一端点与令牌（或走 OAuth），依次完成：列出工具、`sites_list`、`content_create`（带 `idempotencyKey`）、`content_publish`（带 `expectedVersion`），
   再尝试一个越权调用（另一个站点），确认得到 403。
4. 把客户端名称与版本、连接方式、协商的协议版本、结果（或平台限制）写入当期交接记录，并更新上表。

## 已知限制

- 当前工具目录没有“添加信源”与“设置站点语言”的工具：P10 任务 5.3 演示中的“创建双语站点、添加信源”需要在 Studio 中完成，或等新增对应工具后再由 Agent 完成。
- 不支持 JSON-RPC 批量请求、服务端推送流与会话 ID（`Mcp-Session-Id`）；每个请求独立认证。

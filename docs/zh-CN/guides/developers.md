---
version: 2
lastUpdated: 2026-10-29T14:08:52.949Z
sourceLang: zh-CN
contentHash: 7ab77f03262fc5e1
---

# 开发者指南

面向插件、主题与集成的开发者，以及参与 HeoPress 本身开发的贡献者。使用功能见[用户指南](users.md)，部署见[运维指南](operations.md)。

## 1. 架构概览

HeoPress 是一个 pnpm monorepo（Node.js 24、TypeScript），唯一必需的外部服务是 PostgreSQL 18：缓存、限流、队列与定时任务都在数据库里。

| 组件 | 路径 | 作用 |
|---|---|---|
| CMS | `apps/cms/` | Hono API、Studio 宿主与后台任务；同一镜像按 `HEOPRESS_PROCESS_ROLE`（`web`、`worker`、`all`）分角色运行 |
| Studio | `apps/studio/` | 管理后台 SPA（React + Vite），只经公开契约与 SDK 访问 CMS |
| 渲染服务 | `apps/site-classic/` | Classic 引擎：一个进程按域名服务全部站点，以只读数据库角色读取公开投影 |
| Astro 构建 | `apps/site-astro/` | Astro 引擎的按站点静态构建 |
| 数据库 | `packages/database/` | Drizzle 表定义（唯一真源）与生成的迁移 |
| 契约 | `packages/contracts/` | Zod 校验、共享类型、主题页面数据契约、扩展点上限 |
| 运行时 | `packages/runtime/` | 出站边界、存储、缓存、队列与检索适配器 |
| 公开站点 | `packages/public-site/` | 主题引擎、路径解析、起步主题 |

几条贯穿全局的规则：

- **多租户**：每张领域表都有 `site_id`；运行时以非所有者的应用角色连接数据库（行级安全策略尚未纳入默认迁移）；公开页面不读内容基表，只读同一事务内维护的公开投影。
  见[公开投影与渲染角色](../rendering/public-projection.md)。
- **变更事件**：每次内容写入在同一事务中写入变更事件，缓存失效、译文新鲜度、IndexNow、站内链接图等都是事件消费者。
  见 [Event consumers](../../en/architecture/event-consumers.md)（英文）。
- **出站请求**：所有对外 HTTP 请求都经过 `outboundFetch` 统一边界（SSRF 防护、地址在连接时校验）。
  见 [Outbound requests](../../en/security/outbound-requests.md)（英文）。
- **AI 与审批**：任何模型调用都经过站点的模型网关并记账；Agent、API Key 与 MCP 工具不能批准稿件，也不能审批批量计划。

## 2. 插件与 Extension SDK

插件只依赖 `@heopress/extension-sdk`（Apache-2.0），在能力沙箱中运行：没有数据库、环境变量或主机文件的直接访问，
条目经宿主的条目服务按请求者的权限读写，网络请求只能发往声明的主机。安装时管理员逐项批准插件申请的能力；
增加能力的升级要再次批准；开发模式之外只安装和加载由已登记发布者密钥签名的插件包。

| 扩展点类别 | 内容 |
|---|---|
| 内容 | 插件自己的集合、公开路由、模板与组件（清单中的数据，不在渲染器中运行插件代码） |
| 运行时 | 定时与队列任务、公开表单与回调端点、内容事件订阅、私有存储、后台面板 |
| 流水线 | 信源适配器、质量门禁检查项、构建步骤、经站点模型网关的 AI 调用 |
| 发布前钩子 | 在发布前拿到冻结副本，只能否决，不能修改 |

- 能力、清单、签名与各扩展点的完整说明：[Extension Development Guide](../../en/contributing/extension-dev.md)（英文）、[插件开发指南](../extensions/plugin-development.md)
- 起步模板：`examples/plugin-template`（只依赖打包后的 Extension SDK，`scripts/verify-plugin-template.mjs` 在 CI 中验证）
- 参考插件：术语表插件 `packages/plugin-glossary`
- 打包与签名：`heopress-ext keygen`、`heopress-ext sign`、`heopress-ext verify`（`packages/extension-cli/src/cli.ts`）

## 3. 主题

| 类型 | 说明 | 指南 |
|---|---|---|
| Liquid 主题（Classic 引擎） | 一组 Liquid 模板加静态资源，只拿到页面数据契约（`packages/contracts/src/theme/index.ts`）；正文、SEO 头部、赞助披露与 JSON-LD 只能经系统标签输出。按版本上传、检查、发布与回滚 | [主题开发指南](../rendering/theme-guide.md)、[主题引擎与沙箱](../rendering/theme-engine.md) |
| Astro 主题（Astro 引擎） | 标准 Astro 组件包，数据只来自页面数据契约（`packages/contracts/src/theme/page-data.ts`），系统内容用 `@heopress/astro-kit` 的组件放置 | [现有 Astro 站点移植为主题](../rendering/astro-theme-porting.md) |

起步主题（news、tech、minimal）在 `packages/public-site/src/theme/starters.ts`，是编写自己主题的起点；Astro 示例主题在 `examples/astro-themes`。

## 4. API、SDK 与 MCP

- **REST**：`/api/v1/` 下的 JSON API，请求带 `Authorization: Bearer <token>` 与站点头 `X-HeoPress-Site: <site-id>`；响应格式为 `{ data, meta? }` 或 `{ errors: [...] }`。
  继承自上游的通用接口（认证、条目、文件、Flows 等）见 [Hono API Specification](../../en/api/hono-api-spec.md)（英文）；
  HeoPress 新增的接口写在各专题页中。`docs/openapi.yaml` 只描述其中一部分接口。
- **GraphQL**：`/api/v1/graphql`（需要开启 `graphql` 功能）。
- **客户端与命令行**：`@heopress/sdk`（JS/TS 客户端）与 `heopress` 包（客户端 + 类型生成命令行）。见 [JavaScript SDK](../../en/sdk/javascript.md)、[HeoPress CLI](../../en/cli/index.md)（英文）。
- **MCP**：外部 Agent 使用 `POST /api/v1/agents/mcp`（Streamable HTTP，OAuth 2.1 / 个人访问令牌，按站点与工具组授权）。
  见 [MCP 授权](../agents/mcp-authorization.md)、[MCP 工具参考](../agents/mcp-tools.md)、[MCP 协议版本与客户端兼容矩阵](../agents/mcp-compatibility.md)、[官方 Skills](../agents/skills.md)。

## 5. 升级插件：codemod

插件 API 的破坏性变更列在发布说明中。能确定转换的部分由 codemod 自动改写（保留格式与注释），其余部分报告为人工步骤：

```bash
heopress-ext codemod --list
heopress-ext codemod --dir ./my-plugin
heopress-ext codemod --dir ./my-plugin --write
```

v1.0 提供 `lumibase-to-heopress`（LumiBase Extension SDK 0.x → HeoPress 1.0）。框架在 `packages/extension-cli/src/codemods/framework.ts`，
变更清单与退出码见[升级](../operations/upgrades.md)。

## 6. 参与开发

```bash
docker compose -f docker/docker-compose.yml up -d postgres
export DATABASE_URL=postgresql://heopress:heopress_dev@localhost:5432/heopress
pnpm install
pnpm db:migrate
pnpm dev
```

- 开发协议、代码布局与约定：仓库根目录的 `AGENTS.md`；环境准备与 PR 流程：[Contributing Guide](../../en/contributing/index.md)、[Testing Guide](../../en/contributing/testing.md)（英文）。
- 质量命令：`pnpm quality:fast`（类型检查、Lint、单元测试）、`pnpm quality:pr`（PR 门禁，需要隔离的 PostgreSQL 18）、`pnpm quality:release`（发布前），定义在 `scripts/quality.mjs`。
- 数据库：只用生成的迁移（改 `packages/database/src/schema/` 后 `pnpm db:generate`）；表与迁移的 `lumibase_` 前缀按设计保留。
- 依赖只能是宽松许可证（MIT、BSD、Apache-2.0、ISC 等），由 `pnpm licenses:check` 检查；修改上游文件须保留修改声明（`pnpm notices:check`）。
- 文档：中文为默认语言，改动成对的文档时同步另一语言，并通过 `pnpm docs:i18n:parity` 与 `pnpm docs:i18n:verify`。见 [Docs i18n](../../en/contributing/docs-i18n.md)（英文）。
- 外部贡献：在公开仓库 `web-casa/HeoPress` 提交 PR，须签署 CLA 并通过公开 CI；维护者把通过审阅的 PR 以补丁形式合入开发仓库并保留作者署名，随下一个版本发布。
  发布流水线与回迁流程见[公开发布与外部 PR 回迁](../../dev/release.md)，安全扫描见[安全扫描](../../dev/security-scanning.md)。

# 编辑策略

每个站点有一份版本化的**编辑策略**：受众、语气、术语表、引用政策、结构、质量与发布规则、禁区话题。AI 任务与外部 Agent 读取的是“当前生效版本”，运行记录保存所用版本号。

实现：`apps/cms/src/services/site-network/editorial-profile-service.ts`、接口 `apps/cms/src/routes/editorial-profile.ts`、Studio“Settings → Editorial profile”页面。

## 版本

- 每次保存都是一个新的**草稿**版本（版本号在站点内递增，从不修改已写入的版本）；历史版本始终可读。
- 发布某个版本使它成为当前生效版本，之前的生效版本变为 `superseded`；每个站点同时只有一个生效版本。可以把较早的版本重新发布。
- 发布写审计 `editorial_profile_published`（含之前的版本号）。

## 接口

| 接口 | 权限 |
|---|---|
| `GET /api/v1/editorial-profile` 当前生效版本（无则 `null`） | 站点成员，含 API Key 与 MCP 令牌 |
| `GET /api/v1/editorial-profile/versions`、`/versions/:version` 历史 | 站点成员 |
| `POST /api/v1/editorial-profile/versions` `{ content }` 保存新草稿版本 | 站点编辑 |
| `POST /api/v1/editorial-profile/versions/:version/publish` 发布 | 站点管理员 |

另一站点的凭据读取本站策略被拒绝（401；站点成员关系缺失时 403/404）。MCP 工具 `get_editorial_profile` 返回当前生效版本。

## 运行记录

Agent 运行开始时记录当时生效的版本号（`agent_runs.editorial_profile_version`，没有生效版本时为空），便于追溯某次输出遵循的是哪一版策略。

---
name: heopress-site-management
description: 管理 HeoPress 站群中的站点：查看已授权站点、读取站点设置、新建站点，并通过批量操作计划修改多个站点。
heopress:
  minVersion: 1.0.0-rc.4
  mcpTools:
    - sites_list
    - site_get
    - sites_create
    - plans_submit
    - plans_revise
    - plans_get
---

# 站点管理

## 通用规则

1. 动手前先确认目标站点（`siteId`）与语言；不确定时调用 `sites_list`（`scope: { instance: true }`）列出已授权站点并请用户选择，不要猜测。
2. 涉及多个站点的写操作一律使用 `plans_submit` 提交批量操作计划：先把将要影响的站点清单列给用户确认，再提交；计划只能由人在 Studio 审批，你无法也不应尝试审批。
3. 修改已有资源时带上读取到的 `expectedVersion`；返回冲突（409 / `VERSION_CONFLICT`）时重新读取、向用户说明差异，不要覆盖他人的修改。
4. 新建资源时提供唯一的 `idempotencyKey`，重试时沿用同一个键。
5. 被拒绝（403、`PLAN_REQUIRED`、`SCOPE_REQUIRED` 等）时如实告诉用户原因，不要换参数绕过。

## 工作流

- 查看：`sites_list` → `site_get`。
- 新建站点：`sites_create`（实例范围 + `idempotencyKey`）；新站点不会自动加入当前授权，需要用户在 Studio 重新授权。
- 修改多个站点（例如"把所有站点的页脚改一下"）：先用 `sites_list` 列出将受影响的站点并请用户确认，再调用 `plans_submit`；
  之后用 `plans_get` 跟踪审批与逐站结果，需要调整时用 `plans_revise`（修改会使已有审批失效）。

---
name: heopress-theme-design
description: 浏览 HeoPress 站点可用主题，提出主题调整方案，并通过批量操作计划切换主题。
heopress:
  minVersion: 1.0.0-rc.4
  mcpTools:
    - site_get
    - themes_list
    - theme_activate
    - plans_submit
    - plans_get
---

# 主题设计

## 通用规则

1. 动手前先确认目标站点（`siteId`）与语言；不确定时调用 `sites_list`（`scope: { instance: true }`）列出已授权站点并请用户选择，不要猜测。
2. 涉及多个站点的写操作一律使用 `plans_submit` 提交批量操作计划：先把将要影响的站点清单列给用户确认，再提交；计划只能由人在 Studio 审批，你无法也不应尝试审批。
3. 修改已有资源时带上读取到的 `expectedVersion`；返回冲突（409 / `VERSION_CONFLICT`）时重新读取、向用户说明差异，不要覆盖他人的修改。
4. 新建资源时提供唯一的 `idempotencyKey`，重试时沿用同一个键。
5. 被拒绝（403、`PLAN_REQUIRED`、`SCOPE_REQUIRED` 等）时如实告诉用户原因，不要换参数绕过。

## 工作流

1. `site_get` 读取品牌设置，`themes_list` 列出可用主题版本。
2. 先向用户说明方案（配色、版式、可访问性）并确认目标站点。
3. 主题切换属于高危操作：`theme_activate` 不会直接执行，即使只改一个站点也要用 `plans_submit` 提交计划（会先在金丝雀站点执行），用 `plans_get` 跟踪。

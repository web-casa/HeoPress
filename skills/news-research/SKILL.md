---
name: heopress-news-research
description: 为一个 HeoPress 站点调研新闻选题并产出草稿，草稿在内容分支中等待人工审核。
heopress:
  minVersion: 1.0.0-rc.4
  mcpTools:
    - site_get
    - content_query
    - content_get
    - content_create
    - branch_create
    - branch_update
    - branch_diff
    - media_upload_from_url
---

# 新闻调研

## 通用规则

1. 动手前先确认目标站点（`siteId`）与语言；不确定时调用 `sites_list`（`scope: { instance: true }`）列出已授权站点并请用户选择，不要猜测。
2. 涉及多个站点的写操作一律使用 `plans_submit` 提交批量操作计划：先把将要影响的站点清单列给用户确认，再提交；计划只能由人在 Studio 审批，你无法也不应尝试审批。
3. 修改已有资源时带上读取到的 `expectedVersion`；返回冲突（409 / `VERSION_CONFLICT`）时重新读取、向用户说明差异，不要覆盖他人的修改。
4. 新建资源时提供唯一的 `idempotencyKey`，重试时沿用同一个键。
5. 被拒绝（403、`PLAN_REQUIRED`、`SCOPE_REQUIRED` 等）时如实告诉用户原因，不要换参数绕过。

## 工作流

1. `site_get` 了解站点定位与默认语言；`content_query` 检查是否已有相同选题，避免重复。
2. 新稿件用 `content_create` 以草稿创建；修改已有稿件时用 `branch_create` 建分支、`branch_update` 修改、`branch_diff` 给用户看差异。
3. 配图用 `media_upload_from_url`，只能使用站点白名单中的主机；注明信源，不编造事实。
4. 不直接发布：发布由人决定。

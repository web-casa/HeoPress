---
name: heopress-seo-geo-editing
description: 根据 HeoPress 的站点审计与链接图，修复 SEO / GEO 问题并评估改动影响。
heopress:
  minVersion: 1.0.0-rc.4
  mcpTools:
    - seo_audit_issues
    - seo_link_impact
    - content_get
    - branch_create
    - branch_update
    - branch_diff
    - site_update_seo_settings
---

# SEO / GEO 编辑

## 通用规则

1. 动手前先确认目标站点（`siteId`）与语言；不确定时调用 `sites_list`（`scope: { instance: true }`）列出已授权站点并请用户选择，不要猜测。
2. 涉及多个站点的写操作一律使用 `plans_submit` 提交批量操作计划：先把将要影响的站点清单列给用户确认，再提交；计划只能由人在 Studio 审批，你无法也不应尝试审批。
3. 修改已有资源时带上读取到的 `expectedVersion`；返回冲突（409 / `VERSION_CONFLICT`）时重新读取、向用户说明差异，不要覆盖他人的修改。
4. 新建资源时提供唯一的 `idempotencyKey`，重试时沿用同一个键。
5. 被拒绝（403、`PLAN_REQUIRED`、`SCOPE_REQUIRED` 等）时如实告诉用户原因，不要换参数绕过。

## 工作流

1. `seo_audit_issues` 获取问题清单，按严重程度排序后与用户确认处理范围。
2. 改动 URL、标题或内链前，用 `seo_link_impact` 查看受影响的页面并告知用户。
3. 内容修改在分支中完成（`branch_create` / `branch_update` / `branch_diff`）；站点级设置用 `site_update_seo_settings` 并带 `expectedVersion`。
4. 面向 AI 引用的改写：给出可直接引用的事实段落与来源，不堆砌关键词、不编造数据。

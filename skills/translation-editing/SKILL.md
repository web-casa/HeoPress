---
name: heopress-translation-editing
description: 检查 HeoPress 站点的翻译状态并在内容分支中编辑译文。
heopress:
  minVersion: 1.0.0-rc.4
  mcpTools:
    - translation_status
    - content_query
    - content_get
    - branch_create
    - branch_get
    - branch_update
    - branch_diff
---

# 翻译编辑

## 通用规则

1. 动手前先确认目标站点（`siteId`）与语言；不确定时调用 `sites_list`（`scope: { instance: true }`）列出已授权站点并请用户选择，不要猜测。
2. 涉及多个站点的写操作一律使用 `plans_submit` 提交批量操作计划：先把将要影响的站点清单列给用户确认，再提交；计划只能由人在 Studio 审批，你无法也不应尝试审批。
3. 修改已有资源时带上读取到的 `expectedVersion`；返回冲突（409 / `VERSION_CONFLICT`）时重新读取、向用户说明差异，不要覆盖他人的修改。
4. 新建资源时提供唯一的 `idempotencyKey`，重试时沿用同一个键。
5. 被拒绝（403、`PLAN_REQUIRED`、`SCOPE_REQUIRED` 等）时如实告诉用户原因，不要换参数绕过。

## 工作流

1. `translation_status` 找出缺失或过期的译文，确认目标语言后再动手。
2. `content_get` 读取原文与现有译文；在 `branch_create` 建立的分支中用 `branch_update` 修改译文。
3. 用 `branch_diff` 展示字段与区块级差异，由人在 Studio 合并；术语与品牌名保持一致，不改动原文含义。

# 翻译组

同一内容的各语言版本是**独立条目**（各自的 slug、SEO、版本、Hold、审核与发布时间），通过**翻译组**关联。
翻译组为语言切换与 hreflang 提供数据；组内条目可以属于不同站点（需双方开启跨站翻译）。

实现：`apps/cms/src/services/site-network/translation-groups.ts`（条目写入中的组约束与锁）、
`apps/cms/src/services/site-network/translation-group-service.ts`（组管理与读取）、
`apps/cms/src/routes/translation-groups.ts`（接口）。

## 规则

| 规则 | 违反时 |
|---|---|
| 一个条目最多属于一个组 | 409 `ALREADY_IN_GROUP` |
| 同组同语言最多一条**已发布**条目（任何发布入口：编辑、批量、Releases、Agent、定时发布） | 409 `LOCALE_ALREADY_PUBLISHED` |
| 成员属于多个站点时，**所有**涉及站点都开启跨站翻译 | 409 `CROSS_SITE_DISABLED`（`details.siteId` 指出未开启的站点） |
| 修改组需要对组内**每个**条目（含要加入的条目）都有编辑权限，按各条目所在站点的角色判定 | 403 |
| 只有人（登录用户）能跨站操作；API Key 与 MCP 令牌只能触及本站成员 | 403 |
| 每组至多一个源条目；有其他成员时不能直接移出源条目 | 409 `CHANGE_SOURCE_FIRST` |
| 组的修改要带读取时的组版本 `expectedVersion` | 409 `VERSION_CONFLICT` |

成员的语言随条目的 `locale` 字段（未设置时取站点默认语言）在同一事务内更新；站点默认语言变更时，
未设置 `locale` 的成员随之改变，若因此与组内已发布的同语言条目冲突，默认语言的修改被拒绝（409）。

## 跨站翻译开关

站点内容设置中的“Cross-site translations”（`allowCrossSiteTranslations`）默认关闭。开启意味着本站的语言切换与 hreflang
会指向另一站点——搜索引擎与访客由此知道两站相关联（ADR-0009 的站群关联风险），Studio 在开关旁给出该提示。

**关闭开关立即生效**：

- 关联记录保留（供审计），但双方的公开语言切换数据、组读取中的公开摘要都不再包含另一站点的成员；
- 关闭期间不能新增跨站成员；
- 开关变化时，每个跨站组向其所有站点各写一条 `translation_group` 变更事件（`changedFields: ["crossSite"]`），供渲染层失效缓存。

## 读取与可见性

读取组时（`GET /api/v1/translation-groups/:id`、`GET /api/v1/translation-groups?item=<条目ID>`），按调用者在**成员所在站点**的权限：

- 能读取的成员：完整信息（语言、角色、仅内部标记、状态、版本、标题）；
- 不能读取、但已发布、非仅内部、且（同站或双方都开启开关）的成员：只给 `{ locale, url }`（`public` 数组）；
- 其他成员：完全不出现——不暴露草稿、存在性或管理状态。调用者一个成员都读不到时，组按不存在处理（404）。

语言切换数据（`GET /api/v1/items/:collection/:id/alternates`）只含公开成员（已发布、未删除、非仅内部，即 `publicItemPredicate`），
跨站成员仅在双方开启开关时出现，每项带公开 URL（按站点的语言策略、前缀与尾斜杠规则；尚无主域名的站点不给 URL）。
它是给读者切换语言用的，不可收录的译文同样可以切换过去，因此不按收录资格过滤；每项带 `indexable`（与该成员页面、公开 hreflang 用同一判定，P07），
自己输出 hreflang 的前端只取 `indexable: true` 的项。

## 公开页面的 hreflang 与 x-default（P07）

公开页面输出的语言关联（`hreflang`）比上面的语言切换数据更严：只列组内**已发布且可收录**的成员（含页面自身），
每个成员是否可收录按它所在站点的 SEO 设置与它自身的收录设置判定（见 `docs/zh-CN/rendering/site-classic.md`“页面头部与收录”）。
因此组内每个列出的页面输出同一组 hreflang；页面自身不可收录时不输出任何 hreflang。某站点的 SEO 设置或某成员的收录设置变化时，组内所有成员站点的语言关联在同一事务中刷新。

组可以指定一个 **x-default** 成员（`PUT /api/v1/translation-groups/:id/x-default` `{ itemId | null, expectedVersion }`，与其他组操作一样需要对每个成员都有编辑权限）：
设置时该成员须已发布且可收录（否则 409 `X_DEFAULT_NOT_INDEXABLE`）；之后它只在仍然已发布且可收录时作为 `hreflang="x-default"` 出现在每个成员页面上，
不可收录、被删除、被清除或移出组时全组都不输出（移出组时设置随之清除）。主题的语言切换不含 x-default。

## 仅内部的源条目

用于“原文只做内部来源、只公开译文”的站点：源条目可标记为**仅内部**（`PUT /api/v1/translation-groups/:id/members/:itemId/internal-only`）。

- 只有源条目可以标记（409 `SOURCE_ONLY`），已发布的条目要先取消发布（409 `UNPUBLISH_FIRST`）；
- 被标记的条目不能发布（编辑与定时发布都返回 / 记录 409 `INTERNAL_ONLY`），因此不进入路由、sitemap、hreflang、语言切换、搜索与订阅源；
- 它仍是译文的来源与新鲜度比对基准；换源前要先取消标记（409 `CLEAR_INTERNAL_FIRST`）。

## 共享字段

不随语言变化的字段（价格、版本号、仓库地址、评分、坐标……）在集合元数据中声明：`collections.meta.sharedFields`（字段名数组，站点管理员配置）。
共享字段以组的**源条目**为准：

- 非源成员修改共享字段被拒绝（422 `SHARED_FIELD_FROM_SOURCE`）；组处于无源状态时共享字段冻结，同样不能修改，设置新源后再同步；
- 源条目保存时若改变了共享字段，在同一事务内为每个其他成员写一条**同步意图**（`lumibase_shared_field_syncs`，保存该版本的共享字段值），
  同一成员更早的未完成意图标为 `superseded`；源条目的保存不受同步结果影响；
- 事件消费者 `shared-field-sync` 以**保存源条目的人（或 API Key）此刻在该成员站点的权限**写入成员：正常的更新路径，产生新版本与变更事件，
  遵守 Hold 与发布守卫（已发布条目的变更按正常流程生效，不会因此发布草稿）；
  - 无编辑权限（包括保存后被撤权）→ `blocked_permission`；已发布且处于 Hold → `blocked_hold`；成员不被写入；
  - 被阻止的意图通知该站点能编辑此集合的成员一次；其中一人可在 Studio 翻译组面板点击“Apply shared fields”，
    或调用 `POST /api/v1/translation-groups/:id/members/:itemId/apply-shared`，以自己的权限应用；
- 设置新源、成员加入时，与源条目共享字段不同的成员也会得到同步意图；源任期（`sourceEpoch`）变化后旧意图不再生效。
- 消费按“至少一次”投递：意图状态与写入在同一事务内更新，重复投递不会重复写入。

## 组的生命周期

| 操作 | 结果 |
|---|---|
| 建组 `POST /api/v1/translation-groups` `{ itemId }` | 该条目为源条目，源任期 `sourceEpoch = 1` |
| 加入 `POST …/:id/members` `{ itemId, siteId?, expectedVersion }` | 另一站点的条目要给出 `siteId` |
| 换源 `PUT …/:id/source` | 新源须为未删除的成员；`sourceEpoch + 1` |
| 设置 x-default `PUT …/:id/x-default` | 须为已发布且可收录的成员；`{ itemId: null }` 清除 |
| 移出 `DELETE …/:id/members/:itemId?expectedVersion=` | 最后一个成员移出时组解散 |
| 删除源条目（软删除） | 组进入**无源**状态（`sourceItemId = null`），成员行保留；设置新源后原源变为译文成员并清除仅内部标记 |
| 永久删除条目 | 其成员关系随之删除；不再有成员的站点退出该组 |

每次成员变化组版本 `+1`，并按受影响的站点各写一条 `translation_group` 事件，载荷只含该站点自己的成员 ID 与组 ID。

## 并发

发布、加入、改语言、换源、标记仅内部、删除都在同一锁顺序下进行：站点内容设置行 → 翻译组行 → 条目行。
两个同语言成员并发发布时只有一个成功；条目在发布的同时被加入某个组时，发布事务重新开始并按新组检查（重试 3 次后 409 `RETRY_EXHAUSTED`）。

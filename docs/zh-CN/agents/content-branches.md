# 内容分支：Agent 协作、分支预览与冲突感知合并

外部 Agent（以及编辑）在**内容分支**里修改条目，不影响线上内容；审核者可以在正式站点上、只对自己的浏览器看到分支效果；
合并时与分支创建后的线上修改逐字段、逐区块比较，同一处的冲突由人选择，不同处自动合并，结果只是**待发布修订**。
规格：`openspec/changes/p10-agent-collaboration-mcp/specs/agents/content-branches/spec.md`。

实现：`apps/cms/src/services/content-version-service.ts`（复用 LumiBase 内容版本作为分支）、
`apps/cms/src/services/branches/branch-merge.ts`（字段/区块差异与三方合并，纯函数）、
`apps/cms/src/services/rendering/branch-preview-service.ts`（预览授权）、`packages/public-site/src/branch-preview-cookie.ts`（签名 cookie）、
`apps/site-classic/src/app.ts`（公开站点渲染）、`apps/studio/src/modules/content/version-panel.tsx`（后台“版本”页签）。
迁移 `0108_p10_branches`：`lumibase_content_versions` 新增 `base_data`、`base_version`、`revision`、`state`、`merged_at`、`merged_by`；
新表 `lumibase_branch_preview_grants`（站点隔离，RLS 与其他租户表相同；渲染角色无权读取）。

## 分支模型

- 分支即条目的一个内容版本（`key` 在条目内唯一）。创建时记下主线（条目）当时的数据与版本号作为**合并基线**（`base_data` / `base_version`）。
- 分支有自己的修订号 `revision`：每次修改加一；写入与合并都要带上读到的修订号，过期即冲突（`BRANCH_STALE` / `MERGE_STALE`）。
- 状态：`open`（编辑中）、`merged`（已合并、等待人提升的待发布修订）。合并后再修改分支，状态回到 `open`。
- 写分支（创建、修改、删除、合并、预览、提升）需要对该集合的 `update` 权限；只读角色返回 403。
- P10 之前创建的版本没有基线，比较时以当前主线为基线，提升行为不变。

## MCP 工具

| 工具 | 工具组 | 说明 |
|---|---|---|
| `branch_create` | 内容编辑 | `siteId`、`collection`、`id`、`name`、`idempotencyKey`；分支键由调用者与幂等键派生，重试返回同一分支（`replayed: true`），同键不同请求返回 `IDEMPOTENCY_KEY_REUSED` |
| `branch_get` | 只读 | 分支数据、`revision`、`state`、`baseVersion` |
| `branch_update` | 内容编辑 | `branch`、`expectedVersion`（分支修订号）、`data`（只改给出的字段）；条目本身不变 |
| `branch_diff` | 只读 | 字段与区块级差异：`branch`（基线→分支）、`main`（基线→主线），以及此刻合并的结果预估 `merge.conflicts`、合并所需的 `mainVersion` / `revision` |
| `branch_merge` | 内容编辑 | `expectedVersion`（分支修订号）+ `expectedMainVersion`；工具**不能**选择冲突的一方，冲突只返回列表 |

没有提升（promote）工具：把合并结果应用到条目只能由人在后台完成。生成的工具参考见 [MCP 工具参考](./mcp-tools.md)。

REST（后台使用，同样受实时权限约束）：`GET …/versions/:key/diff`、`POST …/versions/:key/merge`
（`{ expectedMainVersion, expectedRevision, resolutions? }`，`resolutions` 形如 `{ "body#b_x": "branch", "title": "main" }`）、
`POST …/versions/:key/preview`、`DELETE …/versions/:key/preview`、`POST …/versions/:key/promote`，路径前缀 `/api/v1/items/:collection/:id`。
`PATCH …/versions/:key` 新增 `set`（部分字段）与 `expectedRevision`。

## 差异与合并算法

区块的定义沿用 P04：富文本字段（`wysiwyg`）的顶层元素带 `data-block-id`，重复字段（`repeater`）的行带 `_blockId`。
分支写入时自动给新块分配 ID。

对每个字段做三方比较（基线 B、主线 M、分支 R）：

1. `M = R`：取该值；
2. 只有一方改动（`R = B` 取 M，`M = B` 取 R）：取改动方，另一方的值不会被覆盖；
3. 两方都改且不同：
   - 区块字段且三方的块 ID 都可用：逐块重复 1–3；同一块两边都改（或一边改一边删）是**区块冲突**（ID `字段#块ID`）；
     两边新增的块按各自前一个块的位置插入；只有一方调整顺序时采用该顺序，两边顺序调整不同是**顺序冲突**（ID `字段#order`）；
   - 否则为**字段冲突**（ID 为字段名）。

每个冲突都列出基线、主线、分支三个版本。未全部选择时合并失败（409 `MERGE_CONFLICT`，`meta.conflicts`），什么都不写。

## 合并：原子校验，只产生待发布修订

- 合并请求携带比较时看到的 `expectedMainVersion` 与 `expectedRevision`。服务在**同一事务中锁定条目行与分支行**（`SELECT … FOR UPDATE`）后核对两者，
  任一不符即 409 `MERGE_STALE`（“比较之后有新修改，请重新比较”），不会覆盖新修改。
- 成功的合并**不写条目**：合并结果写回分支（`state = merged`），基线更新为合并时的主线（`base_version`）。
- 提升（后台“设为主版本”）：已合并的分支只能提升到它合并时的主线版本，主线之后又有修改则 409 `BRANCH_STALE`（需重新合并）；
  未合并的分支若主线已变化，先自动三方合并，有冲突则 409 `MERGE_CONFLICT`，不会静默覆盖。
  提升经 `ItemService.patch`：版本校验、Hold（已发布且被 Hold 的条目改动内容时 409 `ITEM_HELD`）、修订记录、缓存失效与发布检查全部照常；
  提升不会改变发布状态，P09 质量门禁结果绑定条目版本，提升后版本变化，自动发布必须重新评估。

## 分支预览（签名 cookie）

1. 有 `update` 权限的人在后台点“在站点上预览”（`POST …/versions/:key/preview`，可选 `ttlSeconds`，60 秒–24 小时，默认 1 小时）。
   条目必须已有公开地址；返回一次性链接 `https://<条目所在公开主机>/_heopress/branch-preview/<令牌>`。令牌 256 位随机数，只保存 SHA-256。
2. 浏览器打开链接：渲染服务把令牌交给 CMS 内部端点 `POST /internal/preview/branch-exchange`（服务间密钥，令牌在请求体中），
   授权在**该主机所属站点**内查找，未过期、未撤销、未使用过才兑换（只能兑换一次），返回 303 到条目路径并设置：

   `heopress_branch_preview=v1.<载荷>.<签名>; Max-Age=<剩余秒数>; Path=/; Secure; HttpOnly; SameSite=Lax`

   载荷包含站点、授权、分支与到期时间；签名为 HMAC-SHA256，密钥由 `HEOPRESS_INTERNAL_SECRET` 派生（专用于此用途）。
   用 `Lax` 是因为浏览器从后台以顶级导航进入并跟随站内 303；cookie 不能被脚本读取。
3. 之后该浏览器访问条目路径时：渲染服务先本地校验签名、站点与到期（其他站点的主机、篡改、过期的 cookie 一律忽略，按公开页面处理），
   再请求 `POST /internal/preview/branch-resolve`，CMS 校验授权未撤销、分支仍在、创建者账号有效且**当前**仍可读该条目，按投影规则用分支数据生成页面数据。
4. 分支页面的响应：`Cache-Control: no-store, private`、`X-Robots-Tag: noindex, nofollow`、`Referrer-Policy: no-referrer`，没有 ETag，
   **不读也不写**页面缓存（进程内与共享两级）；其他页面、其他访问者照常走公开缓存，公开缓存中永远不会出现分支内容。
5. 撤销：`DELETE …/versions/:key/preview`（创建者本人，或站点管理员撤销所有人的）；删除或提升分支后预览自然失效。

未配置 `HEOPRESS_INTERNAL_SECRET`（至少 32 个字符）时分支预览关闭（503 `PREVIEW_DISABLED`），交换路径返回 404。
草稿条目还没有公开地址时，请使用 P06 的预览链接（独立预览源）。

## 测试

- `apps/cms/src/services/branches/__tests__/branch-merge.test.ts`：同一区块冲突、不同区块自动合并、增删、顺序冲突、重复字段，以及 fast-check 性质（未改动的一方不会胜出、两边不同的修改必为冲突、不相交的段落修改合并为两者之和）。
- `apps/cms/src/__tests__/p10-content-branches.db.integration.test.ts`：MCP 编辑分支与差异、两类合并、比较后并发修改返回冲突、合并不绕过 Hold。
- `apps/cms/src/__tests__/p10-branch-preview.db.integration.test.ts`：带与不带 cookie 的渲染对比、公开缓存未被污染、跨站/篡改/撤销/失去权限/过期。
- `packages/public-site/src/__tests__/branch-preview-cookie.test.ts`、`apps/studio/src/modules/content/__tests__/version-panel.test.tsx`、`apps/studio/e2e/content-branches.spec.ts`。

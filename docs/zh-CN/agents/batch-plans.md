# 批量操作计划：分级、审批与执行

外部 Agent 修改两个及以上站点，或执行高危操作（删除、全站主题发布等，单站也一样），只能提交**批量计划**。
计划由人在后台（设置 › 批量计划）审阅、审批并执行；没有任何 MCP 工具、Agent 令牌或 API Key 能审批、确认或执行计划。
规格：`openspec/changes/p10-agent-collaboration-mcp/specs/agents/batch-operations/spec.md`；审批模式见 ADR-0012。

实现：`apps/cms/src/services/agent-plans/`（`plan-rules.ts` 分级与哈希、`plan-service.ts` 审批与执行器）、
`apps/cms/src/routes/agent-plans.ts`（后台接口）、`apps/studio/src/workspace/agent-plans/`（后台页面）。
表：`lumibase_batch_plans`、`lumibase_batch_plan_items`、`lumibase_batch_plan_approvals`（迁移 `0107_p10_plans`，
与授权表一样只在设置了 `app.agent_access` 的事务中可读写）。上游已有的 `lumibase_agent_plans`（内置 Agent 的计划）与此无关。

## 提交（MCP）

| 工具 | 作用 |
|---|---|
| `plans_submit` | `scope`：`{ "siteIds": [...] }` 或 `{ "instance": true }`；`operation`；`arguments`（各站共享）；`perSite`（按站点 ID 的资源 ID 与期望版本） |
| `plans_get` | `scope: { "planId" }`：状态、风险等级、审批数、逐站结果；只有起草者本人的令牌能读 |
| `plans_revise` | 修改尚未开始执行的计划（站点清单、共享参数、逐站参数）；版本号与哈希改变，此前的审批全部失效 |

- 可用操作：`content_create`、`content_update`、`content_publish`、`content_delete`、`site_update_seo_settings`、`theme_activate`。
  修改已有资源必须给出每个站点的 `expectedVersion`；`theme_activate` 给出 `themeVersionId` 与 `expectedActiveVersionId`（当前启用的主题版本，没有则为 `null`）。缺少时整份计划被拒绝（`INVALID_ARGUMENTS`，逐站列出），什么都不存。
- 范围在提交时解析为**固定的站点 ID 清单**并写入范围确认摘要；`instance` 只包含此授权里起草者当时能访问的站点，之后新建的站点永远不会自动加入。
  授权之外的站点使整个提交被拒（403 `SITE_NOT_AUTHORIZED`，列出站点），不会静默缩小范围。
- 起草者是令牌所属的人（OAuth 或个人访问令牌）；站点 API Key 不能起草计划（`PLAN_REQUIRES_PERSON`）。
- 一份计划最多 500 个站点，有效期 72 小时，过期后不能审批或执行（状态变为 `expired`）。

## 风险分级

| 等级 | 条件 | 要求 |
|---|---|---|
| 低 `low` | ≤ 10 站 | 审批 |
| 预览 `preview` | > 10 站 | 审批前查看逐站差异预览 |
| 金丝雀 `canary` | > 25 站 | 另外先在 2 个金丝雀站点执行，人确认结果后才执行其余站点 |
| 最高 `highest` | > 50 站，或高危操作（域名、DNS、删除、全站主题发布、权限变更） | 金丝雀（单站计划时该站即金丝雀）+ 按审批模式的额外要求 |

阈值来自规格，不能通过配置降低。金丝雀站点取排序后的前 1–2 个站点，属于同一份已审批的计划，计入计划哈希。

## 审批（只在后台）

- 计划哈希（SHA-256）覆盖：操作、共享参数、每个站点及其参数与金丝雀标记、起草用户、授权 ID、版本号、风险等级、审批模式、有效期。
  审批记录绑定哈希；审批与执行前都会按存储的数据重新计算哈希，任何改动（包括绕过服务直接改库）都会使审批不再有效（`PLAN_TAMPERED` / `APPROVAL_INVALID`）。
  后台批准时提交页面看到的哈希，计划在此期间被修改则返回 `PLAN_CHANGED`。
- 审批人须是实例管理员，或计划中**每个**站点的管理员。
- **单人模式**：起草者可以审批自己的计划，但必须输入当前的验证器动态码（未开通、错误或缺失都返回 403 `SECOND_FACTOR_REQUIRED`）。
  最高等级批准后进入 **10 分钟冷静期**，期间可以否决或取消；取消后计划不会执行。
- **团队模式**：审批人不能是起草者（403 `SELF_APPROVAL`）；最高等级需要两位不同的审批人（同一人第二次批准返回 403 `SAME_APPROVER`），没有冷静期。
- 审批模式在提交时记入计划；之后切换模式只影响新提交的计划。

## 执行

后台“执行”（或“执行金丝雀”）按钮由起草者或合格审批人触发；执行以**起草者**身份通过与后台相同的 REST 接口进行，实时权限、Hold、发布门禁与版本校验全部生效。

- 需要金丝雀时，第一次执行只跑金丝雀站点，计划进入 `canary_review`；金丝雀全部成功后由合格审批人“确认金丝雀结果”，再执行其余站点。
- 每个站点执行前重新校验：授权未吊销且仍覆盖该站点与工具组、起草者仍是该站点成员；不满足的站点结果为 `forbidden` 并写明原因，其他站点照常执行。
- 逐站结果：`succeeded`、`conflict`（期望版本已被他人修改，或删除前读取到的版本不符）、`forbidden`、`failed`、`cancelled`。冲突需要 Agent 用 `plans_revise` 更新版本后重新审批。
- 幂等与并发：每个站点在执行时被原子领取，只有当前这次执行能领取；正在执行时的第二个执行请求返回 409 `PLAN_ALREADY_RUNNING`，已完成的计划再执行返回 `NOT_APPROVED`，每个站点至多产生一次副作用。新建内容使用由计划与站点派生的幂等键。
- 取消：未开始的站点标记为 `cancelled`，已完成的结果保留。
- 重试：只重置 `failed` 的站点（冲突与无权限不重试），仍须在有效期内且审批有效。

## 后台接口

只接受登录 Studio 的人（会话）；API Key、Agent 令牌与 MCP 内部请求一律 403。

| 接口 | 说明 |
|---|---|
| `GET /api/v1/agent-plans` | 可见的计划：自己起草的，以及涉及自己所属站点的（实例管理员可见全部） |
| `GET /api/v1/agent-plans/:id` | 计划详情、审批记录、当前用户可执行的动作 |
| `GET /api/v1/agent-plans/:id/preview` | 逐站差异：以当前用户身份读取资源的当前值、当前版本与是否过期 |
| `POST /api/v1/agent-plans/:id/approve` | `{ secondFactor?, planHash }` |
| `POST /api/v1/agent-plans/:id/reject` | `{ reason }` |
| `POST /api/v1/agent-plans/:id/cancel` | `{ reason? }` |
| `POST /api/v1/agent-plans/:id/execute` | 执行下一阶段（先金丝雀） |
| `POST /api/v1/agent-plans/:id/canary/confirm` | 确认金丝雀结果 |
| `POST /api/v1/agent-plans/:id/retry` | 重试失败站点 |

每次提交、修订、审批、否决、取消、执行与金丝雀确认都写入系统事件（来源 `agents`）。

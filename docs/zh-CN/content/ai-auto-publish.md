# AI 自动发布

AI 流水线产出的草稿通过[质量门禁](ai-quality-gate.md)后，由自动发布规则决定：直接发布、开启否决窗口、按发布节奏排队，或进入人工审核队列。
任何条件不满足都进入审核队列；自动发布从不绕过 Hold、紧急开关、门禁或来源授权。

实现：`apps/cms/src/services/auto-publish/auto-publish.ts`（条件、候选、最终发布事务、节奏、否决）、
`apps/cms/src/services/auto-publish/locale-set.ts` 与 `apps/cms/src/services/auto-publish/locale-set-service.ts`（必需语言集）、
`apps/cms/src/routes/auto-publish.ts`（接口）。

## 自动发布条件

草稿只有同时满足以下全部条件才会自动发布：

| 条件 | 判定 | 不满足时的原因 |
|---|---|---|
| 来源可信且有授权 | 草稿的每个来源（`lumibase_content_provenance`）：授权为 `licensed` / `own` / `open-license`，信任等级为 `high`，当前条款仍允许所做的操作。没有来源的条目不自动发布 | `licence_unknown`、`licence_not_cleared`、`source_not_trusted`、`usage_refused`、`no_sources` |
| 门禁通过 | 门禁对**当前版本**的结果为通过，或需人工的结果已由人工批准 | `gate_not_passed` |
| 来源时效 | 每个来源文档的发布时间不早于站点阈值（默认 60 天）；发布时间未知视为不新鲜；可按集合豁免 | `source_stale` |
| 信任等级 | 站点流水线角色（默认 `content-pipeline`）在 `publish` 能力上的 LumiBase 信任等级（无授予时为 L1） | `tier_l0` … `tier_l2` |
| 未被叫停 | 站点紧急开关（站点冻结）或该角色的冻结；条目 Hold | `kill_switch`、`hold` |

`unknown` 授权的来源**永不**自动发布，即使人工批准了门禁的需人工结论。增量重译的修订一律进入审核队列（`retranslation_needs_review`）。

## 信任等级

- **L1 / L2**：进入审核队列。
- **L3**：开启否决窗口（默认 30 分钟），窗口结束后发布；窗口内有权限的编辑可一键否决，内容回到审核队列并记录否决人。
  否决按 LumiBase 惯例记一次事故，自动下调该角色在 `publish` 能力上的等级。
- **L4**：立即进入发布队列，节奏允许时当场发布。

## 发布节奏

站点可配置每日自动发布上限（按站点时区的自然日，空为不限）与两次发布的最小间隔。超出的候选保持排队，`not_before`
记录最早可发布时间（次日零点或间隔结束）。调度器每分钟处理到期候选，按提出顺序发布。例如一夜产出 30 篇、上限 10 篇：当天只发布 10 篇，其余顺延到后续日期。

## 发布时重新核验

候选在提出时固定（pin）所依据的内容：条目版本与内容哈希、门禁结果、各来源的授权修订、信任等级、自动发布设置版本。
否决窗口结束或排队到期时，最终发布在**一个事务**中：

1. 锁定候选行与当日计数行；
2. 重新核验上表全部条件，并确认固定的内容均未变化——人工修改（`content_changed`）、授权撤销或修订（`licence_changed`）、
   等级下调（`tier_downgraded`）、设置变化（`policy_changed`）、门禁重跑（`gate_changed`）；
3. 预留当日额度与最小间隔；
4. 发布（经条目服务，Hold 与翻译组规则照常生效）。

任一条件不满足，候选回到审核队列并记录全部原因；旧的门禁结论与批准不会被换版后的内容复用。并发处理时当日计数行串行化，
两个发布者不会合计超过每日上限。

## 必需语言集

站点可配置必需语言（如中文、葡萄牙文、越南文）。同一翻译组中**本站**属于这些语言的成员：

- 自动发布时，全部成员都满足条件才在同一事务中一起发布；任一语言缺失或未通过，全部不发布，候选显示等待的语言（`waiting_for_locales`）。
- 下线任一成员即同时下线其余成员（`POST /locale-sets/:itemId/unpublish`）。
- 单独发布或下线某个语言是显式例外（`POST /locale-sets/:itemId/single`）：需要已登录、对该条目有发布权限的编辑填写原因，
  审计记录带例外标记与原因；例外仍须通过门禁、Hold、来源授权与紧急开关。
- 其他站点的翻译组成员不受本站语言集约束。

普通的单条发布或下线（编辑界面、定时发布）遇到语言集成员时返回 `REQUIRED_LOCALE_SET`。

## 合规边界

- 自动发布只放行有明确授权且可信的来源；授权未知、仅发现、仅事实且未经改写许可的内容一律由人工决定。
- 自动发布不规避检测、不做跨站自动导链；跨站近似重复由门禁拦截。
- 每次自动发布、进入审核、否决与设置变更都写入审计日志（`auto_publish_*`、`locale_set_*`）。

## 接口

| 方法与路径 | 权限 | 作用 |
|---|---|---|
| `GET /api/v1/auto-publish/settings` | 编辑 | 读取设置 |
| `PUT /api/v1/auto-publish/settings` | 站点管理员 | 修改否决窗口、每日上限、最小间隔、来源时效、豁免集合、必需语言与流水线角色（审计） |
| `GET /api/v1/auto-publish/candidates?status=review` | 编辑 | 审核队列（`review`）、否决窗口（`veto_window`）、排队（`queued`）与历史 |
| `POST /api/v1/auto-publish/candidates/:id/veto` | 已登录编辑 | 一键否决 |
| `POST /api/v1/auto-publish/candidates/:id/dismiss` | 已登录编辑 | 关闭审核条目 |
| `POST /api/v1/auto-publish/run-due` | 站点管理员 | 立即处理到期候选 |
| `POST /api/v1/auto-publish/locale-sets/:itemId/publish`、`/unpublish`、`/single` | 已登录编辑 | 语言集整组发布、整组下线、单语言例外 |

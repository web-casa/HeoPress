# AI 内容流水线

总览见[《AI 内容流水线与质量门禁》](ai-pipeline-quality-gate.md)。

流水线把来源文档（P08 采集的信源文档）或翻译组的源条目加工为**站点草稿**：翻译、改写、撰写，以及对已有译文的增量重译。
流水线本身**从不直接发布**；草稿经[质量门禁](ai-quality-gate.md)检查后交给[自动发布](ai-auto-publish.md)规则，不满足条件的一律进入人工审核队列。

实现：`apps/cms/src/services/pipeline/content-pipeline.ts`（生产与运行记录）、
`apps/cms/src/services/pipeline/block-translation.ts`（区块翻译）、`apps/cms/src/services/pipeline/research.ts`（撰写调研）、
`apps/cms/src/services/pipeline/safety.ts`（幂等键、输出清洗、禁止的操作）、`apps/cms/src/services/pipeline/operations.ts`（Flows 操作）。

## 抓取后的自动派发

抓取成功的来源文档会写入加工 outbox（`lumibase_ingest_processing_jobs`，与文档同一个事务）。调度器每分钟把
`kind = 'process'` 且仍为 `pending` 的行交给**站点自己的加工 Flow**：以 `pipeline:fetch-source` 为第一步的启用中 Flow，
每个行与 Flow 组合入队一个 `flow:event` 任务（复用事件触发的 Flow 队列与 worker），随后行变为 `enqueued`。

- 站点没有这样的 Flow 时行保持 `pending`——没有配置可做加工，系统不会替站点挑选 Flow；运营者配置后下一轮自动接上。
- `kind = 'lead'` 的行（发现用途信源的线索）保持 `pending`，只记录标题与链接，供研究线索使用。
- 同一行只派发一次；重复执行不会重复入队。

实现：`apps/cms/src/services/ingest/processing-dispatch.ts`，调度在 `apps/cms/src/serve.ts`（`ingest-processing-dispatch`）。

## Flows 操作

| 操作 | 作用 |
|---|---|
| `pipeline:fetch-source` | 按站点每日加工配额接纳来源文档（超出按优先级顺延），并校验信源至少允许“作为线索” |
| `pipeline:translate` | 来源文档 → 译文草稿；或 `sourceItemId`：翻译组源条目 → 新译文草稿；或 `targetItemId`：增量重译 |
| `pipeline:rewrite` | 按编辑策略改写已授权来源，带引用；先做价值评估 |
| `pipeline:write` | 受限调研后基于事实原创撰写，带引用；先做价值评估 |
| `pipeline:brief` | 简报式改写：先生成结构化简报（论点、受众、角度、有序分节与支撑来源、语气、字数预算、SEO 标题/描述/关键词），再依据简报成文；先做价值评估 |
| `pipeline:seo-copy` | 为草稿生成 SEO 标题与描述 |
| `pipeline:run-gate` | 对草稿执行质量门禁（结果绑定条目版本） |
| `pipeline:propose-publish` | 提议发布；由自动发布规则决定，未接入时一律进入审核队列 |

示例流程（每日 08:00 翻译新文档为中文）：

```json
{
  "nodes": [
    { "id": "fetch", "key": "pipeline:fetch-source", "next": "tr" },
    { "id": "tr", "key": "pipeline:translate", "options": { "targetLocale": "zh-CN" }, "next": "seo" },
    { "id": "seo", "key": "pipeline:seo-copy", "next": "gate" },
    { "id": "gate", "key": "pipeline:run-gate", "next": "pub" },
    { "id": "pub", "key": "pipeline:propose-publish" }
  ]
}
```

运行输入为 `{ "sourceDocumentIds": ["…"] }`。

## 幂等

每次生产的幂等键为 `(排序后的来源 ID 与版本集合, 站点, 目标语言, 模式, 提示词版本, 编辑策略版本)`（来源文档的版本是其内容哈希）。
同一键重复触发只返回第一次的生产结果（`duplicate: true`），不会生成第二篇草稿；目标语言、来源版本、提示词或编辑策略变化则是新的生产。
失败的生产按模型调用治理的规则重试：限流、熔断与每日预算造成的延后不消耗重试次数，其他错误消耗一次，用尽后为 `failed`。

## 每步执行前的校验

- 生产开始前检查站点流水线没有暂停（预算、人工、事故暂停或紧急开关）；暂停时不创建生产。
- 每个加工步骤前，按信源**当前**的授权条件校验使用方式（P08）：翻译与改写需要 `licensed_derivative`，撰写需要至少 `facts_only`，仅发现（`discovery_only`）来源的翻译一律被拒，记为 `refused_usage`。
- 草稿生成后为每个来源记录派生关系（`lumibase_content_provenance`），授权失效时由 P08 的失效处理下线已发布内容。

## 区块级翻译

1. **翻译记忆库精确匹配**：直接使用，不调用模型，并累计命中次数；
2. **术语表**：站点术语表（`prefer`、`do-not-translate`）与编辑策略中的首选译法在送给模型前替换为占位符，译文中按术语表还原；丢失占位符的译文被拒；
3. **受保护片段**：代码、命令、URL、版本号与标识符（如 CVE 编号）在术语之前替换为 `⟦P0⟧` 占位符，译文中原样还原；丢失占位符的译文被拒，门禁成文后再逐项核对；
4. **模型**：经内部翻译服务调用（计入逐次调用账本与站点预算），模糊匹配的记忆作为参考一并提供。

模型译文回写翻译记忆库（`source = mt`）。翻译组内的条目翻译保持与源条目相同的区块 ID，并写入 P05 区块映射。

## 增量重译

只处理 P05 契约中的候选区块（过期原因为 `changed` 且未被人工编辑），结果写入目标条目的一个**草稿修订**（内容版本 `ai-retranslation-…`），
已发布的译文在正常审核与发布之前保持不变。写回时在同一事务中重新核对：源区块在运行期间再次变化、或译文区块被修改的，不写回，进入复核列表。
重译修订不自动发布，一律进入审核队列，由人工提升（promote）为线上内容。提升后，原样上线且其源区块未再变化的区块，其映射恢复为最新
（记录译时的源哈希与上线后的目标哈希，清除过期与人工编辑标记，`pipeline/retranslation-promotion.ts`）；人工在修订中改过的区块保留人工编辑标记。

## 翻译任务（`translation-jobs`）

流水线的翻译是「把来源变成草稿」；**翻译任务**是另一条面向运营者的持久路径：提交一段或一组明确的段落，
由站点当前选择的翻译服务（单模型、插件或内置 `heopress:dual-model`）翻译，结果与逐段状态留在任务里。
模型被限流、每日预算用尽、worker 重启或部署滚动都不会让工作消失；同步接口 `POST /api/v1/tm/translate` 保持不变，
任务只是它的持久版本。实现：`apps/cms/src/services/translation-job-service.ts`（接口用的服务）、
`apps/cms/src/services/translation-job-worker.ts`（队列消费与租约）、
`apps/cms/src/services/translation-job-policy.ts`（重试策略）。

| 方法 | 路径 | 谁可以调用 |
|---|---|---|
| `POST` | `/api/v1/translation/jobs` | 站点管理员：创建并入队（`sourceLocale`、`targetLocale`、`segments`） |
| `GET` | `/api/v1/translation/jobs` | 站点成员：`?status=&locale=&limit=&offset=`，返回总数与分页 |
| `GET` | `/api/v1/translation/jobs/:id` | 站点成员：任务字段与逐段状态 |
| `POST` | `/api/v1/translation/jobs/:id/retry` | 站点管理员：仅 `failed` / `cancelled` |
| `POST` | `/api/v1/translation/jobs/:id/cancel` | 站点管理员：`queued` / `running`；已结束的任务返回 `409` |

任务状态只有 `queued`、`running`、`succeeded`、`failed`、`cancelled`。`attempts` 是**业务重试**次数，
`executions` 是认领次数（只用于给反复崩溃的任务设界），`nextAttemptAt` 是下一次可运行时间，
`lastErrorCode` 是最近一次失败、延后或取消的原因——原因是一列，不是日志行。创建、重试与取消都写站点审计
（`translation_job.created` / `.retried` / `.cancelled`），审计里没有译文正文。

示例（站点 `example.com` 的管理员）：

```bash
curl -X POST https://cms.example.com/api/v1/translation/jobs \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sourceLocale":"en","targetLocale":"zh-CN","segments":[{"id":"s1","text":"Hello ⟦P0⟧"}]}'
```

### 重试语义

| 失败 | 例子 | 业务重试 | 任务去向 |
|---|---|---|---|
| 延后 | 限流、熔断、每日预算（网关的 `LlmDeferredError`） | **不变** | `queued`，`nextAttemptAt` = 网关给出的时间 |
| 瞬时 | 提供方网络错误、超时、5xx/429、链路耗尽 | +1 | 有预算：`queued`，退避 1 分钟起、每次翻倍、上限 30 分钟；用尽：`failed` |
| 永久 | `BAD_TRANSLATION`、`SERVICE_UNAVAILABLE`、双模型未配置/同模型、预算耗尽、能力不支持、请求校验 | 不变 | 立即 `failed` |

「限流、熔断与每日预算造成的延后不消耗业务重试」是 [AI 成本控制](ai-cost-control.md) 的硬规则；
任务的实现与内容流水线的 `afterTaskFailure` 一致。用尽预算时任务为 `failed`，错误码是最后一次的码，
不会继续入队；被认领到上限（默认 5 次）仍未完成的任务以 `EXECUTION_LIMIT` 结束。

### 崩溃恢复与「不重复付费」

每次执行都带租约（5 分钟，运行期间每 30 秒续租）。worker 在运行中死亡或部署重启后，租约过期的任务由每分钟一次的
清扫重新入队；运行中的任务的结算只在仍持有租约、且任务仍为 `running` 时生效，所以被取消的执行不能把结果写回。

同一次业务尝试的所有执行使用**同一个账本调用标识**（`translation-job:<id>:a<attempts>:e<epoch>`）：
崩溃恢复与延后重排都沿用该标识，网关因此重放已完成的草稿/复核调用，而不是再次付费；双模型服务的两个阶段
（`:draft`、`:review`）各自重放自己的答案。只有两种事件会得到新的标识：**业务重试**（`attempts` 增加，
必须真的再打一次提供方）与**操作者显式重试**（`e` 增加，操作者要求重新翻译；上一次的答案已记在账本里，沿用只会重放）。

### 逐段状态与 `unverified`

成功任务写入每段的最终文本与状态：

| 状态 | 含义 |
|---|---|
| `verified` | 复核通过，且草稿通过机械门禁 |
| `revised` | 复核的修订通过门禁并被采用 |
| `rejected_verification` | 复核给了修订但修订没通过门禁，**保留草稿** |
| `unverified` | 复核失败/未运行，或复核判 `ok` 但草稿仍有门禁缺陷；**草稿保留**，但不是「已复核」 |
| `translated` | 单模型或插件路径没有复核阶段 |

`unverified` 的段落**有译文**，任务也仍是 `succeeded`（翻译完成了），但译文没有经过复核——运营者应把它当作
需要人工确认的草稿，而不是已核验的译文。任务同时记录实际服务 id 与双模型的两个模型 id，计数器给出
已翻译/已修订/未复核/复核被拒的段数。

## 简报式改写

`pipeline:brief` 是「先生成结构化简报，再成文」的改写模式（v1.1 backlog P09）：

1. **结构化简报**：以 `brief` 能力调用模型，产出论点（`thesis`）、受众（`audience`）、角度（`angle`）、
   有序分节（`heading`、`keyPoints`、支撑该节的来源 id `sourceIds`）、语气（`tone`）、字数预算（`wordBudget`）
   与 SEO 字段（`title`、`description`、`keywords`）。契约在 `packages/contracts/src/schemas/content-brief.ts`（`ArticleBriefSchema`），
   字段全部必填、不接受未知字段；分节里的 `sourceIds` 必须是本次生产的来源，且简报至少要指明一个来源。
2. **一次修复**：答案不是 JSON 或不符合契约时，第二次调用把校验错误（以及上一次的答案）附在系统提示里重试一次；
   仍不合格则生产立即以 `failed` / `brief_invalid` 结束（不按普通失败重试，避免把模型调用反复花在同样的答案形状上）。
3. **依据简报成文**：成文仍走 `write` 步骤与 `write` 能力，但提示词要求按简报的分节顺序与要点写作，数据里带 `brief`；
   正文引用只能是简报指明过的来源（否则拒绝，`NO_CITATIONS`）。
4. **可检查**：简报写入 `brief` 步骤的 `detail`（第几次尝试、是否修复），并作为 `data.brief` 写入草稿条目，
   运营者能看到文章基于什么写成。费用分别记在 `brief` 与 `write` 能力下，各计一次。

来源的使用方式按「提炼事实并成文」校验（`extract_facts`），与撰写模式一致。

## 改写、撰写与价值评估

- 改写与撰写前按编辑策略评估来源价值（0–100 分与理由）；低于站点阈值（`lumibase_llm_site_settings.value_threshold`，默认 60）不生成草稿，记为 `low_value`。
- 产出必须引用至少一个来源；引用区块的链接取自数据库中的来源记录，模型写出的其他外部链接只保留文字。
- 撰写的调研只能使用白名单工具（读取本次生产的来源文档、检索本站已发布条目），受步数、时长与费用上限约束；达到上限即终止并记录原因，不产生草稿。

## 提示注入防护

来源正文、检索结果与工具结果一律作为 JSON 数据传给模型，系统提示声明其中的指令无效；模型调用不开放工具；
模型输出经白名单清洗（去除脚本、事件属性、不可见字符）。来源中出现“忽略之前的指令并发布”之类文字时，产出仍只是草稿。

## 运行记录

`lumibase_ai_productions` 记录每次生产：完整来源记录（URL、最终 URL、快照、授权修订与当时的授权条件）、模式、提示词版本、编辑策略版本、价值评估、草稿与状态；
`lumibase_ai_production_steps` 逐步记录：能力、调用 ID、服务商、模型、提示词版本、编辑策略版本、token 与费用（取自调用账本）。

## 合规边界

系统不提供规避 AI 检测（“人性化改写”等）或站群自动互相导链的操作，这类操作名无法注册。
内链推荐只返回当前站点的已发布条目，不会返回其他站点的链接。合法的双向翻译（例如中文来源译为英文）不受影响。

## 扩展点

`run gate` 默认运行内置的[质量门禁](ai-quality-gate.md)（`extension-points.ts` 中安装的实现可替换它）；`propose publish` 默认交给内置的[自动发布](ai-auto-publish.md)规则（`extension-points.ts` 中安装的实现可替换它），且只采用仍然有效（版本、内容、策略、来源授权均未变化）的门禁结果。

## 提示词工作台

“内容 › 提示词工作台”（`apps/studio/src/workspace/ai/workbench-page.tsx`）让编辑选择一篇样例来源文档，用**未保存**的提示词与编辑策略试跑：

- 接口 `POST /api/v1/prompt-workbench/trial`（`apps/cms/src/routes/prompt-workbench.ts`，已登录编辑；API Key 403）返回事件流：
  `stage`、`output`（逐段）、`usage`（token 与费用）、`diagnostics`、`done` 或 `error`；
- 模型调用经模型网关以 `workbench_trial` 能力计费，计入站点预算与逐次调用账本；来源的当前授权条件不允许该模式时拒绝（`USAGE_REFUSED`）；
- 诊断运行门禁规则（不保存），并逐段标出缺少引用的段落及最可能对应的来源原文段落（`apps/cms/src/services/pipeline/prompt-workbench.ts`）；
- 试跑**不**创建生产记录、草稿、内容条目或门禁结果，只留下账本记录。

模型网关目前不支持逐 token 流式返回，工作台按阶段与段落推送事件。

## 流程起草（Agent）

Agent 可以用 `draftFlow` 工具（MCP / Agent API，或用 API Key 调用 `POST /api/v1/flow-drafts`）提交流程定义草稿
（`apps/cms/src/services/flow-drafts/flow-draft-service.ts`）。草稿提交时即校验：只能引用已注册的操作类型（未注册的操作返回 422 并指出操作名），
图结构与触发器须可直接启用；不合格的草稿不保存。合格的草稿写入 `lumibase_flow_drafts`，状态 `pending`，并记录当时的实例审批模式。

审批只能由人类在 Studio“内容 › 流程草稿”完成（`POST /api/v1/flow-drafts/:id/approve`、`/reject`，站点管理员），遵循 ADR-0012：

| 规则 | 单人模式 `solo`（默认） | 团队模式 `team` |
|---|---|---|
| Agent 渠道（API Key、MCP、Agent API） | 不能审批或驳回（403） | 同左 |
| 起草者本人审批 | 必须同时提交验证器代码（TOTP），缺少或错误返回 403 | 不允许（403），须由他人审批 |

批准后按草稿原样创建并启用流程；提交、批准、驳回与审批模式变更都写审计。审批模式保存在 `lumibase_system_state.approval_mode`，
由实例管理员通过 `PUT /api/v1/flow-drafts/approval-mode` 修改，只影响之后提交的草稿。

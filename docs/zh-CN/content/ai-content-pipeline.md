# AI 内容流水线

总览见[《AI 内容流水线与质量门禁》](ai-pipeline-quality-gate.md)。

流水线把来源文档（P08 采集的信源文档）或翻译组的源条目加工为**站点草稿**：翻译、改写、撰写，以及对已有译文的增量重译。
流水线本身**从不直接发布**；草稿经[质量门禁](ai-quality-gate.md)检查后交给[自动发布](ai-auto-publish.md)规则，不满足条件的一律进入人工审核队列。

实现：`apps/cms/src/services/pipeline/content-pipeline.ts`（生产与运行记录）、
`apps/cms/src/services/pipeline/block-translation.ts`（区块翻译）、`apps/cms/src/services/pipeline/research.ts`（撰写调研）、
`apps/cms/src/services/pipeline/safety.ts`（幂等键、输出清洗、禁止的操作）、`apps/cms/src/services/pipeline/operations.ts`（Flows 操作）。

## Flows 操作

| 操作 | 作用 |
|---|---|
| `pipeline:fetch-source` | 按站点每日加工配额接纳来源文档（超出按优先级顺延），并校验信源至少允许“作为线索” |
| `pipeline:translate` | 来源文档 → 译文草稿；或 `sourceItemId`：翻译组源条目 → 新译文草稿；或 `targetItemId`：增量重译 |
| `pipeline:rewrite` | 按编辑策略改写已授权来源，带引用；先做价值评估 |
| `pipeline:write` | 受限调研后基于事实原创撰写，带引用；先做价值评估 |
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

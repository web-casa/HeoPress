# AI 质量门禁

质量门禁在发布前检查 AI 流水线产出的草稿，是自动发布的硬性前提。每项检查给出结论（通过、拦截、需人工，事实核查只给警告）、
分数、证据与修改建议；门禁结果绑定被检查的版本，内容、策略或来源授权变化后失效，发布前必须重跑。

实现：`apps/cms/src/services/quality-gate/quality-gate.ts`（运行、结果有效性、人工审核、档位）、
`apps/cms/src/services/quality-gate/rules.ts`（检查规则）、`apps/cms/src/services/quality-gate/protected-fragments.ts`（受保护片段）、
`apps/cms/src/routes/quality-gate.ts`（接口）。

## 检查项

| 检查项 | 内容 | 强制 |
|---|---|---|
| `source_rights` | 每个来源的**当前**授权：`licensed` / `own` / `open-license` 且使用方式允许当前操作为通过；`unknown` 为需人工；其余拦截。站内条目（翻译组源条目）视为自有 | 是 |
| `near_duplicate` | 与本站及其他站点已发布内容的相似度（英文按 5 词片段、中日韩按 3 字片段的 Jaccard 相似度，默认阈值 0.8）。草稿所在翻译组中显式关联的**其他语言**成员按翻译规则判定，不算重复；同语言成员与未关联的跨站复制一律拦截 | 否 |
| `citations` | 改写与撰写必须带引用；引用 URL 经 SSRF 防护的出站抓取（P08 `fetchPage`）确认可访问 | 否 |
| `editorial_rules` | 当前生效的编辑策略版本（禁写主题、术语表中应避免的写法）与站点生效的 Constitution（LumiBase 版本化、带哈希的规则 DSL；`llm_judge` 评审经模型网关计费） | 否 |
| `safety` | 个人信息（邮箱、电话、身份证号、银行卡号、密钥）与违法内容。安全拦截只能修复后重跑，**不能**被人工批准 | 是 |
| `seo_completeness` | 标题、描述、slug、语言（须为站点可用语言）、canonical（未显式设置时为自身；显式设置须为绝对 URL） | 否 |
| `seo_lengths` | 标题 10–70、描述 50–170 个字符宽度（中日韩字符计 2） | 否 |
| `literal_integrity` | 受保护片段逐项核对：翻译时来源中的每个片段都必须原样出现；改写与撰写可以不用，但出现时不得改动。证据列出原值与草稿值 | 是 |
| `text_overlap` | 来自“仅事实”信源的草稿，逐段与原文比较重合度（默认 0.6），照搬段落拦截，证据含该段、原文与逐词差异 | 是 |
| `hidden_content` | 不可见 Unicode 字符、隐藏文本（`display:none` 等）、HTML 注释与写给模型的指令；证据指出字段与段落 | 是 |
| `fact_check` | 可选的模型事实核查，经模型网关以 `fact_check` 能力计费；只给警告，不拦截，也不能单独使文章通过 | 否（默认关闭） |

跨站近似重复的证据只保存站点 ID、条目 ID 与相似度，不保存对方内容；接口只向**当前**在对方站点有编辑或管理权限的调用者显示这些 ID，
其他人只看到 `duplicateElsewhere: true`。

## 受保护片段

翻译前，代码块与行内代码（命令按常见命令行识别为 `command`）、URL（含链接地址）、标识符（CVE、GHSA、RFC 编号）与版本号
（`1.25.3`、`v2.1` 形式）先替换为 `⟦P0⟧` 占位符，再处理术语表；模型只看到占位符，译文中原样还原，丢失占位符的译文被拒。
成文后门禁再次逐项核对（`literal_integrity`）。

## 结果绑定与失效

门禁结果写入 `lumibase_quality_gate_results`，绑定：

- 条目版本与内容哈希；
- 门禁策略哈希：各检查项档位、阈值、编辑策略版本、生效 Constitution 的哈希；
- 每个来源文档当时的授权修订。

任何一项变化后结果状态为 `stale`（并给出原因：`item_version_changed`、`content_changed`、`policy_changed`、`licence_changed`），
不可发布，必须重跑门禁。发布提议只采用仍有效的结果。

## 人工审核

结论为“需人工”的结果由已登录的编辑针对**该结果检查的版本**批准或驳回，并填写理由（`lumibase_quality_gate_reviews`，写审计日志
`quality_gate_reviewed`）。API 密钥与 Agent 不能审核。批准只适用于原版本：之后内容变化或结果失效，批准不再有效。
被拦截的结果不可批准，必须修复后重跑。人工批准不改变信源可信度或授权状态，也不绕过 Hold、权限与紧急开关（发布时另行校验）。

## 站点级档位

每项检查可设为 `block`（拦截）、`warn`（仅警告）或 `off`（关闭）。`source_rights`、`safety`、`literal_integrity`、`text_overlap`
与 `hidden_content` 为强制项，关闭或降为警告的请求被拒绝；`fact_check` 最高为 `warn`。档位变更需要理由，写审计日志
`quality_gate_level_changed`（操作者、原因、原档位、新档位），并按新档位重新判定已有结果（无需重跑规则）。

## 接口

站点范围内（`/api/v1/quality-gate`）：

| 方法与路径 | 说明 | 权限 |
|---|---|---|
| `GET /settings` | 档位、阈值、强制项 | 编辑 |
| `PUT /settings/levels` | `{check, level, reason}` 修改一项档位 | 站点管理员 |
| `GET /productions/:id` | 生产的全部门禁结果（分数、各项证据与建议）及最新结果是否仍有效 | 编辑 |
| `POST /productions/:id/run` | 对草稿运行门禁 | 编辑 |
| `GET /items/:itemId` | 条目当前门禁状态：`missing`、`stale`、`passed`、`blocked`、`needs_review`、`approved`、`rejected` | 编辑 |
| `POST /results/:id/review` | `{decision: approve\|reject, reason, itemVersion}` 人工审核 | 已登录的编辑 |

Studio 的“内容 › AI 审核”页面读取 `GET /api/v1/auto-publish/review-queue`，展示上述分数、证据与建议并批量处理，见[自动发布](ai-auto-publish.md)。

提示词工作台用 `QualityGate.diagnose` 对未保存的试跑产出运行同一套规则：不写入门禁结果，不调用模型（Constitution 评审与事实核查标为“未运行”），
不抓取引用 URL。

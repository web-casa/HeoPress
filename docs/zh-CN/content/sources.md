# 信源

每个站点维护自己的**信源**：要关注什么（RSS / Atom、sitemap、列表页、单个 URL）、何时检查（按信源自己的时区）、每次最多采集多少条，以及其内容**可以怎样使用**。信源是 P08 内容采集的输入；发现新 URL 与去重见[发现与去重](discovery-dedup.md)，抓取与抽取见[抓取与抽取](fetching.md)；本页描述信源本身的管理、授权、调度与健康。

实现：表结构 `packages/database/src/schema/ingest.ts`，服务 `apps/cms/src/services/ingest/source-service.ts`，调度与任务 `apps/cms/src/services/ingest/source-worker.ts`，接口 `apps/cms/src/routes/ingest-sources.ts`，Studio“内容 → 信源”页面（`/content/sources`）。

## 信源字段

| 字段 | 说明 |
|---|---|
| 类型 | `rss`、`atom`、`sitemap`、`list_page`（需配置条目与链接的 CSS 选择器）、`url`、`plugin`（插件提供的信源类型，需指定适配器 `adapter`：`<插件名>#<适配器>`） |
| 计划 | 每日本地时间列表（`HH:MM`，24 小时制，最多 24 个）+ IANA 时区，例如 `08:00, 20:00` + `Asia/Shanghai` |
| 每次最多条数 | 1–200，默认 20 |
| 授权状态 | `unknown`（默认）、`licensed`、`own`、`open-license` |
| 使用方式 | `discovery_only`（默认，仅发现）、`facts_only`（仅事实）、`licensed_derivative`（授权衍生） |
| 商用、复核到期日、信任等级、署名要求 | 默认不可商用、无复核日、`low` 信任、无署名要求 |

新信源的授权与使用方式一律从默认值开始：**授权未知、仅发现、不可商用、低信任**。

插件信源（P12）：适配器只负责发现链接，链接由主线登记、规范化、去重后按普通抓取任务进入文档流水线（robots.txt、统一出站边界、内容去重）。
信源地址必须是该插件声明的 `http:fetch:<主机>` 之一，否则新建或修改返回 `400 HOST_NOT_DECLARED`；适配器访问未声明的主机时本次运行以 `blocked` 失败并记录拒绝事件。
插件停用或等待重新确认权限时，其信源类型不再可选，已有信源的运行失败并说明原因。

## 授权与条款只能由管理员设置

授权状态、使用方式、商用许可、复核到期日、信任等级与署名要求统称“条款”，只能由**站点管理员**通过一次**授权修订**更改：

- 每次修订追加一条记录（`lumibase_ingest_source_licences`），包含证据（合同编号、许可链接等）、范围、生效与到期时间、复核到期日、署名条件、设置人与时间；修订记录只追加、不修改。
- 新建信源时自动写入第一条修订（默认条款，设置人为创建者）。
- 设置“授权衍生”必须同时给出已知的授权状态与证据。
- 新建或编辑信源时请求体里带条款字段：非管理员返回 403，管理员返回 400（须走修订接口）。
- 条款只能经由信源服务写入；抓取到的网页、模型输出都不能提高信任等级或授权。

## 使用方式与授权失效（供 P09 调用）

加工流水线在每一步之前调用 `assertUsageAllowed(terms, operation)`（`apps/cms/src/services/ingest/usage.ts`），`operation` 为 `use_as_lead`、`extract_facts`、`translate`、`rewrite`：

| 使用方式 | 允许的操作 |
|---|---|
| 仅发现 | `use_as_lead` |
| 仅事实 | `use_as_lead`、`extract_facts` |
| 授权衍生 | 全部——但仅在授权**生效**期间 |

授权生效指：已到生效时间、未过有效期、复核未逾期。授权过期、尚未生效或复核逾期时，信源按“仅发现”处理，衍生操作被拒绝并要求人工复核（`reviewRequired: true`，原因码 `licence_expired`、`licence_not_started`、`review_overdue`）。该函数从不抛出异常：拒绝结果是带原因码的值，由调用方记录。接口返回的信源包含 `licenceEffective` 与 `effectiveUsageMode`，Studio 以“授权未生效：复核前仅作发现”提示。

## 授权失效后的已发布衍生内容

- 加工生成内容时记录来源关系（`lumibase_content_provenance`：内容条目 ↔ 来源文档 ↔ 信源）。有来源关系的信源不能删除（409 `IN_USE`）。
- 每 10 分钟的定时任务 `ingest-licence-lapse` 检查每个站点已发布、且有来源的信源授权已失效（过期、未生效、复核逾期或已撤销）的内容。同一内容、同一信源、同一授权修订只处置一次。
- 处置方式是站点设置（`licenceLapsePolicy`）：
  - `hide`（默认）：内容退回草稿并加发布保留（`hold`），从公开读取、站点页面与 sitemap 中消失；状态变更与变更事件（`changedFields: ["status","hold"]`，`reason: licence_lapse`）在同一事务中写入。
  - `flag`：内容保持公开，只登记复核。
- 两种方式都在复核队列（`lumibase_licence_lapse_reviews`）登记一行，记下处置前的状态，并给站点管理员发送站内通知（隐藏时为撤稿通知）。
- 授权续期后内容**不会**自动恢复：必须由站点管理员本人（API 密钥不行）在复核队列中逐条或批量恢复，且此时所有来源的授权都已生效，否则拒绝（`LICENCE_NOT_EFFECTIVE`）。复核未关闭时，解除发布保留返回 409 `LICENCE_REVIEW_OPEN`。也可以“忽略”：保持当前状态并关闭复核。
- Studio：内容 › 信源 › 许可复核 / 采集设置。

## 研究线索（仅发现信源）

- “仅发现”信源的正文**从不**进入加工：来源文档登记后只生成 `lead` 类型的加工任务。
- 正文中指向站点“一手来源白名单”（`primarySourcePatterns`，每项为主机或“主机/路径”前缀，`*.` 匹配子域）的链接登记为研究线索（`lumibase_ingest_research_leads`），其余链接不登记。
- 线索目标按**自己的**信源规则抓取：本站已有该主机的信源时用它；否则自动建立一个受管信源（`managedBy: research_leads`，暂停、默认条款即“仅发现”、不能手动恢复）。线索从不继承原信源的授权；要使用线索内容，管理员需要为目标信源单独记录条款。

## 调度

- 计划时间按信源自己的时区解释，因此不同站点、不同时区的“08:00”是不同的时刻；夏令时切换日：不存在的本地时间（如纽约春季跳过的 02:30）在切换后按落入空档的分钟数运行（03:30），重复出现的本地时间只运行一次（较早的那次）。
- 每分钟的定时任务 `ingest-schedule` 读取到期的 `lumibase_ingest_schedule` 行（该表只含 ID 与时间，跨站读取，不受行级安全限制），在信源所属站点的范围内以“比较并设置”把下次运行时间推进到下一个计划时刻，并向持久化队列 `ingest-sources` 投递一个任务，单例键为 `ingest-source:<信源 ID>`：同一信源同一时刻只运行一个任务。
- 每次运行在 `lumibase_ingest_source_runs` 记一行，`(信源, 计划时刻)` 唯一，重复投递的任务不会重复运行。
- 进程停机期间错过的时刻不逐一补跑：恢复后下次运行是“现在之后的第一个计划时刻”。
- 暂停的信源没有调度行，不会运行。

## 健康与自动暂停

- 一次运行失败时记录失败类别：`network`、`timeout`、`access_denied`、`blocked`（出站安全拦截）、`extraction`、`quota`、`other`，连续失败计数加一；成功一次计数清零。抓取如何归类见[抓取与抽取](fetching.md)。
- 连续失败达到阈值（默认 5，环境变量 `HEOPRESS_INGEST_FAILURE_THRESHOLD`）时信源自动暂停（`pausedReason: failures`），并给站点的每位管理员发送一条站内通知，说明失败次数与最后一次的失败类别。
- 恢复只能由站点管理员手动操作（`POST /api/v1/ingest/sources/:id/resume`），恢复时计数清零并重新排期；编辑可以手动暂停。

## 接口

| 接口 | 权限 |
|---|---|
| `GET /api/v1/ingest/sources`、`GET /api/v1/ingest/sources/:id` | 站点成员 |
| `POST /api/v1/ingest/sources` 新建 | 站点编辑 |
| `GET /api/v1/ingest/sources/adapters` 本站插件提供的信源类型（`ref`、插件、名称、可访问主机） | 站点成员 |
| `PATCH /api/v1/ingest/sources/:id` 修改类型、URL、计划、条数 | 站点编辑 |
| `DELETE /api/v1/ingest/sources/:id` | 站点管理员 |
| `GET /api/v1/ingest/sources/:id/licences` 授权修订历史 | 站点成员 |
| `POST /api/v1/ingest/sources/:id/licences` 记录新条款与证据 | 站点管理员 |
| `GET /api/v1/ingest/sources/:id/runs` 最近运行 | 站点成员 |
| `POST /api/v1/ingest/sources/:id/pause` | 站点编辑 |
| `POST /api/v1/ingest/sources/:id/resume` | 站点管理员 |
| `GET /api/v1/ingest/settings` / `PUT` 失效处置与一手来源白名单 | 站点成员 / 站点管理员 |
| `GET /api/v1/ingest/licence-reviews`（`?state=all` 含已关闭） | 站点成员 |
| `POST /api/v1/ingest/licence-reviews/resolve` `{ ids, decision: "restore" \| "dismiss" }` | 站点管理员本人 |
| `GET /api/v1/ingest/leads` 最近的研究线索 | 站点成员 |
| `PUT /api/v1/ingest/media-licences` 单个媒体的授权 | 站点管理员 |

只在站点 A 有写权限的用户为站点 B 添加或暂停信源返回 403；另一站点的凭据返回 401；用站点 A 的身份访问站点 B 的信源 ID 返回 404。信源、授权修订与运行记录受行级安全隔离（`packages/database/migrations/rls-policies.sql`）。

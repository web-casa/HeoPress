# 站群内容模型

站群中每个站点都从同一套**预设集合**起步，按站点配置语言、时区、固定链接、尾斜杠与站点类型；旧站迁移时可批量导入重定向；赞助内容有统一的标记与站点策略。

实现：`apps/cms/src/services/site-network/preset.ts`（预设定义）、`apps/cms/src/services/site-network/preset-installer.ts`（安装与升级）、
`apps/cms/src/services/site-network/content-settings-service.ts`（站点内容设置）、`apps/cms/src/services/site-network/content-routes.ts`（固定链接与路由）、
`apps/cms/src/services/site-network/redirect-import.ts`（重定向导入）、`apps/cms/src/services/site-network/sponsored-items.ts`（赞助条目）。

## 新建站点

实例管理员（首次安装时创建的引导管理员）在 Studio 页头的站点切换处点“New site”，填写站点标识（小写字母、数字、`-`、`_`）、名称与默认语言；
或调用 `POST /api/v1/instance/sites`（`{ id, name, defaultLanguage? }`），删除站点为 `DELETE /api/v1/instance/sites/<id>`。

站点、下文的预设集合与内容设置、系统角色（Administrator、Member）以及“创建者是该站点的 Administrator”在**同一事务**中建立：任一步失败都整体回滚，
不会留下没有管理员的站点。建好后创建者立即可以在新站点上添加域名、安装主题、分配角色；其他用户不会因此获得任何权限。
只有引导管理员可以建站与删站，任何站点的管理员角色都不够。删站不能删除最后一个站点，也不能删除自己当前登录的站点；删站与审计记录在同一事务中完成。
被删除站点的 ID 在 25 小时内不能被新站点使用（数据库触发器保证，长于任何站点缓存的寿命），避免缓存中残留的权限、路由等信息被同名新站点读到。实现：`apps/cms/src/services/sites/site-provisioning.ts`、`apps/cms/src/routes/sites.ts`。

## 预设集合

建站时安装预设 `site-network`：

| 集合 | 主要字段 |
|---|---|
| `articles` / `pages` | 标题、slug、摘要、正文（区块）、SEO 标题 / 描述 / 社交图片 / 收录设置、canonical、来源 URL / 许可 / 署名、语言（`locale`）、赞助标记与赞助方；文章另有主分类、分类、标签、作者 |
| `categories` / `tags` / `authors` | 名称、slug、收录设置（预设第 2 版）等；短字段的多语言值存在条目自身的 `translations` 字段（`{ <语言>: { name, description? } }`） |

状态、Hold、发布时间是条目的列，不是字段。预设安装的集合与字段带 `meta.preset` 标记；预设升级只**新增**缺少的集合与字段，不修改、不删除站点已有或自定义的字段，并输出报告。
预设版本 3（P07）为文章与页面新增“问答”字段 `faq`（重复字段：问题、答案，每行有稳定的区块 ID），页面的 FAQPage 结构化数据只来自它；以问号结尾的标题不会生成 FAQPage。
预设版本 4（P07）新增“结构化数据（JSON-LD）”字段 `structured_data`（代码编辑器，SEO 分组）：条目自己的 schema.org 节点（例如带 `"@id": "#event"` 的 Event），
校验后合并进页面唯一的结构化数据图（见 `docs/zh-CN/rendering/site-classic.md`）；这段文本本身不是公开字段。
worker 在启动时与之后每小时把使用该预设、版本低于当前的站点逐个升级（每个站点一个事务，中断后从未升级的站点继续，重复执行不再改动）；
站点已有同名的自定义字段时不覆盖，跳过原因与新增内容一起保存在该站点的预设记录（`lumibase_site_presets.report`）中，站点管理员可在 Studio 的“设置 → Content”底部
或 `GET /api/v1/site/preset` 查看。FAQPage 只来自预设自己的问答字段（按预设标记识别，站点改名后仍然有效；只是同名的自定义字段不算），投影把它放进公开行的 `structured` 列。

每个条目有站点内、按集合递增的数字编号（`items.number`，从不复用），可用于固定链接。

## 站点内容设置

`GET /api/v1/site/content-settings`、`PUT /api/v1/site/content-settings`（站点管理员；带 `version` 防止覆盖他人的修改）：

- 可用语言（必须包含站点默认语言）、时区（固定链接日期按此时区计算）、站点类型（`blog` / `news` / `docs` / `catalog` / `other`）；
- 尾斜杠策略：`always` 或 `never`，不符合策略的请求 301 到规范形式；
- 语言 URL 策略与前缀，见 [语言路由](../i18n/locale-routing.md)；
- 每个集合的固定链接模式、跨站翻译开关（见 [翻译组](../i18n/translation-groups.md)）、赞助策略（见下）。

站点默认语言用 `PATCH /api/v1/site` 修改，新的默认语言必须已在可用语言中。

## 固定链接

模式按集合配置，变量：`:slug`、`:id`（条目数字编号）、`:year`、`:month`、`:day`、`:category`（主分类的 slug）、`:collection`。
模式**必须**含 `:slug` 或 `:id`，否则保存被拒绝。例如文章 `/:year/:month/:day/:slug`、页面 `/:slug`。

- 日期取条目的**首次发布时间**（`published_at`，首次发布时写入，之后不变）。引入此字段之前已发布的条目以创建时间估算并标记为估算（`estimated`）；
  当时未发布的条目在预设升级报告中单列为“历史未知”。站点管理员可以补录或确认首次发布时间（写审计，路径随之变化并留下 301）。
- 同一站点同一语言下路径唯一，冲突返回 409 并指出占用者；路径不能以保留路径（后台路径、API 等）、公开站点自己的文件（`robots.txt`、`sitemap*.xml`、订阅源 `feed` / `rss` / `atom` 及其变体、`llms*.txt`、`.well-known`、带 `.txt` `.xml` `.html` `.json` 等扩展名的根文件，P07）或语言前缀开头。升级到 P07 时若已有内容占用这些路径，迁移会列出它们并停止，需先改路径（可加重定向）再升级。
- 已发布条目的 slug（或日期、分类）变化时，在同一事务内写入从旧路径到新路径的 301；指向旧路径的规则同时改指向新路径（压平为一跳）。
- 修改模式或时区会在一个事务内重建受影响的路径；有冲突则整个修改被拒绝。

## 批量导入重定向

`POST /api/v1/redirects/import?dryRun=1` `{ content, format?, importConflicting? }` 先返回预演报告；再以报告中的 `reportHash` 调用
`POST /api/v1/redirects/import` 导入（站点在两次调用之间有变化时返回 409，需重新预演）。仅站点管理员可用。

- 支持的格式（未指定时自动识别）：通用 CSV（`from,to[,type]`，`type` 为 `exact` / `prefix`，或源以 `/*` 结尾）、WordPress Redirection 的 JSON / CSV 导出、Yoast SEO Premium、Rank Math。
- 能等价转换的规则成为精确或前缀规则；正则规则只接受两种等价形状，其余（以及条件匹配、非 301/308、其他主机等）逐条列入报告的“需人工处理”，**不会静默丢弃**。
- 规则整体必须能证明不会循环：形成循环的规则不导入；无法证明终止的组合列为需人工处理；去掉某条规则后暴露的新循环同样被识别。
  例如 `/blog → /`（前缀）与 `/foo → /bar` 都能导入，访问 `/blog/foo` 一次 301 到 `/bar`。
- 任一请求（含别名域名、语言前缀与尾斜杠的规范化）只得到**一次** 301，直接到最终地址。

已有规则：`GET /api/v1/redirects`（`?check=1` 附上整站不被接受的规则及原因，会检查全部规则，较慢，复核时调用一次即可），`POST /api/v1/redirects/delete` 按 ID 删除。

## 赞助内容

- 条目字段 `sponsored`（是否赞助）与 `sponsor_name`（赞助方）。已发布条目修改赞助标记必须给出原因（否则 422），并写审计 `item_sponsor_changed`。
- 站点策略两个开关（默认都开）：显示赞助披露、链接加 `rel="sponsored"`。关闭任一开关前须确认其风险（接口返回 422 `RISK_ACK_REQUIRED` 并说明风险，Studio 弹窗确认）；
  修改须写原因，写审计 `site_sponsor_policy_changed`（含确认的风险）。
- 策略变化写 `site_content_settings` 事件；渲染层据此重新渲染受影响的已发布赞助条目（列表：`GET /api/v1/site/sponsored-items`）。渲染时的披露与链接属性由 P06 / P11 执行（ADR-0016）。

---
version: 1
lastUpdated: 2026-10-29T11:51:38.645Z
sourceLang: zh-CN
contentHash: 87414264a4daf3fd
---

# 用户指南

面向编辑、站点管理员与站群运营者：用 Studio 管理多个站点，从采集、AI 加工、审核到发布。
每一节先说明功能能做什么、边界在哪里，再链接到详细的专题页。部署与维护实例见[运维指南](operations.md)。

## 1. 登录与 Studio

Studio 是管理后台，只在**私有后台路径**下提供（安装时生成，例如 `https://admin.example.com/<admin-path>/`），公开站点域名上没有任何管理入口。
首个管理员（引导管理员）由安装脚本创建，凭据只写入服务器上的凭据文件，见[安装](../operations/install.md)。

Studio 有八个模块：概览、内容、站点、SEO / GEO、AI 流量、审计、日志与监控、设置。页头的站点切换器决定当前站点，“全部站点”只提供只读汇总。
界面语言为简体中文与 English。`⌘K` / `Ctrl K` 搜索并跳转，`?` 显示快捷键。

- 模块与通用操作：[Studio 使用说明](../studio/README.md)
- 成员、角色、API 与密钥、通知等设置：[设置](../studio/settings.md)、[通知](../studio/notifications.md)

## 2. 站点与域名

- **新建站点**：只有引导管理员能建站与删站。新站点自动安装预设集合（文章、页面、分类、标签、作者），创建者成为该站点的管理员。
- **内容设置**：每个站点有自己的语言、时区、固定链接（按集合）、尾斜杠与站点类型；旧站迁移时可批量导入重定向。
  见[站群内容模型](../content/site-network-model.md)。
- **编辑策略**：每个站点一份版本化的受众、语气、术语、引用政策与禁区话题，AI 任务与外部 Agent 都读取当前生效的版本。
  见[编辑策略](../content/editorial-profiles.md)。
- **域名与证书**：站点管理员为站点添加域名，验证域名归属后才对外提供服务；证书在首次访问时按需签发。
  见 [Custom domains and on-demand TLS](../../en/deployment/custom-domains.md)（英文）。
- **多语言**：同一内容的各语言版本是独立条目，通过翻译组关联（可以跨站点、跨域名）；URL 策略有三种，请求语言只由域名与路径决定。
  见[翻译组](../i18n/translation-groups.md)、[语言路由](../i18n/locale-routing.md)、[译文新鲜度](../i18n/translation-freshness.md)。

## 3. 内容与审稿

- **文章编辑器**：三栏布局（大纲、正文、检查器），正文为区块编辑，配置对象存储后可在正文中上传图片与视频；保存基于打开时的版本，他人先保存时不会被静默覆盖。
- **审稿工作台**：收件箱、我的稿件、待审核、定时发布等视图；批准与退回只能由人在 Studio 中操作，API Key、Agent 与 MCP 工具一律被拒绝。
  见[内容与审稿工作台](../studio/content.md)。
- **Hold 与定时发布**：条目可被 Hold（任何自动流程都不会发布它），也可设定未来的发布时间。
- **预览**：用签名、限时的链接，在站点的真实外观下预览草稿或未发布的主题版本，预览不会被收录或缓存。
  见[草稿与主题预览](../rendering/preview.md)。
- **赞助内容**：赞助条目有统一的标记与披露，由系统输出，主题不能去掉。

## 4. SEO / GEO

HeoPress 为每个站点输出标准、可核验的信号：标题与描述模板、canonical、hreflang、robots 指令与 AI 爬虫策略、JSON-LD 结构化数据、
分片 sitemap、`llms.txt`、Markdown 副本与 IndexNow 推送。这些功能让页面更容易被抓取和理解，**不承诺任何排名、收录或被 AI 引用**。

- 设置项逐项说明与限制：[SEO / GEO 功能说明](../seo/seo-geo-guide.md)、[Studio 中的 SEO / GEO](../studio/seo-geo.md)
- 站点审计、站内链接图与变更影响预览：[站内链接、站点审计与变更影响](../seo/links-and-audit.md)、[审计与问题处置](../studio/audit.md)
- AI 爬虫访问与 AI 引荐流量：[AI 流量](../studio/ai-traffic.md)

## 5. AI 内容流水线

一篇 AI 稿件的路径：**信源 → 抓取与去重 → 流水线加工（翻译、改写、撰写）→ 质量门禁 → 自动发布或人工审核**。
流水线从不直接发布；任一条件不满足的稿件都进入审核队列，自动发布也从不绕过 Hold、紧急开关、质量门禁或来源授权。
总览见[AI 内容流水线与质量门禁](../content/ai-pipeline-quality-gate.md)。

| 环节 | 说明 | 专题页 |
|---|---|---|
| 信源 | RSS / Atom、sitemap、列表页与单个 URL；每个信源记录内容的授权与可用方式，只有管理员能设置 | [信源](../content/sources.md) |
| 抓取 | 原生抓取遵守 robots.txt 并按主机限速，所有外部请求经过 SSRF 防护；技术失败时可降级到外部采集服务 | [抓取与抽取](../content/fetching.md)、[采集服务配置](../content/crawl-services.md) |
| 去重 | 精确去重、近似重复检测与同一事件聚合 | [发现与去重](../content/discovery-dedup.md) |
| 加工 | 区块级翻译与增量重译、改写、撰写；每次运行保存所用的编辑策略版本与提示词版本 | [AI 内容流水线](../content/ai-content-pipeline.md) |
| 质量门禁 | 每项检查给出结论、证据与修改建议；结果绑定被检查的版本，内容变化后必须重跑 | [AI 质量门禁](../content/ai-quality-gate.md) |
| 自动发布 | 按信任等级直接发布、开启否决窗口、按发布节奏排队，或进入人工审核 | [AI 自动发布](../content/ai-auto-publish.md) |
| 成本 | 逐次调用账本、站点月度与每日预算、限流与熔断；预算用尽时暂停而不是超支 | [AI 成本控制](../content/ai-cost-control.md) |

模型提供方（OpenAI 兼容服务与实例默认模型）的配置见 [Model providers](../../en/deployment/model-providers.md)（英文）。

## 6. 外部 Agent（MCP）

Claude Code、Codex 等外部 Agent 经实例级 MCP 端点 `POST /api/v1/agents/mcp` 操作 HeoPress。
用户用 OAuth 2.1 授权或个人访问令牌接入，授权范围是“哪些站点 × 哪些工具组”，身份与范围只来自令牌。

- **批量操作计划**：修改两个及以上站点或执行高危操作时，Agent 只能提交计划，由人在 Studio（设置 › 批量计划）审阅、审批并执行。
- **内容分支**：Agent 在分支中修改内容，不影响线上；合并时逐字段、逐区块比较，冲突由人选择，结果只是待发布修订。
- **官方 Skills**：仓库 `skills/` 目录中的六个 Skill 指导 Agent 按 HeoPress 的规则工作。
- **通知**：审批请求、否决窗口、预算告警等事件推送到 Studio 与企业微信、飞书、钉钉、Telegram 或带签名的 Webhook。

见 [MCP 授权](../agents/mcp-authorization.md)、[MCP 工具参考](../agents/mcp-tools.md)、[批量操作计划](../agents/batch-plans.md)、
[内容分支](../agents/content-branches.md)、[官方 Skills](../agents/skills.md)。

## 7. 导入与迁移

- **Astro 站点迁入**：把以 Markdown / MDX 维护内容的 Astro 站点转换为导入包，预演、导入、批次激活，切换前用 URL 对照证明旧链接全部可访问。
  可重复执行，不产生重复条目；激活前导入的内容不出现在前台、sitemap 或 IndexNow 推送中。见 [Astro 站点迁入指南](../migration/astro-import.md)。
- **单站点导出与导入为新站点**：用于迁移或复制站点；导入后的域名、定时任务与自动发布默认停用。见[备份与恢复](../operations/backup-restore.md)。
- WordPress 导入不在 v1.0 范围内。

## 8. 发布与前台

| 引擎 | 适用 | 专题页 |
|---|---|---|
| Classic（默认） | 一个渲染进程按域名服务全部站点，运行时主题（Liquid），内容或主题变化后缓存立即失效 | [经典渲染服务](../rendering/site-classic.md)、[页面缓存与失效](../rendering/page-cache.md) |
| Astro | 需要高度定制设计，或希望把静态产物托管到 CDN 的站点；SEO / GEO 输出与 Classic 等价 | [Astro 静态引擎](../rendering/astro-engine.md) |

Astro 站点的静态产物可以部署到自有服务器、Cloudflare Pages、Vercel 或 Netlify，支持回滚与部署后可达性体检；后端始终只运行在 VPS 上。
见[静态前台部署](../publishing/frontend-deployments.md)。

已发布内容还可以持续导出为 Markdown 到你的 Git 仓库，作为版本历史与灾难恢复的补充（数据库仍是唯一权威）。见 [Git 快照格式](../publishing/git-snapshots.md)。

主题按版本上传、检查后发布，曾发布的版本可随时回滚；内置三个起步主题（news、tech、minimal），新站点在激活主题之前使用内置主题。
主题的安装、激活与编写见[主题开发指南](../rendering/theme-guide.md)与[开发者指南](developers.md)。

## 9. 日志与监控

“日志与监控”模块（仅站点管理员）显示可达性、站点审计、后台任务与实例健康状态，以及只读的事件流。见[日志与监控](../studio/monitoring.md)。

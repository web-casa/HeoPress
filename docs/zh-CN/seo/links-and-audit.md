# 站内链接、站点审计与变更影响

HeoPress P07 任务 5.1–5.5（规格 `seo/link-graph`、`seo/site-audit`）。本文说明编辑与管理员在 Studio 中看到的功能，以及 CI 与 Agent 使用的接口。

## 站内链接图

- 系统从**已发布**条目的富文本中解析指向本站的 `<a href>`，记录来源条目、字段、位置、原文地址与锚文本（`lumibase_link_edges`）。草稿与不公开的字段不计入。
- 条目每次修改只刷新它自己的链接（事件消费者 `link-graph`）；站点内容设置、集合或字段变化时请求全站扫描。全站扫描分批进行、可中断续跑，
  只有完整扫描结束后才清理过时的链接；扫描失败不会清空已有链接图。每天自动扫描一次，管理员可在“设置 → Links”中立即扫描。
- 主题菜单、页脚等正文之外的导航，由管理员在“设置 → Links”中登记（只限本站域名）；孤立内容报告中单独计数。

## 失效链接与孤立内容（设置 → Links）

- **失效链接**：链接的地址不是公开页面，且按请求解析（跟随重定向）后也不是页面——原因分为已删除、已下架、不存在。语言首页、搜索页、文件（feed、sitemap、根文件）不算失效。
  每条失效链接给出来源页面，可直接打开编辑。
- **孤立内容**：没有任何其他公开页面正文链入（直接或经重定向）的页面；另行标注是否出现在站点列表（首页与分类页列出文章）以及登记的导航链接数。
- 报告只包含当前用户可读的页面；登记的导航链接只对管理员可见。数量较大时报告有上限并注明“可能不完整”。
- 接口：`GET /api/v1/site/links/report`、`POST /api/v1/site/links/scan`（管理员）、`GET|POST /api/v1/site/links/manual`、`DELETE /api/v1/site/links/manual/:id`（管理员）。

## 站点审计（设置 → Site audit）

审计给出可清零的问题清单，而不是分数。每条规则有稳定编号与严重程度：

| 规则 | 严重程度 | 含义 |
|---|---|---|
| `links/broken` | error | 失效的站内链接（含登记的导航链接） |
| `links/broken-anchor` | warning | 链接的片段（`#…`）不在目标页面正文中；公开富文本不保留 `id`，只有 `#top` 总是有效 |
| `meta/duplicate-title` | warning | 同一域名与语言内可列出的页面，`<title>` 相同（按模板生成后的值比较） |
| `meta/duplicate-description` | warning | 同上，描述相同 |
| `meta/duplicate-canonical` | warning | 多个页面声明同一个不属于它们任何一个的 canonical |
| `hreflang/missing-return` | error | 页面列出的本站翻译没有回链 |
| `jsonld/invalid`、`jsonld/site-invalid` | warning | 页面或站点的结构化数据被剔除（后者只对管理员可见） |
| `markdown/inconsistent` | notice | Markdown 副本无法承载页面的部分内容，或文字不一致 |
| `markdown/address-taken` | warning | Markdown 副本的地址已是其他路由（页面、重定向、已删除页面的 410） |

- 审计在后台运行（每日一次，或管理员点击“Run audit”后一分钟内）。问题修复后，下一次运行即从清单中消失；全部修复后清单为空。
- 清单只显示当前用户可读的页面；只关乎管理员可见内容的问题只给管理员。
- 机器可读导出：`GET /api/v1/site/audit/export`（JSON 第 1 版：`version`、`siteId`、`generatedAt`、`rules`、`issues`），`?format=csv` 为 CSV；
  SDK 为 `client.site.auditExport()`。导出只包含请求所用站点中调用者可读的内容。

## 变更影响预览

删除一个已发布页面、修改其地址（slug / path）或为其设定下架时间并保存时，若有页面链向它，Studio 先列出**可能受影响**的页面与链接位置（主题或其他站点中的链接无法得知），并提供：

- **Create redirect**（管理员）：从该页面的地址重定向到另一个本站页面；页面不再在原地址响应时生效。会造成重定向循环时拒绝。
- **Update links**：把列出页面中指向它的链接改为另一个本站地址（保留片段），每个页面按当前用户的修改权限分别处理，作为新的修订保存。

影响分析默认列出直接链入的页面（深度 1），可请求深度 2（链向这些页面的页面），最多 200 个。接口：`GET /api/v1/site/links/impact/:itemId?depth=1|2&limit=`、
`POST /api/v1/site/links/impact/:itemId/redirect`、`POST /api/v1/site/links/impact/:itemId/update-links`。

实现：`apps/cms/src/services/site-network/link-graph.ts`、`link-report.ts`、`site-audit.ts`、`link-impact.ts`；Studio `apps/studio/src/modules/settings/link-report-page.tsx`、
`site-audit-page.tsx`、`apps/studio/src/modules/content/link-impact-dialog.tsx`。

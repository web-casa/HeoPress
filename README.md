# HeoPress

面向 10–100 个独立域名站群的 AI 原生开源 CMS。

- 一个实例管理多个独立域名站点，支持跨域名多语言（例如英文站 ↔ 中文站互为译文）。
- 采集 → 翻译 / 改写 → 质量门禁 → 自动发布或人工审核，由确定性流程与受控 AI Agent 协同完成。
- 外部 Agent（Claude Code、Codex、WorkBuddy、千问办公等）通过 MCP 按用户、按站点授权接入。
- 完整的 SEO / GEO 输出：canonical、hreflang、JSON-LD、分片 sitemap、llms.txt、Markdown 副本、IndexNow、AI 流量分析。
- 仅需 VPS + PostgreSQL 18；静态前台可额外部署到 Cloudflare Pages、Vercel、Netlify。

> 本仓库为私有开发仓库 `yeagoo/heopress-private`；公开仓库为 `web-casa/HeoPress`，通过清洗流水线发布（ADR-0010）。项目域名：heopress.com。
>
> 当前状态：**规划阶段**。开发按 `docs/ROADMAP.md` 的 13 个 phase 进行，需求规格位于 `openspec/changes/`。

## 文档导航

| 文档 | 内容 |
|---|---|
| `AGENTS.md` | AI Agent 与开发者的开发协议、交接规则、Phase Gate |
| `docs/ROADMAP.md` | 13 个 phase 的范围、依赖、里程碑与验收门槛 |
| `docs/decisions/` | 架构决策记录（ADR） |
| `docs/research/SUMMARY.md` | 选型与竞品调研结论、可借鉴功能来源 |
| `openspec/changes/` | 每个 phase 的 proposal / design / specs / tasks |
| `UPSTREAM.md`、`NOTICE` | 上游 LumiBase 基线与归属说明 |

## 许可证

本项目基于 LumiBase（Apache-2.0）修改，保留其版权与 NOTICE。本项目自身许可证见 ADR-0008。

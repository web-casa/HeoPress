# HeoPress

面向 10–100 个独立域名站群的 AI 原生开源 CMS。

- 一个实例管理多个独立域名站点，支持跨域名多语言（例如英文站 ↔ 中文站互为译文）。
- 采集 → 翻译 / 改写 → 质量门禁 → 自动发布或人工审核，由确定性流程与受控 AI Agent 协同完成。
- 外部 Agent（Claude Code、Codex、WorkBuddy、千问办公等）通过 MCP 按用户、按站点授权接入。
- 完整的 SEO / GEO 输出：canonical、hreflang、JSON-LD、分片 sitemap、llms.txt、Markdown 副本、IndexNow、AI 流量分析。
- 仅需 VPS + PostgreSQL 18；静态前台可额外部署到 Cloudflare Pages、Vercel、Netlify。

> 公开仓库为 `web-casa/HeoPress`：开发在私有仓库进行，每个版本由白名单导出流水线清洗后发布（流程见 `docs/dev/release.md`）。
>
> 当前状态：**v1.0 发布准备中**（P13）。13 个 phase 的范围见 `docs/ROADMAP.md`；已归档的现行规格位于 `openspec/specs/`。

## 文档导航

| 文档 | 内容 |
|---|---|
| `docs/zh-CN/guides/index.md`（English: `docs/en/guides/index.md`） | 文档入口：用户指南、开发者指南、运维指南 |
| `AGENTS.md` | AI Agent 与开发者的开发协议、交接规则、Phase Gate |
| `docs/ROADMAP.md` | 13 个 phase 的范围、依赖、里程碑与验收门槛 |
| `openspec/specs/` | 已归档的现行规格 |
| `UPSTREAM.md`、`NOTICE` | 上游 LumiBase 基线与归属说明 |

## 许可证

本项目基于 LumiBase（Apache-2.0）修改，保留其版权与 NOTICE。本项目自身许可证为 AGPL-3.0-only（`LICENSE`）；上游 Apache-2.0 文本见 `LICENSES/`。

---
version: 1
lastUpdated: 2026-10-29T11:51:38.611Z
sourceLang: zh-CN
contentHash: 380d22512c4649ae
---

# HeoPress 文档入口

HeoPress 是面向 10–100 个独立域名站群的 AI 原生开源 CMS：一个实例管理多个站点；采集、翻译、改写与质量门禁由确定性流程和受控的 AI 完成，
不满足条件的稿件一律进入人工审核；外部 Agent 经 MCP 按用户、按站点授权接入。后端只需要一台 VPS 与 PostgreSQL 18。

按你的角色选择入口：

| 读者 | 入口 | 内容 |
|---|---|---|
| 编辑、站点管理员、站群运营者 | [用户指南](users.md) | Studio、站点与域名、内容与审稿、SEO / GEO、AI 内容流水线、外部 Agent、导入、发布 |
| 插件、主题与集成的开发者 | [开发者指南](developers.md) | 架构、Extension SDK 与插件、主题、REST / GraphQL / MCP、codemod、参与开发 |
| 部署和维护实例的运维人员 | [运维指南](operations.md) | 安装、配置、备份与恢复、升级、数据保留、前台部署目标、安全 |

## 文档约定

- 简体中文（`docs/zh-CN/`）是默认语言，英文（`docs/en/`）是第二语言。三本指南与本页中英文对齐；
  一部分专题参考页目前只有中文版，指南的英文版在链接旁注明。
- `docs/en/` 中还保留着上游 LumiBase 的一部分参考文档。它们与本页三本指南或指南链接的专题页不一致时，以指南为准。
  上游的 Cloudflare Workers 运行时已删除；Redis、MinIO、MeiliSearch 与 imgproxy 都不再是必需组件。
- 文档中写明的源码路径、环境变量与 API 路由由 `pnpm docs:i18n:verify` 对照代码检查，中英文结构由 `pnpm docs:i18n:parity` 检查。

## 版本与许可证

- 本文档对应 HeoPress v1.0.0。版本历史见 `CHANGELOG.md` 与 `release/RELEASES.md`。
- HeoPress 以 AGPL-3.0-only 授权（`LICENSE`），另提供商业授权（`COMMERCIAL-LICENSE.md`）。只通过公开插件 API 与系统交互的插件和主题适用插件与主题例外（`LICENSE-EXCEPTION.md`）。
- 对外接口包（`@heopress/sdk`、`@heopress/extension-sdk`、`@heopress/contracts`、`@heopress/astro-kit` 等）以 Apache-2.0 授权，以各包目录中的 `LICENSE` 为准。
- HeoPress 由上游 LumiBase（Apache-2.0）硬分叉而来，上游部分保留其许可证与声明（`LICENSES/Apache-2.0.txt`、`NOTICE`、`UPSTREAM.md`）。
- 外部贡献须先签署贡献者许可协议（`CLA.md`），见[开发者指南](developers.md)的“参与开发”。

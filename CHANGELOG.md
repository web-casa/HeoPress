# Changelog

本文件记录 HeoPress 的显著变更，格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [1.2.0] - 2026-11-11

### Added

- 内容：WordPress 导入（WXR / REST）、翻译待办分栏、简报式改写（结构化简报 → 成文）、时效标记与复核提醒、
  自动陈旧判定与审核队列。
- 简报：官方简报插件（概览分节、可编辑草稿、`/briefing` 路由）、按集合的 feed（插件集合自动获得 `/feed/<集合>.xml`）。
- 机器可读：同一 URL 的 Markdown 内容协商（`Vary: Accept`、按表示分键的缓存），静态目标的边缘协商
  （Cloudflare Pages / Vercel / Caddy 各自实现，Netlify 如实标注不支持）与 CI 回放器。
- 扩展：翻译服务扩展点（第十一个，按字符计费）、DeepL 官方插件（含术语表镜像）、插件密钥的加密存储与 Studio 配置。
- 对外贡献：`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、中文贡献指南。

### Changed

- 工作区版本 `1.0.0` → `1.2.0`；`docs/en/contributing/index.md` 的工具链与实际一致（Node 24、pnpm 9.12）。

### Fixed

- `scripts/version-check.mjs` 里陈旧的 Node 版本期望（`>=20` → `>=24`）。

## [1.0.0] - 2026-11-08

### Added

- 第一个正式版本：站群 CMS（一个实例多个独立域名站点）、采集 / 翻译 / 改写流程、质量门禁、MCP 与外部 Agent 的按用户按站点授权、
  Classic 与 Studio 两种前端、扩展点与插件、备份与恢复。详见 `release/notes/v1.0.0.md`。
- P14 收尾（行级隔离默认开启）：RLS 策略进入默认迁移（`0125_p14_rls_policies.sql`），应用角色 / 渲染角色与启动检查、
  应急开关 `rls --disable/--enable`、队列对象不再由运行时创建；版本化删除（REST / GraphQL / MCP / SDK / Studio）、
  每个入队作业都有消费者、审计日志毫秒游标与跨站设置锁序、扩展点契约版本。

### Changed

- 工作区版本 `1.0.0-rc.4` → `1.0.0`；`p14-v1-hardening` 已归档（`openspec/changes/archive/2026-11-08-p14-v1-hardening`），规范并入 `openspec/specs/`。

### Security

- 行级隔离默认生效（ADR-0023）：无站点范围报 `42501`，属主只用于迁移 / 备份，运行时不创建数据库对象。
- 反向验收 19 项（18 项测试级 + 1 项命令级）与镜像运行验收（角色、非 root、写范围、卷、信号、数据库中断、任务状态、混合负载）通过。

## [Unreleased]

### Added

- 以上游 LumiBase `main@93936ef`（Apache-2.0）为基线硬分叉，产品更名为 HeoPress（见 `UPSTREAM.md`）。
  上游 LumiBase 的历史变更保存在 `docs/legacy/upstream/CHANGELOG.md`。

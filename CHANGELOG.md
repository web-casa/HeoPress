# Changelog

本文件记录 HeoPress 的显著变更，格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [1.3.1] - 2026-11-12

### Fixed

- **能力声明修正**：Netlify 的 `markdown-negotiation` 由 `yes` 改为 `degraded`。v1.3.0 把「部署必须打包 Edge Functions」
  写成前提，但本仓库的 Netlify 适配器走 Deploy API 的文件摘要上传，只上传普通文件、从不发送 `edge_functions`，
  因此经它部署的站点不会注册该函数。Netlify 的公开 API 文档只文档化了服务端函数的上传，Edge Functions 的部署方式
  是 Git 连续部署或 CLI ≥12.2.8。改为 `degraded` 并在中英两份部署文档里写明「怎样才能真的生效」。
- 中文部署文档的能力矩阵仍写着「支持」，与代码和英文版不一致；已改为「受限」并重新盖章。

### Added

- `docs/en/publishing/frontend-deployments.md`、`docs/en/publishing/git-snapshots.md`：运维部署必读的两篇补齐英文版。
- `scripts/docs-i18n/parity-gate.mjs` 与 `docs/i18n-parity-baseline.json`：中英文档一致性门禁接入 `pnpm check:all`，
  冻结现有 190 篇单边文档与 3 对允许的漂移；新增单边文档、基线过期都会失败。

### Changed

- 工作区版本 `1.3.0` → `1.3.1`。

## [1.3.0] - 2026-11-12

### Added

- 静态目标：Netlify 的 Markdown 内容协商。部署带协商规则时生成 `netlify/edge-functions/negotiate.ts`
  与声明它的 `netlify.toml`；该函数复用运行时的 RFC 9110 规则，两个表示都带 `Vary: Accept`，
  Markdown 表示另带 `text/markdown`、`noindex` 与 canonical `Link`。能力矩阵中 Netlify 的
  `markdown-negotiation` 由 `no` 改为 `yes`，并写明前提（打包 Edge Functions、`netlify.toml` 生效）与配额限制。
- 回放器覆盖 Netlify：在 `node:vm` 中执行生成的函数，并按生成的 `netlify.toml` 是否声明该函数判定是否生效。

### Changed

- 工作区版本 `1.2.1` → `1.3.0`。

### Fixed

- `theme-pool.test.ts` 的慢启动用例余量不足（800 ms 加载 / 300 ms 超时），在繁忙的 runner 上会因**渲染**超时而失败；
  改为 2 s 加载 / 1 s 超时，断言性质不变而余量更足。

## [1.2.1] - 2026-11-11

### Added

- `CLA signed` 检查：`.github/cla-signatures.json` 记录每份 CLA 接受（登录名、姓名、日期、CLA 版本），
  `scripts/cla-check.mjs` 判定已签 / 未签 / 机器人跳过，`.github/workflows/cla.yml` 在每个 PR 上运行；
  未签的 PR 无法合并。

### Changed

- 工作区版本 `1.2.0` → `1.2.1`。

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

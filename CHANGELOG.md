# Changelog

本文件记录 HeoPress 的显著变更，格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [1.5.0] - 2026-11-14

### Added

- **站点静态目录挂载**：站点可挂载一个目录，HeoPress 路由不到的路径由它提供——网页存档与脚本生成的静态站因此能与新文章同源
  共存。目录必须在 `HEOPRESS_STATIC_ROOT` 之下且 `realpath` 仍在根内；符号链接不跟随；路径先切段再解码两次并拒绝穿越、
  反斜杠、NUL、控制字符与隐藏条目。**系统路径与条目永不遮蔽**（条目、插件路由、`robots.txt`、`sitemap*`、`.well-known`、
  `health`、`admin`、feed、`llms.txt` 优先）；`static-urls.txt` 的 URL 合并进 sitemap；Astro 构建把目录并入产物。
- **官方纠错插件 `heopress-corrections`**：公开纠错表单（来源校验、8 KiB、每地址 5 次/分、蜜罐与中性回答、不解析目标页面）→
  审核队列 → 接受后生成一条更正记录并（按站点设置）在文章正文追加带 `data-heopress-correction` 的更正块；更正页输出
  `CorrectionComment` 结构化数据。举报者的姓名与邮箱属个人数据：不出现在任何公开路由、响应、sitemap 或日志里。
- **插件打包矩阵**：`scripts/verify-plugin-packages.mjs` 对每个 `packages/plugin-*` 打包、离线装进干净项目并加载，
  校验「注册的扩展点都在 manifest 声明内」，无需数据库与服务器。

### Fixed

- 镜像运行时验收报告「服务在数据库中断期间重启」时只有一行结论：现在会打印前后 `StartedAt`/`RestartCount`、退出码、
  是否 OOM 以及该服务最后 40 行日志，下一次可诊断而不是靠猜。

### Changed

- 工作区版本 `1.4.0` → `1.5.0`。

## [1.4.0] - 2026-11-13

### Added

- **双模型翻译**（内置服务 `heopress:dual-model`）：模型 A 起草，确定性机械门禁检查，模型 B 复核并修正；修正文本必须再次
  通过同一套门禁才被采纳，复核失明时保留草稿并标 `unverified`。两次调用各自记账，同一模型两次在保存时即被拒绝。
- **翻译任务队列**：`lumibase_translation_jobs` 持久化任务，`translation-jobs` 队列 + 消费者；按状态/语言对查询、逐段状态、
  重试与取消；租约到期自动恢复，反复失败以 `EXECUTION_LIMIT` 终止。
- **站点术语表管理**：`/api/v1/glossary` 增删改查（`do-not-translate` / `prefer` / `forbidden`），Studio `/content/glossary`
  页面（中英），(站点, 语言对, 词条) 唯一约束与 `409` 冲突提示。

### Changed

- 翻译延后（限流、熔断、日预算）**不消耗**业务重试次数，按网关给出的时间重排；瞬时失败指数退避；永久失败立即终止并把
  错误码写入任务行。
- 崩溃恢复使用稳定的调用键（`translation-job:<id>:a<attempts>:e<epoch>`），网关重放已记录的调用，不重复计费；只有操作者
  显式重试才重新计费。

### Fixed

- `forbidden` 词条此前完全不检查（`rule` 在翻译边界被丢弃），禁用译法可以通过「验证」；`do-not-translate` 也不再要求
  译文出现目标词，而是要求**源词原样保留**。
- 全量 CMS 套件在只给 `DATABASE_URL` 时出现 2 个文件失败与偶发 hook 超时：E2E 套件改为按自身前提跳过，
  `hookTimeout` 提到 30 s。

### Changed (version)

- 工作区版本 `1.3.1` → `1.4.0`。

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

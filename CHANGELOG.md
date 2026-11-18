# Changelog

本文件记录 HeoPress 的显著变更，格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [1.6.5] - 2026-11-19

### Changed

- **镜像发布不再无条件重建**：发布标签与上一个标签比较，只有可能改变镜像内容的路径（代码、锁文件、依赖、Dockerfile、
  数据库镜像）才触发构建；只改安装脚本、文档或发布说明时，改为把上一版的 manifest 复制到新版本
  （`docker buildx imagetools create`，内容寻址，不构建），`latest` 按同样规则移动。
  匿名拉取校验照常运行，复用失败与构建失败一样会被拦住。

### Documented

- 部署文档补「检查某次发布真的发布了什么」：多架构 manifest、匿名拉取、以及数据库镜像里的 `vector` / `zhparser`
  扩展文件。

## [1.6.4] - 2026-11-18

### Fixed

- **卡住的镜像拉取不再让安装无限等待**：`docker pull` 自己没有超时，v1.6.3 之后安装默认走拉取，实测在一次真实安装里
  `ghcr.io` 的拉取挂住 15 分钟（注册表本身 1.2 秒内可达）。现在每个决定「拉还是建」的拉取都在 `timeout` 下运行，
  默认 300 秒，`HEOPRESS_PULL_TIMEOUT` 可覆盖；超时视为不可用，走已有的源码构建回退。
  正常网络下行为不变——同一次验证中真实拉取三个镜像、**0 次构建**、五个服务全部 healthy。

## [1.6.3] - 2026-11-18

### Added

- **发布容器镜像**：打发布标签时由 `.github/workflows/images.yml` 构建并推送 `heopress-cms`、`heopress-site-classic` 与
  `heopress-postgres` 到 GHCR，覆盖 amd64 与 arm64，标签为不带 `v` 的版本号；`latest` 只在正式发布标签时移动。
  工作流最后一步**匿名拉取**每个标签，拉不到即失败——发布不能声称提供了安装方取不到的镜像。

### Changed

- `docker/install.sh` 现在**优先拉取**发布在 GHCR 的数据库镜像（PostgreSQL 18 + pgvector + zhparser），拉取失败才从源码
  构建；应用镜像的回退逻辑（v1.6.2）不变。受限网络下的安装行为与 v1.6.2 一致，只是多了一条更快、无需编译的路径。

## [1.6.2] - 2026-11-17

### Fixed

- **干净安装卡在拉取镜像**：安装脚本默认从 `ghcr.io/web-casa` 拉应用镜像，但那里**没有发布任何镜像**，于是任何人的安装都会在
  `docker pull` 处失败。现在拉取失败即改为从同一份源码构建，并在日志中说明；`--build` 语义不变（只构建、不尝试拉取）。
- **数据库镜像无法在 github.com 不可达时构建**：`docker/postgres/Dockerfile` 原本直接从 GitHub 取 SCWS 与 zhparser。
  现在两者都可覆盖：`--build-arg SCWS_URL=… ZHPARSER_URL=…` 指向镜像站，或把 tarball 按 SHA-256 命名放进
  `docker/postgres/vendor/`（零外网）。两种方式都在解包前校验 SHA-256。`docker/install.sh` 新增 `--db-build-arg`。
- **只在 UTC 午夜后一小时失败的测试**：站点简报的「今天发布」夹具用 `now - 1h`，在 00:00–01:00 UTC 落到前一天，
  断言因此失败。夹具现在夹在当天的 UTC 区间内。

### Changed

- 依赖更新：`i18next` 27、`react-i18next` 18、`jsdom` 31，以及 36 项 minor/patch（`hono` 4.13.18、`astro` 7.4.11、
  `graphql-yoga` 6.1.0 等）。`@playwright/test` **保持 1.63.0**：视觉回归作业运行在固定镜像
  `mcr.microsoft.com/playwright:v1.63.0-noble` 中，单独升版本会导致浏览器二进制缺失。

### Documented

- 安装页补充受限网络下的脚本获取方式（`raw.githubusercontent.com` 不可达时用发布页源码包 + `--source`），
  以及数据库镜像的镜像站 / vendor / 降级（`--db-image postgres:18`）三条路。

## [1.6.1] - 2026-11-15

### Fixed

- **构建沙箱在 gVisor 下的启动失败**：gVisor 拒绝携带 SELinux 标签的安全上下文（`SELinux is not supported`）。
  选择 `HEOPRESS_ASTRO_BUILD_RUNTIME=runsc` 时，计划现在自动使用 `--security-opt label=disable` 并去掉挂载上的 `:z`，
  同时**保留** `no-new-privileges`。不选 gVisor 时行为不变。

### Added

- 运维文档与研究报告补充 gVisor 实测结论：与默认运行时行为一致、单条命令耗时 225 ms 对 195 ms（+15%），以及三条前提
  ——不接受 SELinux 标签、**rootless 下无法启动**（需 rootful 或真正的 cgroup 委派）、必须连同 `gvisor-bin/` 边车安装。

## [1.6.0] - 2026-11-15

### Added

- **Astro 构建容器沙箱**：`HEOPRESS_ASTRO_BUILD_SANDBOX=required` 时构建在一次性 rootless 容器里执行——只读根文件系统、
  只挂载输入与输出、**构建期无网络**、丢弃全部能力、cgroup v2 限制 CPU/内存/pids 并受墙钟约束。运行时、套接字、镜像或
  cgroup 不可用时构建**失败并给出修复说明**，绝不回落到子进程。页面数据改为只读文件输入，因此「断网」与「构建有数据」
  同时成立。
- **构建镜像与自包含模板**：`docker/astro-build/`（Node 24，非 root）；`scripts/prepare-astro-template.mjs` 产出部署要挂载的
  模板（自带依赖存储、已编译的 contracts、本地 tsconfig、`.astro` 指向缓存 tmpfs）并自校验。
- **健康检查**：`/health` 的 `astroBuild: { required, available, reason }` 让运维在开放第三方主题前看到前置条件。

### Fixed

- **SELinux 主机（AlmaLinux/Rocky/RHEL）**：bind 挂载缺少 `:z` 时写产物被拒（`EACCES`，与 uid 无关）。
- **rootless 运行时**：构建必须以容器 root 运行（容器 root 即发起构建的宿主用户）；传宿主 uid 会映射到从属 uid，导致输出
  目录不可写。rootful 运行时仍使用专用构建用户。

### Changed

- 工作区版本 `1.5.0` → `1.6.0`。

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

---
version: 3
lastUpdated: 2026-10-29T13:23:31.882Z
sourceLang: zh-CN
contentHash: 0141093549c4b170
---

# 运维指南

面向部署和维护 HeoPress 实例的运维人员：安装、配置、备份与恢复、升级、数据保留、前台部署目标与安全。
功能使用见[用户指南](users.md)，二次开发见[开发者指南](developers.md)。

## 1. 部署形态

v1.0 支持在**一台 VPS** 上用 Docker Compose 运行（不支持多实例高可用部署）：

| 服务 | 作用 |
|---|---|
| `postgres` | PostgreSQL 18 数据库镜像（含 pgvector 与中文分词 zhparser，见 [Database image](../../en/deployment/database-image.md)，英文） |
| `cms` | API 与 Studio（`HEOPRESS_PROCESS_ROLE=web`） |
| `cms-worker` | 后台任务：队列、定时任务、事件消费者、备份与清理（`HEOPRESS_PROCESS_ROLE=worker`） |
| `site-classic` | 公开网站的渲染服务，以只读数据库角色读取公开投影 |
| `caddy` | 反向代理与 TLS：管理域名与各站点域名的证书（站点域名按需签发） |

Compose 文件在 `docker/` 下：`docker/docker-compose.yml` 为基础，生产叠加 `docker/docker-compose.prod.yml`，
TLS 与站点域名叠加 `docker/docker-compose.tls.yml` 与 `docker/docker-compose.domains.yml`。
S3 兼容对象存储与 MeiliSearch 是可选组件；默认媒体存本地文件系统，检索用 PostgreSQL。

硬件：最小可运行部署为 2 vCPU / 4 GB 内存、本地存储；v1 的规模验收以固定 4 vCPU / 8 GB 为基准（100 个站点、每站 1,000 篇，见第 9 节）。

## 2. 安装

在干净的 Ubuntu 24.04 上一条命令完成安装：Docker、数据库镜像、应用、Caddy 与首个管理员。
脚本先启动数据库与应用（没有公网入口），创建首个管理员并验证能登录，最后才启动 Caddy；秘密写入权限为 600 的文件，安装日志与输出不含密码。
已有安装时脚本不做任何修改。步骤、选项与安装后的文件见[一条命令安装](../operations/install.md)。

安装后的检查：

- 后台只在管理域名的私有后台路径下提供；在公开站点域名上访问管理路径返回 404。见 [Private Admin Path](../../en/deployment/private-admin-path.md)（英文）。
- `/health/live` 只检查进程存活，`/health/ready` 检查依赖是否就绪，`/health` 返回各项健康检查。
- 添加站点域名并验证后，证书在首次访问时签发。见 [Custom domains and on-demand TLS](../../en/deployment/custom-domains.md)（英文）。

## 3. 配置

全部配置是实例级环境变量（Compose 的 env 文件），秘密只放在服务器上，不进入 Git、日志或前端。

| 主题 | 文档 |
|---|---|
| 全部环境变量 | [Environment variables](../../en/deployment/environment-variables.md)（英文） |
| 生产上线检查清单 | [Production Deployment Checklist](../../en/DEPLOYMENT-CHECKLIST.md)（英文） |
| 对象存储（S3、R2、OSS、MinIO 等） | [Object storage](../../en/deployment/object-storage.md)（英文） |
| 模型提供方与实例默认模型 | [Model providers](../../en/deployment/model-providers.md)（英文） |
| 加密密钥（`ENCRYPTION_KEY`）与轮换 | [Encryption Key Operations](../../en/operations/encryption-keys.md)（英文） |
| 外部采集服务 | [采集服务配置](../content/crawl-services.md) |

## 4. 备份与恢复

设置 `HEOPRESS_BACKUP_TARGET`（本地目录或 S3 兼容存储）后，worker 按计划备份：数据库每日全量 + 每小时增量（小 VPS 可选仅全量的 `pg_dump`），
媒体按对象增量同步，配置文件只在加密时写入；每份备份带 SHA-256 清单，可选加密，按 14 天 / 8 周保留整条恢复链；每周自动对最新备份做恢复演练。

- 命令：`heopress backup run`、`list`、`verify`、`drill`、`prune`、`restore`、`finish-restore`，以及单站点的 `export-site` / `import-site`。
- 官方应用镜像不含 PostgreSQL 程序：在装有 Node 24 与 PostgreSQL 18 程序的主机或辅助容器中运行备份命令。
- 备份密钥与配置要单独、安全地保存：丢失密钥就无法恢复加密备份。
- 恢复在开放写入前重放删除账本，已执行的个人数据删除不会因为恢复旧备份而复活。

见[备份与恢复](../operations/backup-restore.md)（含可选的 pgBackRest 方案）。

## 5. 升级

`heopress upgrade` 依次执行：兼容检查 → 备份 → 在数据库副本上预演迁移 → 进入维护并冻结全部写入 → 最终备份 → 迁移 → 切换应用 → 冒烟测试 → 开放写入。
预演失败不进入维护；进入维护后的失败会恢复配置、数据库与旧版本应用，验证通过才开放写入，恢复失败则保持维护。

- 没有配置备份目标时兼容检查失败，升级不会开始。
- **新版本开放写入后不能回滚**：恢复旧备份会丢失之后写入的数据，此时用向前修复或人工的数据保留方案。
- 插件作者用 `heopress-ext codemod` 处理插件 API 的破坏性变更。

见[升级](../operations/upgrades.md)；通用的版本策略与回滚限制见 [Upgrade Operations](../../en/operations/upgrades.md)（英文）。

## 6. 数据保留

原始抓取快照、AI 运行记录正文、访问明细、变更事件与备份都有默认保留期限，可用 `HEOPRESS_RETENTION_*` 环境变量调整；
仍被待审内容、未结争议或进行中任务引用的数据不会被清理。个人数据删除请求优先于所有保留引用，并写入删除账本。
Git 内容仓库的历史改写没有任何自动接口，只能经所有者批准后人工执行。

见[数据保留](../operations/data-retention.md)、[Git 历史改写（人工流程）](../../ops/history-rewrite.md)。

## 7. 前台部署目标

后端始终只运行在 VPS 上。使用 Astro 引擎的站点可以把静态产物部署到自有服务器、Cloudflare Pages、Vercel 或 Netlify；
平台令牌加密存储，平台确认上线后才更新已部署版本，失败时线上仍是上一个版本，可回滚。静态目标不支持的运行时功能见其中的功能支持矩阵。
见[静态前台部署](../publishing/frontend-deployments.md)、[Astro 静态引擎](../rendering/astro-engine.md)。

## 8. 监控

- Studio 的“日志与监控”模块：可达性、站点审计、后台任务与实例健康（数据库、迁移、队列、存储等），以及只读事件流。见[日志与监控](../studio/monitoring.md)。
- 运营事件（审批请求、预算告警、Agent 事故等）可推送到 IM 或 Webhook。见[通知](../studio/notifications.md)。
- 可选的 Prometheus / Grafana 配置在 `docker/` 下（`docker/docker-compose.monitoring.yml`）。见 [Observability](../../en/features/observability.md)（英文）。

## 9. 安全

- **管理面隔离**：后台只在管理域名的私有路径下提供，公开站点域名上没有管理入口；渲染服务只读公开投影，看不到草稿与管理表。
- **出站请求**：所有外部请求（抓取、Webhook、部署平台、模型服务）都经过统一的 SSRF 防护边界。见 [Outbound requests](../../en/security/outbound-requests.md)（英文）。
- **密钥**：站点级的平台令牌与模型密钥用实例加密密钥封存；任何命令与日志都不打印连接串或秘密。
- **审批**：发布审批与批量计划只能由人在 Studio 中操作，Agent 与 API Key 无法绕过。
- **扫描**：公开仓库对每个镜像提交运行依赖审计（`pnpm audit`）、Gitleaks 与 Trivy 镜像扫描，例外登记在 `security/exceptions.json` 并有到期日。
- **报告漏洞**：按仓库根目录 `SECURITY.md` 的流程私下报告，不要公开提 issue。

规模：v1 的验收目标是 100 个站点、每站 1,000 篇文章时，Classic 引擎缓存命中 p95 低于 50 ms、未命中低于 400 ms（固定 4 vCPU / 8 GB、数据库与渲染同机、50 并发）。
v1 压测报告与安全复查报告是开发仓库中的维护者记录，按发布规则不导出到公开仓库；结论写入版本的发布说明。

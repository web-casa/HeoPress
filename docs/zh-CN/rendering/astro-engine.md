# Astro 静态引擎

Astro 引擎为需要高度定制设计或希望托管到静态 CDN 的站点按站点构建静态产物（ADR-0005）。它与 Classic 引擎读取同一套页面数据与 SEO / GEO 数据层，
输出的 canonical、hreflang、JSON-LD、robots、sitemap、llms.txt 与 Markdown 副本与 Classic 等价，并由等价性测试守住。

实现：

- `packages/contracts/src/theme/page-data.ts`：页面数据契约（`PageDataSnapshot`）与形状校验；
- `apps/site-classic/src/page-data.ts`：只读页面数据接口——用 Classic 引擎自身的请求处理生成快照（`exportPageData`），并在回环地址上以一次性令牌提供给一次构建（`servePageData`）；
- `apps/site-astro/`：构建模板（`astro.config.mjs`、`src/integration.mjs`、`src/pages/`）、官方起步主题（`themes/starter/`）与构建器（`src/builder/`）；
- `packages/astro-kit/`：主题工具包（类型与系统组件，Apache-2.0）；
- `apps/cms/src/services/astro/astro-engine.ts`：去抖调度、发布、回滚与对账；`apps/cms/src/services/astro/astro-worker.ts`：worker 进程中的接线。

## 数据流

1. 内容、路由、重定向、站点设置或主题变化产生变更事件，`astro-build` 消费者把对应站点标记为待构建（`lumibase_astro_sites.requested_at`）。
2. 去抖：最后一次变化后安静 `HEOPRESS_ASTRO_DEBOUNCE_MS`（默认 60 秒）才构建，一个窗口最长等待 5 分钟；一分钟内的 5 次发布只触发一次构建，产物包含全部 5 篇。
3. 构建取下一个部署世代（generation），以渲染角色导出快照：导出前后各读一次站点的渲染版本（发布修订号），不一致就重做，所以一次构建的所有页面与文件属于同一修订。
4. 构建在独立子进程中运行（见下节），产物写入新目录 `<root>/<siteId>/builds/<generation>/`。
5. 校验通过后才上线：先在数据库对 `active_generation` 做比较并交换（只接受更新的世代），再用一次 `rename` 原子替换符号链接 `<root>/<siteId>/current`。
   失败的构建不触碰 `current`，站点继续提供上一版本，并通知站点管理员；比当前世代旧、晚到的构建记为 `superseded` 并删除产物。

## 构建隔离（v1）

- 子进程的环境从空开始，只含页面数据接口地址与本次构建的一次性令牌、主题目录、输出目录、已批准的集成、临时 HOME、PATH 与包源；
  不含数据库连接串、`JWT_SECRET`、`ENCRYPTION_KEY`、部署凭据或任何管理凭据。数据只能从回环地址上的只读页面数据接口读取，令牌随接口一起失效，且不会出现在保留的日志中。
- 不以 root 运行：CMS 以 root 运行时必须配置 `HEOPRESS_ASTRO_BUILD_UID` / `HEOPRESS_ASTRO_BUILD_GID`，否则拒绝构建。
- 资源上限：V8 堆（`HEOPRESS_ASTRO_BUILD_MEMORY_MB`）、CPU 秒（`HEOPRESS_ASTRO_BUILD_CPU_SECONDS`，系统有 `prlimit` 时生效）与墙钟时间（`HEOPRESS_ASTRO_BUILD_TIMEOUT_MS`，超时杀死整个进程组）；
  同时进行的构建数受 `HEOPRESS_ASTRO_CONCURRENCY`（默认 1）限制。
- 只接受官方主题（`official:<name>`）与运营者自有主题（`operator:<name>`，来自 `HEOPRESS_ASTRO_OPERATOR_THEMES`）；主题声明的集成必须在 `HEOPRESS_ASTRO_INTEGRATIONS` 中。
- 子进程不是安全沙箱：网络访问没有在操作系统层面限制，构建不执行依赖安装（依赖随模板预装）。

## 构建容器沙箱（v1.5）

设 `HEOPRESS_ASTRO_BUILD_SANDBOX=required` 后，构建改在**一次性容器**里执行：只读根文件系统、只挂载构建输入与输出
两个宿主目录、**构建期无网络**、丢弃全部能力、`no-new-privileges`、cgroup v2 限制 CPU/内存/pids，并受墙钟时间约束。
不设该变量时行为与上一节完全一致（子进程），现有部署不需要改动。

**前置条件**

| 项 | 要求 |
|---|---|
| 容器运行时 | 宿主上的 **rootless Podman**（或 Docker），并把它的套接字挂进 CMS 容器；CMS 自身不需要额外能力，也不改 seccomp |
| 构建镜像 | `docker/astro-build/` 构建出的 `heopress-astro-build:1`（Node 24，非 root 用户） |
| 模板 | 用 `node scripts/prepare-astro-template.mjs --out <目录>` 产出的**自包含**模板；`HEOPRESS_ASTRO_TEMPLATE_DIR` 指向它 |
| cgroup | cgroup v2 统一层级，含 `memory`、`pids`、`cpu` 控制器 |

```bash
# 1. 镜像
docker build -t heopress-astro-build:1 docker/astro-build

# 2. 模板（自包含：自带依赖存储、已编译的 contracts、本地 tsconfig、.astro 指向缓存 tmpfs）
node scripts/prepare-astro-template.mjs --out /srv/heopress/astro-template

# 3. rootless Podman 的套接字挂进 CMS 容器（compose）
#    volumes: ["/run/user/1000/podman/podman.sock:/run/podman/podman.sock"]

# 4. 环境变量
HEOPRESS_ASTRO_BUILD_SANDBOX=required
HEOPRESS_ASTRO_BUILD_CLI=podman
HEOPRESS_ASTRO_BUILD_SOCKET=unix:///run/podman/podman.sock
HEOPRESS_ASTRO_BUILD_IMAGE=heopress-astro-build:1
HEOPRESS_ASTRO_TEMPLATE_DIR=/srv/heopress/astro-template
```

**配置**

| 变量 | 说明 |
|---|---|
| `HEOPRESS_ASTRO_BUILD_SANDBOX` | 设为 `required` 启用容器沙箱；其他值（含未设置）沿用子进程 |
| `HEOPRESS_ASTRO_BUILD_CLI` | 运行时命令，默认 `podman`（支持 `docker`，两者的 `--remote` / `-H` 方言自动区分） |
| `HEOPRESS_ASTRO_BUILD_SOCKET` | 运行时套接字，例如 `unix:///run/podman/podman.sock` |
| `HEOPRESS_ASTRO_BUILD_IMAGE` | 构建镜像，默认 `heopress-astro-build:1` |
| `HEOPRESS_ASTRO_BUILD_CPUS` / `_MEMORY_MB` / `_PIDS` | 容器限额，默认 2 / 1024 / 512；只能收紧 |
| `HEOPRESS_ASTRO_BUILD_RUNTIME` | 容器的 OCI 运行时，默认由运行时决定；设为 `runsc` 即启用 gVisor |

**失败语义**

运行时、套接字、镜像或 cgroup 不可用时，构建**失败并给出修复说明**（`SANDBOX_UNAVAILABLE`），**不会**回落到子进程——
否则「沙箱已启用」会变成一句谎话。健康检查（`/health` 的 `astroBuild` 字段）同时报告
`{ required, available, reason }`，运维在开放第三方主题前即可确认前置条件。

**主题依赖必须预装**：容器没有网络，主题声明的集成与依赖必须出现在模板里；构建期尝试联网会失败，这是设计如此。

**能力边界**：该沙箱挡的是构建期逃逸为宿主控制（读密钥、写宿主、外联、耗尽资源），不替代主题包本身的供应链措施
（来源与签名、`--ignore-scripts`、产物 CSP）。选型与实测见 `docs/research/2026-11-14-astro-build-isolation.md`。

## 对账

`AstroEngine.reconcile()` 每 5 分钟运行一次，也以 `astroReconciliation()` 钩子（名称 `astro`）提供给统一对账：

- 超过截止时间仍在 `building` 的构建记为失败；
- 站点的上线修订落后于当前渲染版本且没有待构建与进行中的构建时（事件丢失），重新请求构建；
- `current` 链接与数据库记录的上线世代不一致时，恢复为数据库记录的世代。

## 启用、切换与回滚

`AstroEngine.enable(siteId, theme)` 启用并立即请求首次构建；`switchTheme` 用新主题构建，通过校验后才替换旧版本；
`rollback(siteId, generation)` 先用当前快照（包括当前的赞助披露策略）重新校验旧产物，不通过则拒绝，需要重新构建。
每次上线前的校验包括：每个页面与文件都在产物中、系统 head 原样出现一次且没有其他 canonical 与 JSON-LD、正文原样出现、
开启披露时赞助文章的披露位于正文之前、每张赞助卡片内恰有一个披露、指向赞助条目的链接都在其卡片内；关闭披露时不得出现披露。

## 静态目标不支持的功能

站内搜索、列表分页（`?page=N`）、预览与访问分析需要运行时，静态构建不提供，快照的 `unsupported` 字段明确列出，不声称等价。
页面路径按目录格式输出（`/a/b/` → `a/b/index.html`）；只构建主域名上的页面，语言独立域名上的页面不在本站产物中。

## 环境变量

| 变量 | 说明 |
|---|---|
| `HEOPRESS_ASTRO_ROOT` | 构建目录根；与下一项同时设置时 worker 启用 Astro 引擎 |
| `HEOPRESS_ASTRO_RENDER_DATABASE_URL` | 渲染角色的连接串（只能读公开投影），用于导出页面数据 |
| `HEOPRESS_ASTRO_DEBOUNCE_MS` | 去抖窗口，默认 `60000` |
| `HEOPRESS_ASTRO_CONCURRENCY` | 同时构建数，默认 `1` |
| `HEOPRESS_ASTRO_BUILD_MEMORY_MB` | 构建进程 V8 堆上限，默认 `1024` |
| `HEOPRESS_ASTRO_BUILD_TIMEOUT_MS` | 构建墙钟时间上限，默认 `600000` |
| `HEOPRESS_ASTRO_BUILD_CPU_SECONDS` | 构建 CPU 时间上限，默认 `600` |
| `HEOPRESS_ASTRO_BUILD_UID` / `HEOPRESS_ASTRO_BUILD_GID` | CMS 以 root 运行时构建使用的非特权用户 |
| `HEOPRESS_ASTRO_OPERATOR_THEMES` | 运营者自有主题目录（每个子目录一个主题） |
| `HEOPRESS_ASTRO_INTEGRATIONS` | 运营者批准的 Astro 集成（逗号分隔） |
| `HEOPRESS_ASTRO_REGISTRY` | 构建可使用的包源 |
| `HEOPRESS_ASTRO_TEMPLATE_DIR` | 构建模板目录（含已安装依赖的 `apps/site-astro`）；CMS 镜像只含打包后的代码，在镜像中启用 Astro 引擎时须挂载模板并设置此项 |

## 测试

```bash
pnpm --filter @heopress/site-astro test          # 构建、失败保留旧版本、移植示例、隔离与原子切换
DATABASE_URL=<应用角色> DATABASE_OWNER_URL=<所有者> pnpm --filter @heopress/cms exec vitest --run src/__tests__/astro-engine.db.integration.test.ts
```

后者包含 Classic 与 Astro 的 SEO / GEO 等价性测试，在 CI 的 `db-suites` 作业（CMS 全套）中运行。

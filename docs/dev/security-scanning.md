# 安全扫描（镜像推送、夜间与发布前）

P07 任务 8.1，依据 ADR-0017 §5：`pnpm audit`、Gitleaks 与 Trivy 镜像扫描。扫描服务不可用记为“未完成”，不得视为通过；
漏洞例外写明负责人、适用版本、理由与复查期限，过期即失败。

| 文件 | 作用 |
|---|---|
| `.github/workflows/security.yml` | 工作流：受信任 ref 检查、例外检查、`pnpm audit`、Gitleaks、Trivy（CMS、渲染服务、数据库三个镜像）与汇总 |
| `scripts/security-scanners.mjs` | 以树外配置运行扫描器（工作流与发布门禁共用），写出 JSON 报告 |
| `scripts/check-security-scan.mjs` | 读取报告与例外文件，给出 通过 / 失败 / 未完成 |
| `scripts/release-security-gate.mjs` | 发布门禁：`scripts/public-release.mjs` 的 `prepare` 与 `push` 调用 |
| `security/exceptions.json` | 例外清单（随代码公开；改动须代码所有者审阅，见 `.github/CODEOWNERS`） |
| `scripts/__tests__/check-security-scan.test.mjs`、`security-scanners.test.mjs`、`security-workflow.test.mjs`、`release-security-gate.test.mjs` | 判定规则、树外配置、工作流本身与发布门禁的测试 |

## 何时运行

- **每次公开 CI 镜像推送**：`node scripts/ci-mirror.mjs push` 把私有提交推到公开仓库 `ci/b-*` 分支，`push` 触发同时运行
  `ci.yml` 与本工作流，于是每个镜像提交都有一条扫描运行记录。`ci-mirror.mjs report` 写回私有提交的 `public-mirror-ci` 状态时只取
  `ci.yml` 的运行（`pickRun` 按工作流路径筛选），扫描结果不影响该状态；扫描结果在公开仓库的 Actions 页面查看，并由发布门禁使用。
- **夜间**：`schedule` 每天 18:17 UTC（北京时间 02:17），只在默认分支上运行：在公开仓库上就是最新发布版本，新公布的漏洞第二天出现。
  公开仓库 60 天无活动时 GitHub 会暂停定时任务，需要手动恢复。
- **手动或被其他工作流调用**（`workflow_dispatch`、`workflow_call`）：只接受 `main`、`ci/*` 分支与 `v*` 标签（`ref` 作业），其他 ref 直接失败。
- **发布前**：发布流水线强制要求，见下文“发布门禁”。

私有仓库的 Actions 恢复后，`main` 上的夜间任务也会在私有仓库运行（私有仓库没有 `ci/*` 推送）。

## 扫描器不受被扫描的树控制

扫描器会从被扫描的目录与环境变量读取配置：gitleaks 读 `.gitleaks.toml`、`.gitleaksignore`（8.30 版无论 `--gitleaks-ignore-path`
指向哪里都会读被扫描目录下的 `.gitleaksignore`）与 `GITLEAKS_CONFIG*`；Trivy 读工作目录下的 `trivy.yaml`、`.trivyignore` 与 `TRIVY_*`；
pnpm 读项目的 `.npmrc`、`npm_config_*` 与 `pnpm.auditConfig` 的忽略列表。一个提交只要加入这类文件就能让扫描返回“干净”的报告。
因此 `scripts/security-scanners.mjs`：

- 树中任何位置（`node_modules`、`.git` 除外）出现 `.gitleaks.toml`、`.gitleaksignore`、`.trivyignore`、`.trivyignore.yaml`、
  `trivy.yaml`、`trivy.yml` 即判定**失败**（公开导出同样拒绝这些文件）；
- gitleaks 使用树外临时文件中的默认规则（`[extend] useDefault = true`）、树外的空忽略目录、`--ignore-gitleaks-allow` 与 `--redact`；
- Trivy 在独立的临时目录中运行，`--config` 与 `--ignorefile` 指向树外的空文件；
- `pnpm audit` 在只含根目录 `package.json`（去掉 `pnpm.auditConfig`）、`pnpm-lock.yaml`、`pnpm-workspace.yaml`（去掉 `auditConfig`）的
  临时目录中运行，显式使用 `--registry=https://registry.npmjs.org/`；
- 运行扫描器时去掉所有 `GITLEAKS_*`、`TRIVY_*`、`npm_config_*`、`pnpm_config_*` 环境变量。

`scripts/__tests__/security-scanners.test.mjs` 用真实 gitleaks 验证：树中放一个放行一切的 `.gitleaks.toml` 并设置 `GITLEAKS_CONFIG`，
示例密钥仍被发现；`.gitleaksignore` 确实能让 gitleaks 漏报，所以扫描在运行前就拒绝含它的树。Trivy 与 pnpm 用桩程序记录实际收到的参数、
工作目录与环境。`scripts/__tests__/security-workflow.test.mjs` 检查工作流只通过上述脚本调用扫描器、不带 `--ignore-unfixed`、
权限只读、Action 固定 SHA、`actions/checkout` 不保留凭据、汇总作业 `if: always()` 且依赖全部扫描，以及 `actionlint`（已安装时）。

## 判定

| 结果 | 含义 | 退出码 |
|---|---|---|
| 通过（`passed`） | 报告完整，所有高危与严重发现（Gitleaks 为全部发现）都被当天有效的例外覆盖 | 0 |
| 失败（`failed`） | 有未被覆盖的发现；例外缺字段、已过期或期限超过 180 天；树中有扫描器配置文件 | 1 |
| 未完成（`not-completed`） | 扫描器没有运行或失败、没有报告、报告不完整：npm 审计服务或 Trivy 漏洞库不可用等 | 2 |

- 报告必须“完整”：`pnpm audit` 报告不含 `error`，有公告与漏洞计数，且审计的依赖数大于 0；计数中有高危却没有列出对应公告也算未完成
  （pnpm 配置忽略了某些公告时除外，见下文）。Trivy 报告须有结果，每个结果有目标与类别，且至少扫描到操作系统软件包（三个镜像都基于 Debian）。
  Gitleaks 必须报告扫描了大于 0 字节。
- Trivy 只看 `HIGH`、`CRITICAL`，**包括尚无修复版本的漏洞**：没有修复版本的漏洞同样需要一条带复查期限的例外（写明为何暂时接受、
  何时复查），不再用 `--ignore-unfixed` 隐去。现有发现的处理见下文“镜像扫描发现的处理”。
- 汇总作业 `Security scan result` 总是运行，任一扫描失败或未完成都让整个工作流失败；作业摘要按扫描列出结果。
  扫描步骤本身失败、没有给出判定时显示为 “not completed”。

## 例外

`security/exceptions.json` 的 `exceptions` 是一个列表，每项：

| 字段 | 要求 |
|---|---|
| `scanner` | `pnpm-audit`、`trivy` 或 `gitleaks` |
| `id` | 公告编号（`GHSA-…` 或 `CVE-…`，`pnpm-audit` 两者都可匹配）；Gitleaks 为审核 id |
| `package`、`versions` | 漏洞例外必填：包名与它覆盖的**确切**已安装版本列表；版本变化后例外不再适用 |
| `path` | Gitleaks 例外必填：文件与行号，便于人工核对 |
| `images` | Trivy 例外必填：它覆盖的镜像（`cms`、`site-classic`、`postgres`）。只覆盖列出的镜像，同一软件包版本出现在别的镜像里需要另一条例外与自己的理由 |
| `fixBlockedBy` | 只用于**已有修复版本**的发现（Trivy 的 FixedVersion、npm 的 patched versions）：说明为什么暂时无法采用修复；此时 `reviewBy` 不得晚于当天之后 30 天。没有这个字段的例外不覆盖可修复的发现——可修复的就要修复 |
| `owner`、`reason` | 必填：负责人与理由（为什么不可利用、为什么暂时无法修复） |
| `reviewBy` | 漏洞例外必填，`YYYY-MM-DD`，不得晚于当天之后 180 天；过了这一天例外即过期，**每个扫描**都会失败，直到复查后续期或删除 |

- Gitleaks 的审核 id 与公开导出相同：路径、规则与该行原文的 SHA-256（`scripts/public-export.mjs` 的 `findingHash`），
  该行任何改动都会成为新发现。它绑定了确切内容，所以 `reviewBy` 可以省略；写了就同样检查。
- pnpm 的忽略配置（`package.json` 与 `pnpm-workspace.yaml` 中的 `auditConfig.ignoreGhsas` 与 `ignoreCves`，两处须一致，
  `pnpm settings:check` 检查）会让 `pnpm audit` 不列出该公告却仍计入计数。`pnpm-workspace.yaml` 由 `scripts/pnpm-audit-config.mjs`
  读取：键带不带引号（`'auditConfig'`、`"ignoreCves"`）、列表是块式还是 `[…]` 都能识别，读不懂的写法直接报错，不当作“没有忽略”。
  两处的忽略都要求有效的 `pnpm-audit` 例外。工作流与发布门禁运行审计时去掉这些忽略，被忽略的公告照常出现、按例外判定，计数必须与列出的
  公告一致（`--ignores-dropped`）。在本地直接运行 `pnpm audit`（带着忽略）时，计数中的高危与严重公告数不得超过列出的数目加上被忽略的数目，
  超过即报告被截断，记为未完成——有忽略并不会关掉这项检查。
- 例外由代码所有者审阅：`.github/CODEOWNERS` 把 `security/`、工作流、扫描与发布脚本交给维护者；在开启“需要代码所有者审阅”的
  分支保护后生效（私有仓库无法开启，公开仓库可以）。在此之前真正生效的控制是发布时的人工复核（见“发布门禁”第 3 条）：
  自上一版本以来新增或修改的每条例外都会列出，并绑定到确认码。新增例外要在 PR 中说明理由，复查期限尽量短；修复后删除例外。

## 镜像扫描发现的处理（2026-10-23）

前两次 `security.yml` 运行（公开仓库运行 39836326509、39838012100，结果相同）的例外、gitleaks 与 pnpm audit 通过，
Trivy 在三个镜像上失败。处理如下：

- **可修复的发现：消除，不作例外。** CMS 镜像中仅有的可修复发现（`brace-expansion`、`undici`、`http-cache-semantics`）都在
  `node:24-trixie-slim` 自带的 npm 里。CMS 运行时不调用任何包管理器（入口脚本与服务只运行 `node`；Astro 构建器启动的子进程也是 `node`，
  扩展是打包好的文件而不是安装），因此 CMS 镜像与渲染服务镜像一样删除 npm、npx、corepack 与 yarn；`ci.yml` 的 `docker-image`
  作业检查 CMS 与渲染服务镜像中都没有它们：既不在 PATH 上（npm、npx、corepack、yarn、yarnpkg），也没有它们的目录
  （`/usr/local/lib/node_modules/{npm,corepack,yarn}`、`/opt/yarn*`；`node:24-trixie-slim` 自带 `/opt/yarn-v1.22.22`）。三个镜像的最终阶段在构建时执行
  `apt-get -y --no-install-recommends dist-upgrade`（需要新依赖的更新不会被“保留”），随后先把 `apt-get -s dist-upgrade` 的输出取到变量里
  再核对：模拟本身失败时构建失败（不会被管道末尾的 grep 当作“没有待装更新”），仍有待装更新或被保留的软件包时也失败。Debian 发布的修复因此随每次构建进入镜像
  （2026-10-23 构建时，数据库镜像因此升级了 OpenSSL、xz、PCRE2；两个 Node 镜像没有可升级的软件包）。
- **有修复版本却不能马上采用：短期例外。** 检查拒绝用普通例外覆盖可修复的发现；只有写明 `fixBlockedBy` 且 30 天内复查的例外可以。
  2026-10-23 至 2026-10-29 只有 gosu 一组（上游 `postgres:18` 镜像中 gosu 的 Go 标准库）；2026-10-29 起数据库镜像不再含 gosu，
  这组例外已删除，目前没有 `fixBlockedBy` 例外（见下文“2026-10-29 去掉 gosu”）。
- **没有修复版本的发现：带期限的例外。** 例外由扫描报告生成，每条写明公告、软件包、确切的已安装版本、负责人 `maintainer`、
  按组的理由与复查期限。同一公告与软件包在不同版本或不同理由下分条登记；
  每条例外的 `images` 列出它覆盖的镜像，检查按公告、软件包、版本与镜像匹配，别的镜像不受它覆盖。报告属于哪个镜像由报告自身的
  ArtifactName（`heopress-<镜像>:scan`）决定；调用时用 `--image` 指定了别的镜像即判定失败，不能借别的镜像的例外。

| 镜像 | 组 | 发现数 | 理由要点 | 复查期限 |
|---|---|---|---|---|
| cms、site-classic | Debian 13 基础镜像软件包（util-linux 系列、login、acl、libsystemd0/libudev1、ncurses、perl-base），与数据库镜像同版本 | 各 43 | 见下文“2026-10-28 迁到 Debian 13”：复用数据库镜像的同一条例外（`images` 加上 cms、site-classic，理由补充 Node 镜像部分） | 2027-01-21 |
| postgres | 操作系统工具（util-linux、login、GnuPG、Perl、ncurses、acl、libudev） | 52 | Debian 未发布修复；PostgreSQL 服务器与 HeoPress 创建的扩展（pg_trgm、vector、zhparser）都不加载（ldd 核对；libuuid1 只被 HeoPress 不创建的 uuid-ossp 加载） | 2027-01-21 |
| postgres | libxml2 | 8 | 服务器与 LLVM JIT 链接，但只有 SQL 的 XML 函数会解析外部 XML；HeoPress 没有 xml 列也不调用 XML 函数；数据库端口只在 127.0.0.1 发布，生产编排不发布 | 2027-01-21 |
| postgres | libsystemd0 | 1 | 服务器仅为 sd_notify 链接；该漏洞属于 systemd-homed，容器里没有 systemd | 2027-01-21 |
| postgres | libtinfo6 | 1 | 只被 psql 与 LLVM JIT 用于终端能力，读取的是镜像内的 terminfo | 2027-01-21 |
| postgres | pgvector（`postgresql-18-pgvector`） | 1 | HeoPress 在用；漏洞在 IVFFlat 索引构建，HeoPress 只建 HNSW 索引，且只有应用自己的数据库角色能建索引；PGDG 发布修复后立即升级 | **2026-11-22**（30 天，比其他组短） |
| postgres | gosu 内的 Go 标准库（`fixBlockedBy`） | 26 | 已有修复（新版 Go），但 gosu 随上游 `postgres:18` 镜像提供，官方镜像重建后才能得到。**2026-10-29 已删除**：镜像改用 setpriv 垫片，不再含 gosu | ~~2026-11-20~~ |

2026-10-23 时共 146 条 Trivy 例外（2026-10-28 迁到 Debian 13 后见下文）。2026-10-23 在本地以 amd64 重建三个镜像，用同一版本的 Trivy 经 `scripts/security-scanners.mjs` 扫描，
发现与公开 CI 的两次运行一致（CMS 镜像少了已删除的 npm 中的 4 条），加上例外后三个镜像的检查都通过。

## 2026-10-28 迁到 Debian 13（trixie）

CMS 为 Git 快照安装的 `git` 在 Debian 12 上带来无修复的高危发现（libcurl3-gnutls、libldap-2.5-0、perl / libperl5.36 / perl-modules-5.36）。
维护者 2026-10-28 批准：

- CMS、渲染服务与开发镜像的基础改为 `node:24-trixie-slim`（显式 Debian 13，与数据库镜像同一发行版）。
- Git 快照改为进程内的 isomorphic-git，CMS 镜像不再安装 `git`（也不再安装 `ca-certificates`：Node 自带 CA）。
  仅在 trixie 上也仍有 libcurl3t64-gnutls（CVE-2026-12064、CVE-2026-8458）与完整 Perl（CVE-2026-9538）无修复，去掉 `git` 后它们不在镜像中，不登记例外。
- 删除 57 条只覆盖 cms、site-classic 的 Debian 12 例外；两个镜像余下的 43 条发现（各镜像相同）与数据库镜像同一公告、软件包与版本，
  就在那 43 条既有例外的 `images` 中加上 cms、site-classic，理由补充 Node 镜像部分：除基础镜像外不装软件包，`node` 与 sharp/libvips 只链接
  libc、libstdc++、libgcc_s、libm、libdl、libpthread、libresolv（ldd 核对）；CMS 会启动程序（Astro 构建器以 `prlimit`（util-linux）启动 `node` 子进程），渲染服务不启动程序。

本地以 Trivy 0.75.0（HIGH、CRITICAL，同 `security.yml`）扫描重建后的两个镜像，`check-security-scan.mjs trivy` 对 cms 与 site-classic 均通过（无未登记的发现）。

**复查**：到期前逐组复查——Debian 是否已发布修复（发布后构建时的 `dist-upgrade` 会装上，版本变化使例外不再匹配，届时删除例外）、
PGDG 是否已发布修复后的 pgvector。夜间扫描出现新的发现时按同样原则处理：
能修复就修复，不能修复才登记例外。

**以后减少暴露面**：Node 服务可以改用 distroless（如 `gcr.io/distroless/nodejs24-debian12`）或更小的基础镜像，镜像里不再有
util-linux、perl、ncurses 等操作系统工具，大部分例外随之消失；数据库镜像可以考虑基于 Alpine 的 `postgres:18-alpine`
（须验证 pgvector 与 zhparser 的构建以及 musl 下的中文分词），或自行构建不含 GnuPG、Perl 等工具的运行镜像。

## 2026-10-29 去掉 gosu

公开仓库的 `security.yml` 在数据库镜像上报出严重漏洞 CVE-2026-56857：仍是上游 `postgres:18` 镜像 `/usr/local/bin/gosu` 内编译进去的
Go 标准库（v1.24.6）。这组发现原以 `fixBlockedBy` 例外登记，但新的严重公告说明等官方镜像重建并不可靠。维护者 2026-10-29 决定：
**去掉 Go 二进制，不再登记例外。**

- `docker/postgres/Dockerfile` 的最终阶段先删除 `/usr/local/bin/gosu`（在 `dist-upgrade` 那一层），之后的层再把
  `docker/postgres/gosu-setpriv.sh` 复制到同一路径。删除必须早于复制、分在两层：删除留下 whiteout，Trivy 才不再报告基础镜像层里的二进制；
  只在同一路径上覆盖时，Trivy 仍按下层报告原来的 gosu（本地实测如此）。垫片是 POSIX sh 脚本，
  执行 `setpriv --reuid=<uid> --regid=<gid> --init-groups -- "$@"`（setpriv 属于 util-linux，Debian 13 基础镜像自带，不新增软件包）。
  它保留官方入口脚本的用法（`exec gosu postgres "$BASH_SOURCE" "$@"`，`docker-ensure-initdb.sh` 同样如此）：接受 `user`、`user:group`、
  `uid`、`uid:gid`（名称或数字）；真实、有效、保存的 uid/gid 都切换到目标用户（setpriv 把有效 ID 同时写入保存 ID），附加组取目标用户的组
  （uid 没有 passwd 条目时清空），像 gosu 一样把 `HOME` 设为目标用户的主目录，最后 `exec`，服务器仍是容器的 PID 1。
  未知的用户名或组名直接失败。
- 构建时核对：`/usr/local/bin/gosu` 是脚本而不是二进制，`gosu postgres` 得到 postgres 的 uid、组与主目录，否则构建失败。
  `docker/postgres/verify-extensions.sh`（CI 作业 “Database image loads pgvector and zhparser”）另外核对容器里的服务器进程
  （PID 1）的真实、有效、保存与文件系统 uid/gid 都是 postgres。
- `security/exceptions.json` 删除 gosu 的 26 条 Go 标准库例外（94 → 68 条），没有新增例外；不再有 `fixBlockedBy` 例外。

本地核对（arm64 与 amd64 各构建一次）：arm64 上空数据目录（走 initdb）与已有数据目录（“Skipping initialization”，数据保留）两种启动
都正常，服务器以 postgres（uid/gid 999、无有效能力）运行，`docker stop` 正常关闭；两个架构的 `verify-extensions.sh` 都通过（vector、zhparser、
pg_trgm）；Trivy 0.75.0（HIGH、CRITICAL，参数同 `security.yml`，经 `scripts/security-scanners.mjs`）扫描两个镜像，没有 gosu 或 Go 标准库的
发现（只剩 Debian 目标），`check-security-scan.mjs trivy --image postgres` 通过。

其他镜像：CMS 与渲染服务镜像基于 `node:24-trixie-slim`，不含 gosu。编排文件里的第三方镜像（如 `docker-compose.monitoring.yml` 的
`prodrigestivill/postgres-backup-local`）不由 HeoPress 构建，也不在扫描范围内。

## 发布门禁

`node scripts/public-release.mjs prepare` 在导出之后、构建之前调用 `scripts/release-security-gate.mjs`，`push` 在推送前再调用一次：

1. 在发布树上：例外完整且当天无过期；`pnpm audit`（同上，去掉忽略、公开仓库）没有未被覆盖的高危与严重公告。发布树已在导出时经过
   树外配置的 gitleaks 扫描。
2. 在公开仓库：从发布树算出公开 CI 镜像提交（`ci-mirror.mjs push` 用固定身份、时间与只含私有 SHA 的提交信息生成根提交，结果由树唯一确定），
   用 `gh api`（只读）查询该提交上 `.github/workflows/security.yml` 的运行（镜像推送或手动运行），最新一次必须已完成、结论为 success，
   且开始于 7 天内。Trivy 只在这里运行，所以没有这条记录就不能发布。这次运行必须是**发布树中的那份工作流**：运行的路径是
   `.github/workflows/security.yml`，且 GitHub 在镜像提交上为该路径保存的文件（blob）与发布树中的完全相同；运行中还必须有门禁自己
   规定的全部作业（`REQUIRED_JOBS`：例外检查、pnpm audit、gitleaks、三个镜像的 Trivy、汇总），且都已成功——这份清单在维护者本机的
   脚本里，不随发布树改变，删掉某项扫描的工作流即使运行成功也不算数。
3. **人工复核门禁所信任的文件**（`scripts/release-trust-review.mjs`）：门禁相信发布树中的工作流、扫描与判定脚本和例外文件，而任何提交都能
   修改它们，私有仓库又无法强制代码所有者审阅。因此 `prepare` 列出这些文件（`TRUST_FILES`：`security.yml`、`security/exceptions.json`、
   扫描、判定、门禁与发布脚本、三个镜像的 Dockerfile 与数据库镜像中代替 gosu 的 `docker/postgres/gosu-setpriv.sh`、`package.json`、`pnpm-workspace.yaml`、`.gitattributes`，以及承载镜像策略检查的
   `.github/workflows/ci.yml` 与其测试 `scripts/__tests__/security-workflow.test.mjs`）自上一个公开版本以来的
   变化——新增、修改、删除的例外（扫描器、编号、软件包与版本、镜像、负责人、复查期限、是否 `fixBlockedBy`）与其他文件的改动统计，
   第一次发布则是全部内容——并把完整差异写入发布目录下的 `security-review.diff`。**基准取自目标仓库本身**：只读取得目标分支的头（上一个
   公开版本及其标签）的树，与发布树比较；不读取私有仓库里的 `release/private-releases.jsonl`（被发布的提交可以改写它，把“上一个版本”
   指向已经削弱了的父提交，让差异显示为空）。目标仓库没有该分支时视为第一次发布。差异在任何仓库之外、对取出的文件运行
   （`git diff --no-index --text --no-ext-diff --no-textconv`，不读取主机与树中的属性和配置），`.gitattributes` 无法把改动变成
   “Binary files differ”或隐藏起来。信任文件必须是普通文件：发布提交、发布树或上一个公开版本中任何一个信任文件是符号链接都拒绝发布
   （例如 `security/exceptions.json` 指向 `security/allow.json` 时，扫描读取的是链接目标，而复核与摘要只看到链接本身）。这些文件在发布提交中的摘要计入确认码：维护者审阅之后复制的确认码只对这些版本有效，`push` 时重新计算，
   不一致即中止。**对这些文件的任何改动都必须在发布时审阅**：例外是否确有理由、期限是否合理，工作流与脚本是否削弱了扫描。

任何一项无法确认（`gh` 未登录、审计服务不可用、运行未结束）都中止发布。门禁通过时运行地址写入 `prepared.json`。

## 本地运行

```bash
node scripts/check-security-scan.mjs exceptions
node scripts/security-scanners.mjs audit --dir . --report /tmp/pnpm-audit.json
node scripts/check-security-scan.mjs pnpm-audit --report /tmp/pnpm-audit.json
```

Gitleaks 要在导出树上运行才与工作流一致（私有仓库根目录有不导出的文件与 `node_modules`）：先
`node scripts/public-export.mjs --out <空目录>`，再
`node scripts/security-scanners.mjs gitleaks --dir <导出目录> --report /tmp/gitleaks.json`，
最后 `node scripts/check-security-scan.mjs gitleaks --report /tmp/gitleaks.json --scan-root <导出目录>`。`--today YYYY-MM-DD` 可以指定判定日期。

## 扫描器版本

Gitleaks 与 Trivy 使用固定版本的发布包，按发布页的校验和文件核对 SHA-256 后才运行（`security.yml` 的 `env` 中的 `*_VERSION` 与
`*_SHA256`；gitleaks 同时装在 `ci.yml` 的 `checks` 作业里，让公开导出的真实 gitleaks 测试在 CI 中运行，两处版本与校验和须一致，
`security-workflow.test.mjs` 检查）。升级时版本与校验和一起改，校验和取自对应版本的 `*_checksums.txt`，并选择发布至少两周、没有安全通告的版本。
第三方 Action 与 `ci.yml` 一样固定完整提交 SHA。

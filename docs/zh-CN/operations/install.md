# 一条命令安装

在一台干净的 Ubuntu 24.04 服务器上，一条命令装好 HeoPress：Docker、数据库镜像、应用（API、worker、渲染服务）、
Caddy 反向代理与首个管理员。依据：spec `ops/install-and-scale`（一条命令安装）、P13 任务 3.1、3.4。

脚本：`docker/install.sh`；它使用的 Compose 文件：`docker/docker-compose.yml`、`docker/docker-compose.prod.yml`、
`docker/docker-compose.tls.yml`、`docker/docker-compose.domains.yml`，最后叠加 `docker/docker-compose.install.yml`。

## 1. 安装

前提：Ubuntu 24.04（amd64 或 arm64），至少 2 vCPU / 4 GB 内存、10 GB 以上可用磁盘；80 与 443 端口空闲；
管理域名（例如 `admin.example.com`）的 DNS A/AAAA 记录已指向这台服务器。

```bash
curl -fsSL https://raw.githubusercontent.com/web-casa/HeoPress/main/docker/install.sh -o install.sh
sudo bash install.sh --admin-domain admin.example.com --acme-email ops@example.com
```

脚本依次：

1. **检查已有安装**：安装目录（默认 `/opt/heopress`）下有 `heopress.conf` 或 `.env`，或者 Compose 项目（默认 `heopress`）
   已有卷或容器时，只输出"已有安装"并以 **退出码 3** 结束，**不修改任何文件与数据**；
2. **系统检查**：root、Ubuntu 24.04（`--skip-os-check` 可跳过，但不受支持）、架构、CPU / 内存 / 磁盘（低于最小部署时警告）、端口；
3. **Docker**：没有 Docker 时从 Docker 官方 apt 源（download.docker.com）安装 Docker Engine 与 Compose 插件并启动；
   已有 Docker 时直接使用（Compose 需 2.24.4 或更高）；
4. **获取版本**：下载 `v<版本>` 的源码包到 `/opt/heopress/releases/`；`--source <目录>` 改用本地源码树；
5. **镜像**：从源码构建数据库镜像（PostgreSQL 18 + pgvector + zhparser，见 `docker/postgres/Dockerfile`），
   拉取应用与渲染服务镜像（`--build` 改为从源码构建；`--image-archive` 从 `docker save` 归档离线导入）；
6. **配置与秘密**：生成数据库所有者密码、应用角色密码、`JWT_SECRET`、`ENCRYPTION_KEY`、渲染角色密码与内部共享密钥，写入
   `/opt/heopress/.env`（权限 600）；服务以应用角色连接数据库（见第 3 节"数据库角色"）；
7. **启动**：先启动 PostgreSQL、API、worker 与渲染服务（此时没有任何公网入口），等待就绪；
8. **首个管理员**：在 API 容器内部调用首次安装接口，生成强密码与私有后台路径；随后验证该管理员能登录；
9. **公网入口**：最后启动 Caddy，并经 Caddy 检查管理域名的就绪接口（ACME 模式下 DNS 尚未生效时只给出警告）。

结束时输出后台地址（`https://<管理域名>/`）与凭据文件的位置，**不输出密码**。

### 选项

| 选项 | 作用 |
|---|---|
| `--admin-domain` | 管理域名（必填） |
| `--acme-email` | ACME 证书账户邮箱（`--tls internal` 时可省略） |
| `--admin-email` | 首个管理员邮箱，默认 `admin@<管理域名>` |
| `--dir`、`--project` | 安装目录（默认 `/opt/heopress`）、Compose 项目名（默认 `heopress`） |
| `--version`、`--source` | 安装的版本；或使用本地源码树 |
| `--build`、`--cms-image`、`--site-image`、`--db-image`、`--image-archive` | 镜像来源 |
| `--tls acme\|internal` | 证书来源：ACME（默认）或 Caddy 本地 CA（测试与内网） |
| `--http-port`、`--https-port` | 宿主机端口（默认 80 / 443） |
| `--extra-compose` | 追加的 Compose 文件（可重复；记录在管理脚本里，之后每次都生效） |

退出码：0 安装完成；1 失败；2 参数错误；3 已有安装（未做任何修改）。

## 2. 安装后的文件

| 路径 | 内容 | 权限 |
|---|---|---|
| `/opt/heopress/.env` | Compose 变量与全部秘密（数据库所有者连接与应用角色密码、JWT、加密密钥、渲染角色、内部共享密钥） | 600 root |
| `/opt/heopress/secrets/admin-credentials` | 后台登录地址（含私有路径）、管理员邮箱与密码、备用码 | 600 root（目录 700） |
| `/opt/heopress/heopress.conf` | 安装记录（版本、项目、源码目录、管理域名）；它存在时安装脚本拒绝再次运行 | 644 |
| `/opt/heopress/heopress-compose` | 带全部 Compose 文件的 `docker compose` 包装脚本 | 700 root |
| `/var/log/heopress-install.log` | 安装日志（不含任何秘密） | 600 root |

```bash
sudo cat /opt/heopress/secrets/admin-credentials     # 一次性取出凭据，存入密码管理器后删除该文件（shred -u）
sudo /opt/heopress/heopress-compose ps                # 服务状态
sudo /opt/heopress/heopress-compose logs --tail=100 cms
```

`.env` 中的 `ENCRYPTION_KEY` 加密了数据库里的敏感字段，必须与备份**分开**妥善保存（见[备份与恢复](backup-restore.md)）。

**秘密不进日志**：秘密只由脚本生成并写入上述文件；管理员密码通过标准输入传给容器内的进程，不出现在命令行、终端输出或安装日志中；
脚本不使用 `set -x`。API 的请求日志把私有后台路径记为 `/<admin_path>`（`apps/cms/src/middleware/logger.ts`）。

## 3. 管理面隔离

安装使用 `docker/Caddyfile.domains`：

- 管理域名 → API（含 Studio）；Studio 只在安装时生成的私有路径下提供，其他路径返回统一的 404；
- 其他任何域名 → 渲染服务，且只有已验证并启用的站点域名（与预览域名）才能按需申请证书；
- 站点域名上 `/admin`、`/api`、`/internal` 在边缘直接返回 404，私有后台路径也只会到达渲染服务（404），永远不会到达 API；
- `/internal/*`（证书门与预览读取）在所有公网域名上都是 404，只供 Compose 网络内的服务调用；
- PostgreSQL 没有宿主机端口；API 没有宿主机端口，只经 Caddy 的管理域名访问。

安装后在 Studio 的站点设置中为每个站点添加域名，并把域名 DNS 指向这台服务器；域名验证通过后 Caddy 首次访问时自动申请证书。

### 数据库角色

依据：安全审查 S-5（`docs/reviews/v1-security.md`）。服务进程从不以表的所有者连接数据库：

| 角色 | 谁使用 | `.env` 中的变量 |
|---|---|---|
| 所有者 `heopress`（数据库镜像的超级用户） | 只在 `cms` 容器的入口脚本中执行迁移、创建或更新下面两个角色；宿主机上的 `heopress upgrade` 与备份恢复 | `DATABASE_OWNER_URL`、`POSTGRES_PASSWORD` |
| 应用角色 `heopress_app`：非超级用户、无 `BYPASSRLS`、不拥有应用表、不属于任何角色，行级安全对它生效 | `cms` 与 `cms-worker` 的服务进程 | `DATABASE_URL`，密码 `HEOPRESS_APP_PASSWORD` |
| 渲染角色 `heopress_render`：只读公开投影 | `site-classic` | `HEOPRESS_RENDER_DATABASE_URL` |

- `cms` 每次启动时以所有者执行迁移与 `node dist/app-role.mjs`（幂等；新迁移建的表经所有者的默认权限自动授权），
  随后从环境中删除所有者连接与两个角色的密码，再检查服务自己的连接（`node dist/app-role.mjs --check`）：目录信息与一次实测
  （临时表、强制行级安全、两个站点各一行，只能看到一行）都必须表明行级安全生效。安装设置了 `HEOPRESS_REQUIRE_APP_ROLE=true`，
  检查不通过时 `cms` 拒绝启动；日志中有 `heopress_app: row-level security applies`。
- `cms-worker` 不拿所有者连接；即使 `docker/.env` 提供了，入口脚本也会删掉。
- 应用角色的权限（`packages/database/src/app-role.ts`）：`public` 与 `pgboss` 中表的 `SELECT, INSERT, UPDATE, DELETE, REFERENCES`、
  序列的 `USAGE, SELECT, UPDATE`、函数的 `EXECUTE`，两个模式的 `USAGE, CREATE`（它自己建向量空间表与物化表），迁移历史只读；
  所有者的表上没有 `TRUNCATE`、`TRIGGER`，不能写已删除站点 ID 的保留表与维护开关（只有 `heopress upgrade` 以所有者设置）。
  扩展与队列模式由迁移安装；LISTEN/NOTIFY 与咨询锁不需要授权。
- 验收（第 5 节与 CI `image-runtime`）检查：角色属性、`cms`/`cms-worker` 的每个数据库会话都是 `heopress_app`、`site-classic` 的都是
  `heopress_render`、没有所有者会话、服务进程环境里没有所有者连接或角色密码，并在服务自己的连接上实测行级安全。

**本变更之前的部署**（`DATABASE_URL` 是所有者，没有 `DATABASE_OWNER_URL`）照常启动，但仍以所有者运行，`cms` 日志给出警告。切换方法：

1. 在 `.env`（安装布局为 `/opt/heopress/.env`）中：`DATABASE_OWNER_URL` 设为原来的 `DATABASE_URL`；`HEOPRESS_APP_PASSWORD` 设为新的随机值
   （`openssl rand -hex 24`，不要输出到终端日志）；`DATABASE_URL` 改为 `postgresql://heopress_app:<该密码>@postgres:5432/heopress`；
   加上 `HEOPRESS_REQUIRE_APP_ROLE=true`；
2. `sudo /opt/heopress/heopress-compose up -d cms cms-worker`。`cms` 创建应用角色，把运行时以所有者身份建的表（向量空间表、物化表）
   移交给它（日志 `[app-role] heopress_app now owns …`），然后通过检查。

备份与恢复在宿主机上以所有者（或有复制权限的角色）运行，见[备份与恢复](backup-restore.md)；恢复后的数据库在下次 `cms` 启动时自动恢复应用角色的授权。

## 4. 最小部署（2 vCPU / 4 GB，本地存储）

安装只运行 PostgreSQL、API、worker、渲染服务与 Caddy；缓存、队列、定时任务、检索都在 PostgreSQL 中，媒体存放在本地卷
（`storage`），没有 Redis、对象存储或外部搜索。2026-10-29 在模拟的 2 vCPU / 4 GB 服务器（下节）上安装并通过验收，
空闲时内存：API 177 MiB、worker 160 MiB、PostgreSQL 111 MiB、渲染服务 124 MiB、Caddy 13 MiB，合计约 585 MiB。

## 5. 验收与验证

`docker/scripts/accept-install.sh` 在安装好的服务器上以 root 运行（安装需使用 `--tls internal` 与
`docker/docker-compose.install-test.yml`），检查：

- 只运行 PostgreSQL、API、worker、渲染服务与 Caddy；
- 数据库角色（第 3 节"数据库角色"）：服务以 `heopress_app` / `heopress_render` 连接，行级安全生效，环境中没有所有者连接；
- 经 Caddy 的就绪检查、管理员用生成的凭据登录、私有路径下的 Studio、安装向导已关闭；
- 新建站点经 Caddy 在自己的域名上由渲染服务提供；该域名上所有管理路径（含私有后台路径）返回 404 且不是 Studio；
  `/internal` 在管理域名上也是 404；未知域名拿不到证书；
- 秘密文件权限；安装日志与全部服务日志中没有任何生成的秘密、密码、备用码或私有后台路径；
- 再次运行安装脚本退出码为 3，文件、容器与数据都不变。

两种运行方式：

```bash
# 本机：特权 ubuntu:24.04 容器模拟一台 2 vCPU / 4 GB 的干净服务器，安装脚本在其中自行安装 Docker（Docker-in-Docker，
# 全部容器共享这份配额），镜像以归档离线导入，然后运行验收
SIM_CPUS=2 SIM_MEMORY=4g docker/scripts/sim-vps-install.sh
```

CI 的 `install` 作业在 GitHub 的 ubuntu-24.04 运行器（干净虚拟机、systemd、预装 Docker）上从源码构建镜像，
以 root 运行 `docker/install.sh` 与验收脚本。

### 需要在真实 VPS 上人工确认的部分

模拟服务器没有 systemd（安装脚本改用 `service` 启动 Docker），CI 运行器预装了 Docker，两者都不申请 ACME 证书。
发布前在一台真实的 Ubuntu 24.04 VPS（2 vCPU / 4 GB）上执行一次：

1. 管理域名与一个站点域名的 DNS 指向该 VPS；
2. `sudo bash install.sh --admin-domain <管理域名> --acme-email <邮箱>`，确认 Docker 由脚本安装并随 systemd 开机启动；
3. 浏览器打开凭据文件中的登录地址并登录；添加站点域名，确认证书自动签发、页面可访问，站点域名上的 `/admin` 与私有路径为 404；
4. 重启服务器后服务自动恢复；再次运行安装脚本退出码为 3；
5. `grep` 安装日志与 `heopress-compose logs`，确认没有凭据文件中的任何值。

## 6. 安装中断后

脚本在写入 `heopress.conf` 前失败时，会留下 `.env`、卷或容器，再次运行会拒绝（退出码 3）。确认没有需要保留的数据后清理：

```bash
sudo /opt/heopress/heopress-compose down -v      # 删除该项目的容器与卷（数据库与媒体）
sudo rm -rf /opt/heopress/.env /opt/heopress/secrets /opt/heopress/heopress-compose
```

## 7. 升级

升级用 `heopress upgrade`（见[升级](upgrades.md)）。安装布局下它的参数与安装脚本生成的文件对应：

| 变量 | 安装布局下的值 |
|---|---|
| `HEOPRESS_UPGRADE_ENV_FILE` | `/opt/heopress/.env`（`HEOPRESS_VERSION` 在这里） |
| `HEOPRESS_UPGRADE_COMPOSE_ARGS` | 与 `/opt/heopress/heopress-compose` 相同的 `--project-name`、`--env-file` 与全部 `-f` 参数 |
| `HEOPRESS_UPGRADE_SERVICES` | `cms cms-worker site-classic`（Compose 中的服务名，即默认值，可不设） |
| `HEOPRESS_UPGRADE_CMS_URL` | `https://<管理域名>`（API 没有宿主机端口，只经 Caddy 访问） |
| `DATABASE_OWNER_URL` | `.env` 中的同名变量（`DATABASE_URL` 是应用角色，不能迁移） |

升级命令需要宿主机上有新版本的代码目录与 Node.js 24，安装脚本不安装它们。在安装布局上执行完整升级**尚未验证**，发布前与第 5 节的人工步骤一起在真实 VPS 上确认。

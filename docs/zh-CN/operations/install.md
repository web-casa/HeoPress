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
6. **配置与秘密**：生成数据库密码、`JWT_SECRET`、`ENCRYPTION_KEY`、渲染角色密码与内部共享密钥，写入
   `/opt/heopress/.env`（权限 600）；
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
| `/opt/heopress/.env` | Compose 变量与全部秘密（数据库、JWT、加密密钥、渲染角色、内部共享密钥） | 600 root |
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

## 4. 最小部署（2 vCPU / 4 GB，本地存储）

安装只运行 PostgreSQL、API、worker、渲染服务与 Caddy；缓存、队列、定时任务、检索都在 PostgreSQL 中，媒体存放在本地卷
（`storage`），没有 Redis、对象存储或外部搜索。2026-10-29 在模拟的 2 vCPU / 4 GB 服务器（下节）上安装并通过验收，
空闲时内存：API 177 MiB、worker 160 MiB、PostgreSQL 111 MiB、渲染服务 124 MiB、Caddy 13 MiB，合计约 585 MiB。

## 5. 验收与验证

`docker/scripts/accept-install.sh` 在安装好的服务器上以 root 运行（安装需使用 `--tls internal` 与
`docker/docker-compose.install-test.yml`），检查：

- 只运行 PostgreSQL、API、worker、渲染服务与 Caddy；
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

升级命令需要宿主机上有新版本的代码目录与 Node.js 24，安装脚本不安装它们。在安装布局上执行完整升级**尚未验证**，发布前与第 5 节的人工步骤一起在真实 VPS 上确认。

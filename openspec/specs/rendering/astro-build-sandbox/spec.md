# rendering/astro-build-sandbox Specification

## Purpose
让 Astro 构建在**不可信主题代码**（第三方或市场来源）下也安全：每次构建是一个一次性、无网络、只读根、受资源限制的
rootless 容器，主题代码读不到密钥与宿主文件、不能外联、不能耗尽宿主资源；运行时不可用时构建**失败**而不是回落到
共享内核的子进程。隔离强度可通过运行时开关提升（gVisor），但默认档位必须在 2 vCPU / 4 GB 的共享型 VPS 上可用。

## Requirements

### Requirement: 构建运行在一次性 rootless 容器内

系统 SHALL 在一次性 rootless 容器内执行 Astro 构建，容器以非 root 身份运行、根文件系统只读、除构建输入与输出外
MUST NOT 挂载任何宿主路径，MUST NOT 携带 CMS 凭据或实例密钥。容器 MUST NOT 复用上一次构建的任何状态。

#### Scenario: 根文件系统只读
- **WHEN** 主题代码在构建中尝试写根文件系统（例如 `/etc` 或应用目录）
- **THEN** 写入失败，构建以 `SANDBOX_FAILED` 结束，日志包含容器内的失败原因，宿主文件未改变

#### Scenario: 没有多余挂载
- **WHEN** 检查一次构建的容器配置
- **THEN** 挂载只有只读的输入目录、可写的输出目录与 tmpfs，且不含任何以站点数据目录、密钥目录或 Docker socket 为源的挂载

#### Scenario: 每次构建都是新容器
- **WHEN** 同一站点连续构建两次
- **THEN** 第二次构建使用新的一次性容器，看不到第一次构建留下的任何文件

### Requirement: 构建期没有网络

构建容器 SHALL 在无网络命名空间中运行（`--network none`）；主题代码 MUST NOT 能访问公网、内网或 CMS API。
构建所需的依赖 SHALL 预装在构建镜像中，页面数据 SHALL 由宿主以只读输入文件提供。

#### Scenario: 主题尝试外联
- **WHEN** 主题代码在构建中尝试连接任意地址
- **THEN** 连接立即失败，构建以失败结束，且没有任何出站流量产生

#### Scenario: 缺少预装依赖
- **WHEN** 主题声明了构建镜像里没有的依赖
- **THEN** 构建失败并明确指出缺少的包与「依赖必须预装」的处理方式，而不是在构建期联网安装

### Requirement: 资源限制与超限终止

构建 SHALL 受 CPU、内存、进程数与墙钟超时限制，并在输出目录上施加大小上限；任一限制超限时 MUST 终止整个容器
（含其子进程）并清理输出，不得留下残留容器或进程。

#### Scenario: 内存超限
- **WHEN** 主题代码分配超过配置上限的内存
- **THEN** 容器被终止，构建以 `SANDBOX_LIMIT` 结束，站点其余构建不受影响

#### Scenario: 超时
- **WHEN** 一次构建超过墙钟上限
- **THEN** 容器被终止，构建以 `SANDBOX_TIMEOUT` 结束，并清理输出目录

#### Scenario: 输出超限
- **WHEN** 构建产物超过大小上限
- **THEN** 构建失败并返回 `SANDBOX_OUTPUT_TOO_LARGE`，超限的产物被删除，不进入发布

### Requirement: 运行时不可用时构建失败

当 rootless 容器运行时、其 cgroup v2 能力、用户命名空间映射或构建镜像不可用时，构建 SHALL 失败并返回
`SANDBOX_UNAVAILABLE` 与可执行的修复说明；系统 MUST NOT 回落到在宿主上以子进程执行主题代码。

#### Scenario: 未安装运行时
- **WHEN** 宿主机没有可用的 rootless 容器运行时
- **THEN** 构建失败并说明需要安装什么，且没有任何主题代码在宿主上被执行

#### Scenario: 能力不足
- **WHEN** 宿主机有运行时但没有 cgroup v2 或没有子 uid 映射
- **THEN** 构建失败，错误说明缺少的具体能力，健康检查同时报告构建沙箱不可用

### Requirement: 构建沙箱状态可观测

系统 SHALL 在健康检查中暴露构建沙箱的可用性与不可用原因，使运维在允许第三方主题之前能够确认前置条件已满足。

#### Scenario: 读数
- **WHEN** 请求健康检查
- **THEN** 响应包含构建沙箱的 `available` 布尔值与（不可用时）原因码，且该读数不包含任何密钥或路径细节之外的敏感信息

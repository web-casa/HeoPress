# platform/runtime-baseline Specification

## Purpose
定义 HeoPress 支持的运行环境、健康检查行为，以及发布产物中对上游 LumiBase 的归属与产品标识要求。

## Requirements

### Requirement: 支持的运行环境
系统 SHALL 在 Node.js 24 LTS 及以上版本运行，并 SHALL 以 PostgreSQL 18 及以上版本作为数据库。
系统在不满足版本要求的环境中 MUST 拒绝启动，并输出所需版本。

#### Scenario: 在受支持环境中启动
- **WHEN** 服务在 Node.js 24 与 PostgreSQL 18 上启动且迁移已执行
- **THEN** 服务正常监听端口，就绪检查返回成功

#### Scenario: Node 版本过低
- **WHEN** 服务在 Node.js 22 上启动
- **THEN** 进程以非零退出码结束，并输出"需要 Node.js >= 24"

#### Scenario: 数据库版本过低
- **WHEN** 服务连接到 PostgreSQL 17
- **THEN** 进程以非零退出码结束，并报告"需要 PostgreSQL >= 18"

### Requirement: 健康检查
系统 SHALL 提供存活检查与就绪检查两个端点。就绪检查 MUST 在数据库不可连接或存在未执行的迁移时返回非成功状态。

#### Scenario: 数据库不可用
- **WHEN** 数据库连接中断后请求就绪检查
- **THEN** 返回非 200 状态；对有权查看可观测性详情的调用方，响应体指出数据库不可用（匿名调用方只得到总体状态，不暴露子系统细节）

#### Scenario: 迁移未执行
- **WHEN** 数据库可连接但尚未执行本版本自带的全部迁移时请求就绪检查
- **THEN** 返回非 200 状态，可观测性详情中迁移检查为不健康

#### Scenario: 存活检查不依赖数据库
- **WHEN** 数据库连接中断后请求存活检查
- **THEN** 返回 200

### Requirement: 上游归属与产品标识
所有发布产物（源码包、Docker 镜像）SHALL 包含本项目 `LICENSE`（AGPL-3.0-only）、上游 `LICENSES/Apache-2.0.txt` 与含 LumiBase 归属声明的 `NOTICE`。
面向用户的产品名、包名、CLI 名、镜像名与环境变量 MUST NOT 使用 "LumiBase" 品牌。

#### Scenario: 镜像包含归属文件
- **WHEN** 构建生产 Docker 镜像
- **THEN** 镜像内存在 `LICENSE`、`LICENSES/Apache-2.0.txt` 与 `NOTICE`，且 `NOTICE` 含 LumiBase 归属声明

#### Scenario: 使用旧环境变量前缀
- **WHEN** 仅设置了 `LUMIBASE_` 前缀的必需环境变量并启动
- **THEN** 启动失败，并提示对应的 `HEOPRESS_` 变量名

### Requirement: 修改文件的归属标记
修改过的上游文件 SHALL 携带显著的修改声明，并保留原有版权与归属；提交历史 MUST NOT 替代文件内的修改声明。

#### Scenario: 检查源码发布包
- **WHEN** 检查一个已修改的上游源码文件
- **THEN** 文件包含原有版权与本项目修改声明

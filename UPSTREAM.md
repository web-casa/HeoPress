# 上游基线（Upstream）

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/khuepm/LumiBase |
| 许可证 | Apache-2.0 |
| 候选基线 A | tag `v1.0.0-rc.4`（标签对象 `f4c29fb10eec291f72f89cebf95413dcd94a54f8`，指向提交 `4c2078d81a8e1dc2c5acd642fd1e640c208ca4fd`，2026-09-28 发布） |
| 候选基线 B | `main` @ `93936ef0a4ce215e436beffe0cde6828fc8ff76e`（2026-10-13） |
| 选定基线 | **B：`main` @ `93936ef0a4ce215e436beffe0cde6828fc8ff76e`**（2026-10-15 比较后选定，理由见下节） |
| 分叉方式 | 硬分叉。裁剪后不再整体合并上游；上游安全修复按需人工挑选（cherry-pick）并记录在下表 |

## 基线比较（2026-10-15）

`v1.0.0-rc.4..93936ef` 共 116 个提交（33 docs、31 fix、26 merge、16 chore、9 feat、1 test），未发现 `!:` 或 `BREAKING CHANGE` 标记。

rc.4 之后的安全相关修复（按设计决策 1，存在安全修复即选 main）：

| 提交 | 内容 |
|---|---|
| `bacfd565` | sharp 升至 0.35.5（librsvg 安全公告） |
| `94f03b99` | fast-uri authority 校验安全公告 |
| `329c62a9` / `fc5052b3` | Next.js 升至 16.3.8（GHSA-vcvr-r3jv-pc5j） |
| `ba416b6e` | handlebars 升至 4.7.10 |
| `60e3272b` / `8f2302c6` | proxy-addr、source-map-js 覆盖到已修复版本 |
| `ea754c41` / `ba9b3a10` | graphql-tools/utils 升至 12.0.3 |
| `a8fdf083` / `a50a1de2` | 清除其余中低危生产依赖公告 |
| `34cc6b9e` | CDC 游标只接受规范格式的 token |
| `e339e46d` | SDK 斜杠裁剪改为线性时间（避免回溯型复杂度） |
| `e7c61f1f` | 脚手架生成的独立 Next.js 依赖加固 |

其余为正确性修复（REST 与 MCP 治理写入一致、PATCH 保留未提交字段与治理上限、异步预算、Agent 运行入队失败恢复、LLM 用量如实上报）
与新增能力（`POST /ai/decisions` 决策接口及 SDK 类型），均为向后兼容的新增。

结论：选定 `main@93936ef`。rc.4 之后没有破坏性变更，且包含多项依赖安全修复，选 rc.4 意味着需要再逐个挑选这些修复。

## 迁移基线压缩（P02，2026-10-16）

P02 删除功能后，把迁移历史压缩为单一初始迁移 `packages/database/drizzle/0000_heopress_baseline.sql`（由 `drizzle-kit generate` 从 schema 生成）。尚无生产数据库，没有升级路径：带旧迁移记录的数据库会被迁移脚本拒绝，需重建。

| 项 | 值 |
|---|---|
| 上游最后一个迁移 | `0018_goal_dispatch_rotation`（基线 `93936ef`） |
| 压缩前最后一个迁移 | `0020_cdc_cursor_millisecond_precision`（HeoPress 新增 `0019_heopress_agent_default`、`0020_cdc_cursor_millisecond_precision`） |
| 压缩前迁移数 | 21（`0000_lumibase_init` … `0020`） |
| 结构转储哈希（SHA-256） | `1c1f6b04e2999b602ed667200c8bfa3b40326bcc136683c8a4eed9d5d2449977` |
| 结构范围 | `public` schema 98 张表的列、约束、索引，以及视图、序列、枚举 |

哈希的计算方法：旧迁移全部执行后删除已移除功能的 7 张表（`lumibase_cdc_pipelines`、`lumibase_cdc_deployments`、`lumibase_cdc_pipeline_health`、`lumibase_firebase_sync_pipelines`、`lumibase_firebase_sync_log`、`lumibase_push_subscriptions`、`lumibase_scim_tokens`），再运行
`npx tsx scripts/compare-schemas.ts --dump <DATABASE_URL> | sha256sum`（在 `packages/database` 下）。在空库上执行新基线后得到同一哈希；两库用同一脚本的比对模式逐表比对，结果一致。

## 归属要求（Apache-2.0 §4）

- 保留上游 `LICENSE` 与所有源文件中的版权声明。
- 在 `NOTICE` 中注明："This product includes software developed by the LumiBase project (https://github.com/khuepm/LumiBase)."
- 修改过的文件在提交历史中可追溯；对外发布说明中写明基于 LumiBase 修改。
- 不使用 "LumiBase" 作为产品名或包名（Apache-2.0 §6 不授予商标权）。

## 上游修复挑选记录

| 日期 | 上游提交 | 内容 | 本仓库提交 | 备注 |
|---|---|---|---|---|
| — | — | — | — | — |

## 修改文件标记

提交历史用于追溯；对修改过的上游文件，还须保留显著的文件内修改声明（Apache-2.0 §4(b)），不能仅依赖私有 Git 历史。P01 建立检查，后续每次公开导出复验。

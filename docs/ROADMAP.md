# 开发路线图：13 个 Phase

每个 phase 对应一个 OpenSpec change（`openspec/changes/pXX-…`）。phase 按依赖顺序实施；
每个 phase 结束必须通过 Phase Gate（见 `AGENTS.md` §6）后归档，再进入下一个 phase。

## 总览

| Phase | Change | 目标 | 依赖 | 规模 |
|---|---|---|---|---|
| P01 | `p01-fork-baseline` | 分叉 LumiBase，建立可构建、可测试、可交接的工程基线（含依赖许可证检查） | — | M |
| P02 | `p02-prune-feature-surface` | 按 ADR-0004 删除 / 关闭功能，压缩迁移基线 | P01 | M |
| P03 | `p03-postgres-only-infrastructure` | 去掉 Redis / MinIO / Meili / imgproxy 必需依赖，只用 PG 18 运行 | P02 | L |
| P04 | `p04-platform-hardening` | 写入并发安全、变更事件同事务写入与事件消费框架、Hold、域名解析与 TLS、每站存储、模型接入、稳定区块 ID | P03 | L |
| P05 | `p05-site-network-content-model` | 站群内容模型、编辑策略、跨域翻译组、译文新鲜度、按集合固定链接与语言前缀、赞助标记、共享字段与翻译状态 | P04 | XL |
| P06 | `p06-classic-rendering-engine` | Classic 引擎：多域名 SSR、运行时主题、缓存失效 | P05 | XL |
| P07 | `p07-seo-geo-surface` | SEO / GEO 输出、站点审计与站内链接图、AI 流量分析；M1 预览发布准备（发布流水线、CLA、许可证文件、SDK 授权边界） | P06 | XL |
| P07a | `p07a-studio-carbon-ui` | Studio 改为 Carbon 设计与站群运营信息架构（ADR-0019）：8 个模块、跨站只读汇总、审计处置、只读事件流、中英双语 | P07 | L |
| P08 | `p08-content-ingestion` | 信源、采集、降级链、去重、来源授权与使用方式、规则版本与断点续采、来源媒体处理 | P05 | XL |
| P09 | `p09-ai-pipeline-quality-gate` | 翻译 / 改写 / 撰写流水线、质量门禁、可信自动发布、成本控制与计费覆盖 | P07、P08 | XL+ |
| P10 | `p10-agent-collaboration-mcp` | MCP OAuth、按用户按站授权、批量操作计划与审批、Skills、通知 | P09 | L |
| P11 | `p11-publishing-pipeline-astro` | 事件消费运维（监控、重放、统一对账）、Git 快照、Astro 静态引擎、多平台前台部署 | P07 | XL |
| P12 | `p12-extensions-and-site-import` | 插件权限与九类扩展点（ADR-0015）、术语表参考插件、通用导入包、Astro 内容目录导入器与 URL 对照 | P09、P11 | XL |
| P13 | `p13-operations-v1-release` | 备份恢复、数据保留、升级工具、100 站压测、v1 发布 | P10、P12 | XL |

规模：M ≈ 1–2 周，L ≈ 2–4 周，XL ≈ 4–6 周，XL+ ≈ 6–8 周（单人 + AI 辅助的粗略量级，P01 完成后按实测重估）。
合计约 **42–66 周**（2026-10-15 按规格量重估：P05、P07、P08 调为 XL，P09 为 XL+；写入规格的正确性要求与拆分到 v1.1 / v1.2 的能力大致相抵）；P08、P11 用独立 worktree 并行可以缩短。建议 M1（P07）后先发布预览版收集反馈，不等 v1。

> P08 只依赖 P05，可以在 P06 / P07 进行时由另一个 Agent 在独立 worktree 并行开发。
> P07a 是 P07 之后插入的界面 phase（维护者 2026-10-23 决定），只依赖 P07，可与 P08 并行；建议在发布 M1 预览版之前完成，使预览版使用新界面。
> P07a 状态（2026-10-24）：已合并（PR #26）并归档（`openspec/changes/archive/2026-10-24-p07a-studio-carbon-ui`）。

## 里程碑

| 里程碑 | 完成于 | 可演示的结果 |
|---|---|---|
| M0 工程基线 | P03 | 只用 PG 18 + Node 24 跑通全部上游测试；2 核 4G VPS 上的内存基线 |
| M1 能用的站群 | P07（预览版界面：P07a） | 一个进程服务 3 个以上域名，人工发文，SEO / GEO 输出完整；具备发布预览版的流水线与许可证文件 |
| M2 自动化内容运营 | P09 | 夜间定时采集 → 翻译 → 门禁 → 可信来源自动发布，其余进入人工审核 |
| M3 AI 原生协作 | P10 | 两个用户分别用不同外部 Agent 经 MCP 操作各自授权的站点，无静默覆盖 |
| M3.5 可扩展与可迁入 | P12 | 垂直功能以插件实现（术语表参考插件）；运营者第一批 Astro 站点在演练环境完成导入且 URL 对照无未说明差异 |
| M4 v1.0 | P13 | 100 站压测、备份恢复演练、安装脚本与文档齐备 |

## 依赖图

```text
P01 → P02 → P03 → P04 → P05 ─┬→ P06 → P07 ─┬→ P09 ─┬→ P10 ───────┬→ P13
                             │             │       └→ P12 ───────┘
                             │             ├→ P11 ────→ P12
                             │             └→ P07a（界面，M1 预览版前）
                             └→ P08 ─────────→ P09
```

> P11 只依赖 P07，人手充足时可以与 P09 / P10 并行；默认按编号顺序实施。P12 需要 P09 与 P11 都完成（可与 P10 并行）；P13 需要 P10 与 P12 都完成。

## 贯穿所有 phase 的规则

1. **Phase Gate**：`openspec validate --all --strict`、类型检查、单元与集成测试、文档、交接记录、归档。
2. **兼容性**：每个 phase 在 PG 18 + Node 24 上测试；涉及迁移的 phase 提供可回滚说明。
3. **安全**：涉及外部 URL 的功能必须经过 SSRF 防护测试；涉及权限的功能必须有越权测试（跨站点、跨用户）。
4. **性能预算**：P06 建立 Classic 引擎基线（缓存命中与未命中的 p95 延迟、常驻内存）；P07、P11、P12、P13 的 Gate 复测，其他 phase 只有改动渲染路径时才复测；退化超过 20% 需说明。
5. **合规**：ADR-0009 的规则在 P08、P09、P10 的 spec 中落为可测试的需求；ADR-0016 的赞助内容规则在 P05、P06、P11 落实。
6. **插件边界**（ADR-0015）：只服务某一类站点的功能做成插件；运营者私有插件不进入公开仓库（见 `docs/backlog/private-plugins.md`）。

## 未纳入 v1（后续）

后续版本 v1.1 / v1.2 的能力（WordPress 导入、翻译待办界面、简报式改写、时效性标记、简报插件、Markdown 内容协商、专用机器翻译等）见 `docs/backlog/v1.1-v1.2.md`；
WordPress 导入（v1.1，复用 P12 导入包，见 `docs/backlog/wordpress-import.md`）、静态目录挂载（见 `docs/backlog/static-directory-mount.md`）、
其余官方插件（订阅邮件、纠错、配图池等，见 `docs/backlog/official-plugins.md`）、Astro 构建容器沙箱（开放第三方主题市场前，见 `docs/backlog/astro-build-sandbox.md`）、
专题聚合页、AI Agent 按次付费阅读（MPP / x402 插件）、去中心化插件注册表、访客 AI 问答小部件、MCP 一键安装包（.mcpb）、
多实例部署（PG LISTEN/NOTIFY 实时通道）、GEOFlow 通用 API 对接、千问办公 / 豆包官方连接器上架。

## 评审后的验收边界

- 依赖表表示最小技术依赖；默认仍按编号通过 Gate 并归档。P08 与 P11 的并行必须使用独立 worktree，分别只依赖 P05 与 P07，不把 P10 通知、P12 插件权限或 P13 备份工具作为前置。
- P03 建立统一出站安全与至少一次任务语义；P04 建立事件消费框架（ADR-0011），P05/P06/P07 的消费者直接基于它实现并各自带兜底对账；P11 只补监控、重放与统一对账报告。
- 公开发布流水线、CLA 与许可证文件在 P07 建立（M1 预览发布准备），P01 只做依赖许可证检查。
- P06 的 30/300 ms 是工程优化目标，P13 的 50/400 ms 是固定 4 vCPU/8 GB、50 并发的 v1 验收阈值；改进计划不能替代 Gate。2 vCPU/4 GB 另验最小可运行。
- 工期为初估而非承诺；新增安全、隔离、OAuth、迁移和真实平台联调均计入重估，平台账号与额度需提前准备。
- 每个 Phase Gate 核对一次 Requirement/Scenario 到实现任务与测试的映射；功能组只在对外行为变化时就地更新文档；涉及迁移提供数据不丢失的回滚演练。P13 发布先生成可审查树，通过 Gate/归档后从指定提交重新导出已归档规格，复验扫描与独立构建，最后由维护者确认推送。

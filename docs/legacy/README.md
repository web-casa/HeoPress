# docs/legacy：上游归档

本目录保存从上游 LumiBase（`main@93936ef`）导入、但不再作为 HeoPress 现行规则或文档的原始文件，仅供追溯与查阅。
这里的内容**不是**当前规范，开发以根目录 `AGENTS.md`、`openspec/` 与 `docs/decisions/` 为准。

| 路径 | 内容 | 归档原因 |
|---|---|---|
| `upstream/AGENTS.md`、`upstream/CLAUDE.md`、`upstream/README.md`、`upstream/gitignore.txt` | 合并时与本仓库冲突的上游根文件原文 | 根目录以本项目版本为准（P01 任务 1.2） |
| `upstream/agent-config/` | 上游的 Claude Code、Codex、Cursor、Devin、Kiro 配置、命令与钩子 | 上游 SessionStart 钩子会把仓库 git 身份改成上游作者并关闭署名；本项目以 `AGENTS.md` 为唯一 Agent 入口。文件改用 `.txt` 等扩展名，避免被工具加载 |
| `upstream/CHANGELOG.md` | 上游 LumiBase 的历史变更记录 | 上游发布历史不能记作 HeoPress 的版本；根目录 `CHANGELOG.md` 从分叉开始记录 |
| `upstream/architecture.md` | 上游架构说明 | 描述的是上游边缘运行时架构；上游开发备忘 `memory.md` 中仍有效的约定已并入 `AGENTS.md`（P01 任务 4.1），原文在 P02 删除 |
| `upstream/UX Psychology Principles for LumiBase.pdf` | 上游 UX 原则资料 | 二进制原文保留 |
| `kiro-specs/` | 上游 Kiro 规格 | 本项目需求以 OpenSpec 管理（P01 任务 4.4） |
| `kiro-steering/` | 上游 Kiro 引导规则 | 同上，统一 Agent 入口为 `AGENTS.md` |

上游原文保留原有版权与 Apache-2.0 许可（见 `LICENSES/Apache-2.0.txt` 与 `NOTICE`）。

P02 任务 1.2 删除了上游博客与推广文章、CMS 行业日报（原 `upstream/content/`）和作者备忘 `upstream/memory.md`；需要时可从 Git 历史中的上游基线提交取回。

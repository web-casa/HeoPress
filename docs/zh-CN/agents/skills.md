# 官方 Skills

HeoPress 在仓库 `skills/` 目录提供五个官方 Skill，供 Claude Code、Codex 等外部 Agent 安装，指导 Agent 按 HeoPress 的规则通过 MCP 操作站群：

| 目录 | Skill | 用途 |
|---|---|---|
| `skills/site-management` | `heopress-site-management` | 查看与新建站点，多站点修改走批量操作计划 |
| `skills/news-research` | `heopress-news-research` | 调研新闻选题并产出草稿 |
| `skills/translation-editing` | `heopress-translation-editing` | 检查翻译状态，在分支中编辑译文 |
| `skills/seo-geo-editing` | `heopress-seo-geo-editing` | 按审计与链接图修复 SEO / GEO 问题 |
| `skills/theme-design` | `heopress-theme-design` | 浏览主题并通过计划切换主题 |

## 声明格式

每个 `SKILL.md` 的前置元数据声明最低 HeoPress 版本与所需 MCP 工具（工具名见[《MCP 工具参考》](./mcp-tools.md)）：

```yaml
---
name: heopress-site-management
description: …
heopress:
  minVersion: 1.0.0-rc.4
  mcpTools:
    - sites_list
    - plans_submit
---
```

## 共同规则

所有 Skill 都要求 Agent：操作前确认目标站点与语言；涉及多个站点时先列出站点清单请用户确认，再用 `plans_submit` 提交批量操作计划；
修改已有资源带 `expectedVersion`，冲突时重新读取而不覆盖；新建带 `idempotencyKey`；被拒绝时如实说明而不绕过。

## CI 校验

`pnpm skills:check`（`scripts/check-skills.mjs`，包含在 `pnpm check:all` 中）在以下情况失败，并指出 Skill 与缺失的工具名：

- 声明的工具，或正文中以反引号引用的工具名，不在 MCP 工具目录中（例如工具被重命名）；
- 缺少 `minVersion`，或其高于当前版本；
- 五个官方 Skill 之一缺失。

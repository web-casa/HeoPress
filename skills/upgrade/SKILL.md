---
name: heopress-upgrade
description: 协助运营者升级 HeoPress 实例：升级前检查、选取冒烟测试页面、解读 `heopress upgrade` 的结果与失败报告，并指导插件作者用 codemod 迁移插件 API 的破坏性变更。
heopress:
  minVersion: 1.0.0-rc.4
  mcpTools:
    - sites_list
    - site_get
---

# 升级

## 通用规则

1. 升级命令只由运营者在服务器上执行（`heopress upgrade …`）。你通过 MCP 只能读取站点信息；不要尝试执行命令、修改配置文件或数据库，
   除非运营者明确要求并在隔离环境中给了你 shell。你的职责是准备、解释与提醒。
2. 不要跳过或绕过任何一步：兼容检查、升级前备份、副本预演、维护模式与写入冻结、最终备份都是强制的；没有配置备份目标（`HEOPRESS_BACKUP_TARGET`）时升级会在兼容检查处停止，这是预期行为。
3. 不要建议用旧备份覆盖已经开放写入的新版本：`heopress upgrade rollback` 会拒绝，正确做法是向前修复，或先制定数据保留方案再人工恢复。
4. 不要在输出中复述数据库连接串、令牌或 `.env` 中的任何值。

## 升级前

1. 请运营者阅读目标版本的发布说明，特别是"插件 API 破坏性变更"一节。
2. 用 `sites_list`（`scope: { instance: true }`）列出站点，用 `site_get` 读取每个站点的主域名，
   挑选每个站点一到两个公开页面，交给运营者设置为冒烟测试地址（`HEOPRESS_UPGRADE_SMOKE_URLS`，逗号分隔）。
3. 请运营者在目标版本的代码目录中先执行只读检查：

   ```bash
   heopress upgrade check
   ```

   逐条解释输出中的问题（版本降级、跨大版本、PostgreSQL 版本、迁移历史不一致、插件声明的版本范围不含目标版本、缺少备份提供方），
   并给出对应处理办法；全部通过后再进入下一步。
4. 提醒运营者：维护期间所有写入（REST、Studio、MCP 写工具、Flows、队列与定时任务）会被拒绝，读取与公开站点不受影响；请选择低峰时段。

## 升级

运营者执行 `heopress upgrade run` 后，按状态解读结果：

- `completed`：升级成功并已开放写入。建议运营者在 Studio 抽查内容保存与发布。
- `aborted`：在维护之前（或排空写入超时）停止，生产未改变。根据失败步骤给出原因：预演失败通常是迁移与现有数据不兼容，请运营者把报告交给开发者。
- `rolled-back`：维护期间失败，已恢复配置、数据库与应用并验证，写入已重新开放。说明失败步骤，建议修复后择期重试。
- `failed-in-maintenance`：恢复未通过验证，系统保持维护、拒绝写入。逐条说明失败的步骤，请运营者先修复（例如备份存储不可达），
  再执行 `heopress upgrade rollback --id <升级编号>` 重试恢复；`heopress upgrade status` 可随时查看记录。

## 插件作者

插件依赖的旧 API 由官方 codemod 迁移。先试运行，再写入，然后类型检查并测试插件：

```bash
heopress-ext codemod --list
heopress-ext codemod --dir ./my-plugin
heopress-ext codemod --dir ./my-plugin --write
```

codemod 只做可确定的转换；报告中的"manual step"是无法自动转换的部分，代码保持原样，需要作者按提示手工处理（例如改用插件设置或密钥代替环境变量）。

# Git 快照格式

已发布内容以 Markdown 持续导出到运营者的 Git 内容仓库，作为版本历史与灾难恢复的补充。
数据库是唯一权威（ADR-0006）：Git 不是内容来源，对仓库的手工修改会在下一次导出或对账时被覆盖并记入修复报告。

实现：`packages/database/src/schema/git-snapshots.ts`（表）、`apps/cms/src/services/git-snapshots/format.ts`（路径与 front matter）、
`apps/cms/src/services/git-snapshots/exporter.ts`（消费者、导出、对账）、`apps/cms/src/services/git-snapshots/config.ts`（仓库配置与凭据）、
`apps/cms/src/services/git-snapshots/git.ts`（`git` 命令行封装）。

## 配置

每个站点配置一个内容仓库（站点管理员）：`GET /api/v1/site/git-snapshots` 读取，`PUT /api/v1/site/git-snapshots` 修改，
`POST /api/v1/site/git-snapshots/reconcile` 立即排队一次对账。

- 远端只接受 `https://`，URL 中不得带用户名或密码；地址经 SSRF 检查，git 只连接检查时解析出的地址（`http.curloptResolve`），不跟随重定向。
  `file://` 远端只在 `HEOPRESS_GIT_SNAPSHOT_ALLOW_FILE_REMOTES=true` 时允许（测试与本地镜像）。
- 访问令牌以实例密钥 `ENCRYPTION_KEY` 加密存储（AES-GCM，绑定站点与字段）；接口只返回是否已设置与末四位，日志与错误信息中的令牌会被抹去。
  令牌只以 HTTP 头的形式经子进程环境传给 git，不写入 URL、参数或磁盘上的配置。
- 工作副本位于 `HEOPRESS_GIT_SNAPSHOT_DIR`（默认 `data/git-snapshots/<站点 ID>`），每次导出前重置为远端分支。
- Docker 镜像已包含 `git`。

## 目录结构

```
websites/<主域名>/
  _site/site.json                     公开站点配置（名称、语言、公开 SEO / 身份、内容设置）
  _site/theme/theme.json              当前已发布主题版本：名称、版本号、内容哈希、模板列表、资源清单（只有路径与哈希）
  _site/theme/templates/<模板路径>     已发布主题的模板
  YYYY/MM/<slug>/index.md             已发布条目（文章、页面），年月取发布时间（UTC）
```

- 主域名取站点的主公开域名；路径段经规范化（NFC、小写、去掉分隔符与控制字符、不以点开头、最长 120 字符），拒绝 `..` 与 `.git`。
- **语言碰撞**：同一主域名、年月与 slug 有多个条目时，站点默认语言的条目保留原路径，其他语言使用 `<slug>--<语言>`（如 `hello--zh-cn`）；
  同语言仍冲突时再加 `--<条目 ID>`。同样的输入总得到同样的路径。
- 域名、slug 或发布日期变化时，新路径写入、旧路径在同一次提交中删除。
- 图片、视频不进入 Git，正文只保留引用 URL；主题资源只导出清单。

## 条目文件

```markdown
---
id: "Xk2…"
title: "Hello"
slug: "hello"
locale: "en"
translationGroup: "grp_…"
publishedAt: "2026-10-05T12:00:00.000Z"
contentModifiedAt: "2026-10-06T12:00:00.000Z"
author: "Ada Writer"
source:
  url: "https://source.example.com/x"
  attribution: "Source Ltd"
  licenseStatus: "cc-by"
seo:
  title: null
  description: null
  canonical: null
  robots: null
---

正文（区块渲染出的已净化 HTML 转为 Markdown）
```

所有值都以 JSON 字符串形式写出（YAML 双引号标量），字段顺序固定。来源字段取条目的 `source_url`、`source_attribution`、`source_license`，
没有采集来源时为 `null`。

## 字段白名单与个人数据（ADR-0013）

front matter 是封闭清单：只有上面列出的键，不会按名称复制条目数据中的任何其他字段。

- 作者只导出**公开显示名**（作者条目的 `name`）。
- **不导出**：邮箱、用户 ID（包括作者条目的 `user` 字段）、IP、会员数据、评论、草稿、原始抓取快照、私有信源配置、密钥。
- 站点配置只来自公开投影，并再去掉名称像密钥的字段（`secret`、`token`、`password`、`key` 等）。
- 提交的作者与提交者是配置的机器人身份；提交信息只写操作者**类型**的计数（如 `user x2`）与事件时间范围，不写用户 ID 或姓名。

因此删除个人数据通常不需要改写 Git 历史。历史提交中的已发布内容仍可追溯，不承诺下架后从历史中消失。

## 导出与提交

1. 事件消费者 `git-snapshots` 收到条目、路由、站点设置、翻译组或主题的变更后，只把站点排入队列（`lumibase_git_snapshot_queue`，30 秒窗口），不等待 Git。
2. 后台任务每 10 秒取到期站点，持有站点租约：拉取远端分支，按公开投影生成站点的全部文件，删除不再发布的文件，合并为**一次提交**并推送。
3. 推送失败（远端不可用、拒绝）时发布不受影响：队列行保留并以 30 秒起翻倍、最多 1 小时的间隔重试，错误（已抹去令牌）记入站点状态。
   下一次重试从远端重新生成同一棵树，因此已推送的提交不会重复产生；树未变化时不提交。

## 对账

每天 03:40 以及手动触发时，对每个启用的站点排入一次对账（`reconcileGitSnapshots`，其他模块可直接调用；`run: true` 时立即执行并返回报告）。
对账与普通导出是同一次比较，按**内容哈希**而不是文件是否存在判断：

- 上次推送的文件被手工删除 → 恢复（`restored`）；
- 文件内容被手工修改 → 覆盖（`overwritten`）；
- 站点目录中出现不属于已发布集合的文件 → 删除（`removed-extra`）。

报告写入站点状态的 `lastReport`，可在 `GET /api/v1/site/git-snapshots` 查看。

# Git 历史改写（人工流程）

适用于：必须从站点的 **Git 内容仓库**（P11 Git 快照）历史中移除一段文字或一个文件。
HeoPress **不会**自动改写 Git 历史，也没有任何接口、任务或 Agent 工具可以做这件事（ADR-0013、spec `ops/data-retention`
"Git 历史改写需人工批准"）。改写只能由实例所有者批准后，由有仓库管理权限的人按本流程手工执行。

本流程是工程默认做法，不构成法律意见。

## 先确认是否真的需要

Git 快照按设计不含个人数据：front matter 是封闭白名单，作者只导出公开显示名，不导出邮箱、用户 ID、IP、会员数据、评论、
草稿或原始抓取快照（见 [Git 快照格式](../zh-CN/publishing/git-snapshots.md)）。因此个人数据删除请求通常只需要：

1. 在 HeoPress 中执行删除请求（`POST /api/v1/admin/erasure`，见[《数据保留》](../zh-CN/operations/data-retention.md)）；
2. 等下一次导出（或 `POST /api/v1/site/git-snapshots/reconcile`）把当前文件更新为删除后的状态。

只有当已发布正文本身曾包含必须从**历史提交**中消失的内容（例如误发布的个人信息、被法院命令移除的文字）时，才进入下面的流程。

## 1. 申请与批准

由提出人填写改写申请，交实例所有者批准。申请至少写明：

- 站点与内容仓库（远端地址、分支）；
- 要移除的内容：文件路径，或需要替换的文字（申请中不要粘贴个人数据原文，用描述与位置代替）；
- 原因与依据（删除请求编号、法律要求等）；
- 影响：所有提交哈希会改变，仓库的所有克隆都要重新获取；
- 执行人与计划时间。

实例所有者以书面方式（工单、签字邮件）确认批准；批准记录保存在仓库之外（不要提交到内容仓库本身）。
没有所有者批准，不得执行以下任何步骤。

## 2. 先在 HeoPress 中修正当前内容

数据库是唯一权威（ADR-0006）：只改写 Git 而不改数据库，下一次导出会把内容重新写回。

1. 在 Studio 中编辑或下线相关条目，或执行删除请求；
2. 手动触发一次对账（`POST /api/v1/site/git-snapshots/reconcile`），确认远端分支的最新提交已不含该内容。

## 3. 停止导出

在站点的 Git 快照设置中停用导出（`PUT /api/v1/site/git-snapshots`，`enabled: false`），确认没有正在进行的推送。
否则改写过程中 HeoPress 可能基于旧历史再推送一次。

## 4. 备份与改写

在一台受控的工作机上（不是生产容器，生产镜像不包含 `git`）：

```bash
# 1) 完整镜像备份（改写失败时可回退；按批准范围保存并在完成后销毁）
git clone --mirror https://git.example.com/site-content.git site-content-backup.git

# 2) 在另一份镜像中改写（git-filter-repo，MIT 许可证，需单独安装）
git clone --mirror https://git.example.com/site-content.git site-content.git
cd site-content.git
# 移除整个文件的全部历史：
git filter-repo --invert-paths --path 'websites/example.com/2026/10/some-post/index.md'
# 或者替换一段文字（expressions.txt 每行一条 "原文==>替换"，文件放在仓库外并在完成后删除）：
git filter-repo --replace-text ../expressions.txt
```

改写后检查：`git log --all -p | grep -c '<关键词>'` 应为 0（关键词用不含个人数据的唯一片段）。

## 5. 推送并通知

```bash
git push --force --mirror https://git.example.com/site-content.git
```

- 如远端开启了分支保护，临时允许强制推送，完成后立即恢复。
- 托管平台可能保留旧提交的缓存（拉取请求、引用日志、复刻）：按平台的说明请求清理。
- 通知所有持有克隆的人删除旧克隆并重新克隆。

## 6. 清理 HeoPress 的本地对象库并恢复导出

HeoPress 在 `HEOPRESS_GIT_SNAPSHOT_DIR`（默认 `data/git-snapshots/<站点 ID>/store.git`）保存一个裸仓库，其中仍有旧对象：

1. 确认导出已停用，删除该站点的 `store.git` 目录（下一次导出会从远端重新获取）；
2. 重新启用导出（`enabled: true`），触发一次对账，确认报告没有异常、远端历史中不再出现被移除的内容；
3. 销毁第 4 步的镜像备份与 `expressions.txt`。

## 7. 记录

在批准记录中补充：执行时间、执行人、改写前后远端分支的提交哈希、对账报告结果。不在记录中写被移除内容的原文。

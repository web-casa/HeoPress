# docs/i18n-parity Specification

## Purpose
让中英文文档的结构债务像其它存量债务一样被冻结：新增单语文档或新增结构漂移立即失败，已偿还的债务必须从基线移除。
判定不依赖 git 历史，因此在公开镜像的全新检出上与本地得到相同结论。

## Requirements

### Requirement: 不依赖历史的仓库级双语结构判定
门禁 SHALL 枚举 `docs/zh-CN/` 与 `docs/en/` 下的每一份文档，并把每个路径判定为"双语对"或"单语文档"。
双语对 SHALL 使用既有的结构检查规则判定（语言、标题、代码块、行内代码、链接目标、表格、front matter、篇幅），
门禁 MUST NOT 重新实现这些规则，也 MUST NOT 读取 git 历史、分支或提交信息。

#### Scenario: 无共同历史的检出
- **WHEN** 在一个没有 `main` 历史的完整检出上运行门禁
- **THEN** 它给出与本地完整仓库相同的判定，退出码只取决于树与基线

#### Scenario: 单语与成对分别判定
- **WHEN** `docs/zh-CN/a.md` 只有中文、`docs/en/b.md` 与 `docs/zh-CN/b.md` 都存在
- **THEN** `a.md` 按单语规则判定，`b.md` 按双语结构规则判定

### Requirement: 每个未登记的单语文档失败
门禁 SHALL 读取提交基线 `docs/i18n-parity-baseline.json`。树中存在、但基线未登记的单语文档 MUST 使门禁失败，
并在信息中指出缺失的 locale 与修复方向（补齐另一语言，或走评审确认后更新基线）。

#### Scenario: 新增一份只有中文的文档
- **WHEN** 基线未登记 `docs/zh-CN/publishing/new.md`，而树里只有它的中文版本
- **THEN** 门禁以非零退出，并列出该路径与它缺少的 `docs/en/` 对侧

#### Scenario: 已登记的单语文档
- **WHEN** 一份单语文档在基线里，且树里仍然只有一侧
- **THEN** 门禁不因它失败

### Requirement: 结构漂移按问题码登记
基线 SHALL 为每个已知漂移的文档对登记它被允许出现的问题码。实际漂移问题码全部包含在登记集合内时门禁 SHALL 通过；
出现任何未登记的问题码时 MUST 失败，并列出该码与所属文档对。

#### Scenario: 允许的漂移
- **WHEN** 某对只报 `inline-code`，基线为它登记 `["inline-code", "links"]`
- **THEN** 门禁通过并通过数量汇总说明该对仍在基线内

#### Scenario: 不允许的漂移
- **WHEN** 某对报了基线未登记的 `headings`
- **THEN** 门禁以非零退出并指出 `headings`

### Requirement: 基线必须与当前树一致
基线 MUST 只描述当前债务，因此债务消失时基线陈旧，同样 MUST 失败并提示用更新命令收缩：已登记的单语文档长出对侧
（或两侧都不再存在）、已登记的漂移对不再报任何问题码、登记的问题码不再出现，都属于陈旧。

#### Scenario: 已登记的单语文档补上了对侧
- **WHEN** 基线把 `publishing/git-snapshots.md` 记为单语，而树里中英文都已存在且结构一致
- **THEN** 门禁失败并说明该条目陈旧、应运行更新命令把它从基线移除

#### Scenario: 漂移被修好
- **WHEN** 某对上一版报了 `tables`，这一版不再报任何问题
- **THEN** 门禁失败并列出可收缩的条目，而不是静默通过

### Requirement: 基线更新命令
门禁 SHALL 提供 `--update`，用当前树重写基线：单语路径与文档对按字典序、问题码去重排序、固定缩进与结尾换行。
同一棵树连续执行两次 MUST 产生逐字节相同的文件。更新命令 MUST NOT 访问网络，也 MUST NOT 依赖 git 历史。

#### Scenario: 幂等
- **WHEN** 对同一棵树连续执行两次 `--update`
- **THEN** 两次写出的基线逐字节相同，且随后的检查模式通过

### Requirement: 接入统一仓库检查
强制门禁 SHALL 由 `pnpm check:all` 运行，从而在每个提交的 CI `checks` 作业上执行；仓库 MUST 同时提供检查与更新两个脚本入口。
旧的按改动清单判定的门禁 MUST 保留其单测，并 MUST NOT 被描述为当前强制的门禁。

#### Scenario: 新增单语页挡住提交
- **WHEN** 一个 PR 只添加 `docs/zh-CN/…` 下的新文档
- **THEN** `pnpm check:all` 因新门禁失败，PR 不能靠"没碰 `main` 的历史"绕过

### Requirement: 发布与 Git 快照文档的双语覆盖
`docs/zh-CN/publishing/frontend-deployments.md` 与 `docs/zh-CN/publishing/git-snapshots.md` SHALL 拥有结构一致的
`docs/en/publishing/` 英文版本并带翻译来源标记；这两条 MUST NOT 继续留在单语基线中。英文版本 MUST 与代码一致地描述能力矩阵：
Netlify 的 `markdown-negotiation` 为 `degraded`（本部署路径只上传文件、不发送 Deploy API 的 `edge_functions`），
Cloudflare Pages 为 `yes`，Vercel 与 VPS 为 `degraded`。

#### Scenario: 运营者读英文部署文档
- **WHEN** 英文读者打开 `docs/en/publishing/frontend-deployments.md`
- **THEN** 标题层级、表格、代码块与链接目标与中文页一致，且 Netlify 的 Markdown 协商仍写为 `degraded`

#### Scenario: 两页不再算作债务
- **WHEN** 运行检查模式的门禁
- **THEN** 基线中不再出现 `publishing/frontend-deployments.md` 与 `publishing/git-snapshots.md`

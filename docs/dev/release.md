# 公开发布与外部 PR 回迁

本文说明如何把私有开发仓库的一个提交发布为公开仓库 `web-casa/HeoPress` 的一个版本，以及如何把公开仓库收到的外部 PR 回迁到私有仓库。
决策依据：ADR-0008（许可证）、ADR-0010（私有开发仓库 + 清洗后发布的公开仓库）、ADR-0018（公开 CI 镜像）。

公开仓库只能通过本文的发布流水线更新（CI 镜像的 `ci/*` 分支除外，见 ADR-0018），不得手工复制文件，也不得在 `../public/` 中开发。

## 涉及的文件

| 文件 | 公开 | 作用 |
|---|---|---|
| `release/public-manifest.yaml` | 是 | 白名单：`include` 列出导出的路径，`never` 列出永不导出的路径 |
| `release/RELEASES.md` | 是 | 公开版本表：只记版本、标签、日期与说明，不得出现提交 SHA |
| `release/private-terms.txt` | 否 | 私有词表（运营者域名、服务器地址等），扫描用 |
| `release/gitleaks-reviewed`、`release/opaque-reviewed` | 否 | 经人工确认的 gitleaks 误报与不可扫描文件 |
| `release/private-releases.jsonl` | 否 | 公开版本与私有提交的对应，推送成功后才写入 |
| `scripts/public-export.mjs` | 是 | 导出与扫描（CI 镜像与发布共用） |
| `scripts/public-release.mjs` | 是 | 发布：`prepare` 与 `push` |
| `scripts/ci-mirror.mjs` | 是 | 公开 CI 镜像（ADR-0018） |
| `scripts/release-security-gate.mjs` | 是 | 发布的安全门禁（`prepare` 与 `push` 调用） |
| `scripts/security-scanners.mjs`、`scripts/check-security-scan.mjs`、`security/exceptions.json` | 是 | 安全扫描与例外（见 `docs/dev/security-scanning.md`） |

永不公开的类别内置在 `scripts/public-export.mjs`（`NEVER_PUBLIC`）：交接、调研、review、ADR、backlog、基准、进行中的 OpenSpec change、
Agent 工具目录、私有词表、扫描审核记录、`release/` 下任意层级名为 `private*` 的私有发布记录（如 `release/archive/private-releases.jsonl`），以及 `legal/`（待律师审阅的法律草案；
审阅定稿的文本以根目录的许可证文件发布）；`.env.example` 之外的 `.env*` 文件也永不导出。
白名单的 `include` 若指向这些类别（例如误写 `docs/handoffs/**`），导出直接失败，而不是悄悄丢弃。

名称按大小写不敏感的文件系统比较（Unicode NFKC、小写、去掉每段末尾的点与空格）：例如 `release/PRIVATE-RELEASES.JSONL`、
`apps/.ENV.production`、`apps/.GITLEAKS.TOML` 与小写名称是同一个文件，出现这类变体时导出直接失败。报告中的路径与链接目标若含私有词，
以 `[term #n]` 代替。

## 发布前提

- 本机有 `git`、`pnpm`、Node 24 与 `gitleaks`。没有 gitleaks 时导出报告“密钥扫描未完成”并停止，不会当作通过。
- 本机 `gh` 已登录（只读：查询公开仓库的工作流运行），并能访问 npm 仓库（`pnpm audit`）。
- **安全扫描已通过**（P07 任务 8.1）：先对要发布的提交执行 `node scripts/ci-mirror.mjs push`，等公开仓库上该镜像提交的
  `Security scans`（`.github/workflows/security.yml`）运行成功，且开始时间在 7 天内。镜像提交由导出树唯一确定，
  `prepare` 会从发布树重新算出它并核对这次运行，见下文与 `docs/dev/security-scanning.md`。
- 许可证文件齐全且已定稿：`LICENSE`、`LICENSE-EXCEPTION.md`、`COMMERCIAL-LICENSE.md`、`CLA.md`、`LICENSES/Apache-2.0.txt`、`NOTICE`。
  缺少任一个，或文件中任何位置仍有草案标记，导出中止。规则是“定稿文本不含任何草案标记”：注释 `<!-- release: draft -->`、
  任意大小写的单词 draft（标题、`Status: draft`、“unsigned draft” 等）、同一行内的 “pending / awaiting / under / for … review”
  与 “subject to … review / approval”（中间最多约 80 个字符，如 “pending outside counsel review”、“for external counsel review”）、
  “to be reviewed”、“pending signature”、“not final”、“not (yet) finalized / finalised”、`草案`、`未定稿`，以及同一行内的
  “待 / 未经 / 正在 … 审阅 / 审核”（中间最多约 40 个字符）都算草案标记（英文按整词匹配），定稿时要全部删除，而不只是第一行。
  草案判定适用于所有许可证类文件：上述六个文件、`LICENSES/` 下的全部文件（生成的修改文件清单除外）；任意目录下名为
  `LICENSE`、`LICENCE`、`COPYING`、`CLA`、`COMMERCIAL-LICENSE`（可带 `-` 或 `.` 后缀，如 `packages/sdk/LICENSE`、`LICENSE-MIT`、`CLA.md`）
  或 `NOTICE`、`NOTICE.md`、`NOTICE.txt` 的文件；根目录下还有 `COMMERCIAL*` 等（按词匹配，`CLAUDE.md` 不算）。代码与数据文件
  （如 `license-policy.json`、`claims.ts`）不算。指向草案的符号链接也算草案。
  CI 镜像（`ci-mirror.mjs push`）导出时不包含仍是草案的许可证类文件（目前是 `CLA.md` 与 `COMMERCIAL-LICENSE.md`），定稿后才随镜像与发布公开；
  发布则要求六个文件全部存在且已定稿，并拒绝任何仍是草案的许可证类文件。
  `LICENSE-EXCEPTION.md` 必须是律师审阅定稿的 `legal/PLUGIN-AND-THEME-EXCEPTION.md`，不能直接复制草案（`legal/` 本身永不公开）。
- 在私有仓库的完整克隆中操作（浅克隆会被拒绝：无法判断公开历史中有没有私有提交）。
- 要发布的提交已经通过 PR 合入私有仓库 `main` 并已 fetch：`prepare` 要求它是 `refs/remotes/origin/main` 的祖先。`--main-ref` 只能指向主分支
  （`refs/heads/main`，或 `refs/remotes/origin/main` 且 `origin` 的地址是私有仓库；私有仓库名不写进公开文件，由环境变量
  `HEOPRESS_PRIVATE_REPO`（`owner/name`）给出，未设置时 `origin/main` 一律拒绝）；其他引用（例如功能分支，
  会让自己的提交“已合入”；或 fork 的 `main`）一律拒绝。只有 `--test-target` 演练时例外，而 `--test-target` 只能与本地 `file:///` 目标一起使用，
  与公开仓库一起使用时 `prepare` 与 `push` 都会拒绝。
- 其 `release/RELEASES.md` 有这个版本的一行，且不含提交 ID（40 位 SHA，或私有仓库认识的 7–40 位缩写都会被拒绝），例如：

  ```markdown
  | 0.1.0 | `v0.1.0` | 2026-11-01 | M1 预览版 |
  ```

## 发布步骤

1. 在私有仓库 `main` 的干净工作区准备（导出、独立构建、构建后再扫描、生成确认码）：

   ```bash
   node scripts/public-release.mjs prepare --version v0.1.0 --target https://github.com/web-casa/HeoPress.git
   ```

   `prepare` 依次执行：
   - 检查目标是公开仓库 `web-casa/HeoPress`（只有加 `--test-target` 时才允许本地 `file://` 测试仓库，用于演练），私有仓库不是浅克隆，
     提交已合入 `--main-ref`，`release/RELEASES.md` 列出该版本且不含提交 ID，该版本尚未发布（`release/private-releases.jsonl`）；
   - 按白名单导出该提交到 `~/.cache/heopress-release/v0.1.0/tree`（`HEOPRESS_RELEASE_STATE` 可改位置），拒绝永不公开类别、
     不安全的路径名（`..`、`.git` 等）、越出导出树的符号链接、扫描器配置文件，并做私有词表、gitleaks 与不可扫描文件检查；
   - **安全门禁**（`scripts/release-security-gate.mjs`，在构建之前）：发布树的 `security/exceptions.json` 完整且无过期例外；
     对发布树的锁文件运行 `pnpm audit`（去掉项目的审计忽略、使用公开 npm 仓库），高危与严重公告都有有效例外；
     从发布树算出公开 CI 镜像提交（与 `ci-mirror.mjs push` 生成的完全相同），用 `gh api` 只读查询公开仓库在该提交上的
     `.github/workflows/security.yml` 运行：最新一次必须已完成、结论为 success、开始于 7 天内（Trivy 镜像扫描只在那里运行）。
     运行还必须是发布树中那份 `security.yml`（GitHub 在镜像提交上为该路径保存的文件与发布树相同），且门禁规定的全部扫描作业都已成功。
     任何一项不满足（包括 `gh` 未登录、审计服务不可用、运行未结束）都中止，运行地址记入 `prepared.json`；
   - 复制一份到 `build/`，在独立环境中依次执行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm build`、`pnpm test`，
     任一步失败即中止。独立环境只沿用主机的 `PATH` 与语言设置；HOME、XDG 目录、临时目录、corepack、npm 缓存与 pnpm store 都是
     `build-env/` 下新建的（与 `build/` 并列，不放进构建目录，以免被当作构建产物扫描或被工具遍历），npm 用户与全局配置为空，
     仓库固定为公开 npm 仓库；没有密钥、`DATABASE_URL`、`NODE_OPTIONS`、`npm_config_*`、`PNPM_*`。主机的 `~/.npmrc`、缓存与 store
     都不会被用到，因此能构建就说明公开用户也能构建；
   - 构建后检查构建没有改动任何导出文件，再扫描构建留下的全部内容（`node_modules` 除外），并重新扫描发布树——不复用构建前的扫描结果；
   - **人工复核安全门禁所信任的文件**（`scripts/release-trust-review.mjs`）：打印 `security.yml`、`security/exceptions.json`、扫描、
     判定、门禁与发布脚本、镜像的 Dockerfile、`package.json`、`pnpm-workspace.yaml`、`.gitattributes` 自上一个公开版本以来的变化。
     基准是**目标仓库**中目标分支的头（只读 `git ls-remote` 并取到临时仓库，附带其标签），不是 `release/private-releases.jsonl`
     （被发布的提交能改写它）；目标没有该分支时为第一次发布，复核全部内容。列出新增、修改、删除的例外（编号、软件包、镜像、负责人、
     复查期限）与改动统计，完整差异（在仓库之外对取出的文件生成，不受 `.gitattributes` 影响）写入
     `~/.cache/heopress-release/<版本>/security-review.diff`。**这些文件的任何改动都必须在此审阅后才能确认**；
   - 在全新的临时仓库中把发布树写成 git tree（必须与导出完全一致），打印树摘要与确认码。确认码绑定树摘要、私有提交、上述信任文件的摘要、
     目标仓库、分支与标签。

2. 审阅 `~/.cache/heopress-release/v0.1.0/tree`（这就是要公开的全部内容）与 `security-review.diff`（安全门禁所信任的文件的变化），确认无误后推送：

   ```bash
   node scripts/public-release.mjs push --version v0.1.0 --confirm <prepare 打印的确认码>
   ```

   `push` 先重新扫描发布树并重建 git tree、重新计算信任文件的摘要：确认之后发布树有任何变化（改文件、加链接、加 env 文件），或确认码对应的是别的树、
   别的信任文件版本、目标或标签，都会中止，须重新 `prepare`。
   随后再过一次安全门禁（`prepare` 之后例外可能过期、扫描运行可能超过 7 天），不通过即中止，什么也不推送。
   然后在全新的裸仓库中，以目标分支的当前头为父提交（空仓库则为根提交）生成一个提交，作者为固定的 “HeoPress Release” 身份；
   这个提交的历史中只要有私有仓库认识的提交就拒绝（公开历史不含私有历史）。最后打附注标签，先写入待完成的推送意图
   （`push-intent.json`，含公开提交与树），再以对刚读到的分支头的租约原子推送分支与标签，核对远端已显示两者后，才把对应关系追加到
   `release/private-releases.jsonl` 并把意图标记为完成。

   推送已到达远端、但在写入记录前中断（进程被杀、断电）时，用同一确认码再执行一次 `push`：远端标签指向意图中的提交与树时，
   只补写记录、不再推送；标签指向别处则中止，须人工核查。此时不要重新 `prepare`：版本目录中有已到达远端的待完成推送时，
   `prepare` 拒绝删除它并提示用同一确认码执行 `push`（推送没有到达远端时才允许重新准备）。

   持久性：推送意图、`release/private-releases.jsonl` 与意图的完成标记都整体替换（完整写入临时文件——短写会循环写完，
   写不进任何字节则报错且不替换——再 fsync、改名、对目录 fsync），并在下一步之前完成。追加记录时先读出整个日志、在内存中加一行，
   再整体替换。顺序固定为“写意图 → 推送 → 核对远端 → 追加记录 → 标记完成”。因此任何时刻断电，结果只能是：远端没有标签；
   或有待完成的意图（用 `push` 补全）；或记录已写入。
   旧版本（逐行追加）中断时可能留下末尾不完整的一行：读取时容忍它，下一次写入时去掉它；其他位置的损坏一律拒绝，须人工修复。
   补全中断的推送时先核对远端标签与意图，再读日志，因此这类残行不会妨碍补全。
   日志的“读出—加一行—整体替换”在独占锁下进行：锁文件 `release/private-releases.jsonl.lock` 以 O_EXCL 创建并写入持有者的进程号与时间，
   同时进行的另一次发布会等待（最多 30 秒，之后报告持有者进程号并中止，不改动日志），不会覆盖对方的记录；同一版本的同一记录只写一次，
   同一版本记录了不同的公开提交则中止。持有者进程已不存在或锁已超过 10 分钟即视为失效锁，下一次写入时接管
   （先移开并核对正是判定失效的那把锁，否则放回）；进程仍在运行时不要手工删除锁。锁文件属于 `release/private*`，永不公开。

   远端地址可能带凭据（如 `https://x-access-token:…@github.com/…`）：所有错误与日志中的仓库地址都去掉凭据后再输出
   （userinfo 显示为 `***`，名称像凭据的查询参数值也显示为 `***`）。带凭据的私有仓库地址仍被认作私有仓库。

3. 提交 `release/private-releases.jsonl`（只在私有仓库）。

推送是维护者的决定：Agent 只能在临时测试仓库演练，不得推送到公开仓库。

## 演练

发布流程的测试（`scripts/__tests__/public-release.test.mjs`）在临时目录中创建私有夹具仓库与本地裸仓库，完成一次 `prepare` 与 `push`，
并验证以下情况都会失败：导出引用了未导出的模块（构建失败）、构建写入私有词或密钥、确认后改动发布树、目标历史含私有提交、缺少许可证文件、
安全门禁不通过（`prepare` 在构建前中止，`push` 什么也不推送）。门禁本身的判定（没有运行、运行未结束或失败、运行过旧、`gh` 不可用、
例外过期、未覆盖的高危公告、审计未完成）由 `scripts/__tests__/release-security-gate.test.mjs` 以桩代替网络验证。演练时给
`prepareRelease` / `pushRelease` 传入通过的门禁桩，不访问 GitHub。

```bash
pnpm scripts:test
```

手工演练时把 `--target` 换成本地裸仓库并加 `--test-target`，例如先 `git init --bare /tmp/heopress-rehearsal.git`，
再用 `--target file:///tmp/heopress-rehearsal.git --test-target`。其他远端地址一律拒绝。
演练会写入 `release/private-releases.jsonl`，演练后删除这一行，不要提交。

## 失败时

- 白名单或扫描命中：报告只给文件与行号（以及词表序号），不输出命中原文。确是私有内容就从提交中移除；
  gitleaks 误报经人工确认后把报告中的 review id 写入 `release/gitleaks-reviewed`；不可扫描文件按内容 SHA-256 写入 `release/opaque-reviewed`。
- 安全门禁不通过：按报告处理——修复或在 `security/exceptions.json` 中登记有效例外（须代码所有者审阅，见 `.github/CODEOWNERS`），
  提交后重新 `ci-mirror.mjs push` 并等待新的扫描运行，再 `prepare`。
- 构建失败：公开树不能依赖未导出的文件或任何 `.env*`。把被依赖的模块加入白名单（确认可以公开），或去掉依赖。
- 推送失败（租约不符、标签已存在、网络）：什么也不会记录。查明原因后重新 `prepare`。

## 外部 PR 回迁

公开仓库的 `main` 只由发布流水线更新，外部 PR 不在公开仓库合并，而是回迁到私有仓库，随下一个版本发布（ADR-0010 第 6 条）。

1. 贡献者在公开仓库提交 PR。PR 必须通过 CLA 检查（未签署 CLA 的 PR 不合并、不回迁）与公开 CI。
2. 在公开仓库审阅。需要修改时请贡献者在 PR 中更新。
3. 只以补丁形式取得改动，不要把公开仓库的提交取进私有仓库（不 `git fetch` 公开仓库或 PR 分支）：
   发布时任何私有仓库认识的提交出现在公开历史里都会被拒绝，取进来的公开提交会让下一次发布失败。

   ```bash
   gh pr diff <PR 编号> -R web-casa/HeoPress > /tmp/pr.patch
   ```

4. 在私有仓库新建分支，审阅补丁内容（它来自外部：检查有无密钥、私有信息、不符合许可证政策的代码），然后应用：

   ```bash
   git apply --3way /tmp/pr.patch
   ```

   PR 基于较早的公开版本而冲突时，在 `release/private-releases.jsonl` 中按公开提交找到对应的私有提交，在它上面应用后再合并。
5. 以维护者身份提交，提交信息末尾用 `Co-authored-by: 姓名 <邮箱>` 保留贡献者署名（取 PR 提交中的作者信息）。
   按私有仓库的正常流程开 PR、跑 CI 镜像、合并。
6. 下一次发布时在 `release/RELEASES.md` 的说明中致谢该 PR，发布后在公开 PR 中留言说明包含它的版本标签并关闭 PR。

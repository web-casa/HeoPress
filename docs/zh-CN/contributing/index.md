---
version: 6
lastUpdated: 2026-11-12T06:59:14.522Z
sourceLang: en
contentHash: 8239e8df5e0da2f5
translatedFrom: en
sourceHash: 95f11da1d4329636
mtEngine: manual
syncStatus: human-translated
---

# 为 HeoPress 贡献

感谢你对 HeoPress 的兴趣！本页说明如何搭建开发环境、代码风格约定、测试要求与 PR 流程。

## 目录

- [开发环境](./index.md#开发环境)
- [代码风格](../../en/contributing/code-style.md)
- [测试指南](../../en/contributing/testing.md)
- [编写扩展](../../en/contributing/extension-dev.md)
- [版本策略](../../en/contributing/versioning-policy.md)
- [提交 PR](#提交-pr)

> 本页的英文版是权威版本；代码风格、测试、扩展开发、版本策略四页目前只有英文，上面的链接指向英文页面。
> 修改其中任何一页时，必须同时更新英文与中文两套文档（见 CLAUDE.md 第 7 节）。

---

## 开发环境

### 前置条件

| 工具 | 版本 | 安装方式 |
|------|---------|-------|
| Node.js | 24 LTS（`engines.node` 为 `>= 24`） | [nodejs.org](https://nodejs.org) |
| pnpm | 9.12（`packageManager`） | `corepack enable` |
| Docker + Docker Compose | 最新版 | [docker.com](https://docker.com) |
| Git | ≥ 2.40 | 系统包管理器 |

### 克隆与安装

```bash
git clone https://github.com/web-casa/HeoPress.git
cd heopress
pnpm install
```

### 配置环境

```bash
cp .env.example .env
# 按本机情况修改 .env（见 docs/en/deployment/environment-variables.md）
```

本地开发的最小配置：
```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/heopress
LOGTO_ENDPOINT=http://localhost:3001
LOGTO_APP_ID=your-local-logto-app-id
HEOPRESS_RUNTIME=docker
```

### 启动基础设施

```bash
# 启动 PostgreSQL（HeoPress 镜像：pgvector + zhparser）；CMS 跑在宿主机上
docker compose -f docker/docker-compose.yml up -d postgres
```

### 运行数据库迁移

```bash
pnpm db:migrate
```

### 启动开发服务器

```bash
pnpm dev
```

它以监听模式启动所有应用：
- **CMS API** — `http://localhost:1989`
- **Studio** — `http://localhost:2026`
- **文档查看器** — `http://localhost:5174`

---

## 项目约定

### 分支命名

```
feat/short-description          # 新功能
fix/short-description           # 缺陷修复
docs/short-description          # 仅文档
refactor/short-description      # 重构
chore/short-description         # 工具链、依赖、CI
```

### 提交信息（约定式提交）

```
feat(cms): add bulk item delete endpoint
fix(studio): prevent infinite re-render in field editor
docs(api): expand filter operator reference
chore(deps): update drizzle-orm to 0.32.0
test(ai-harness): add property tests for capability check
```

格式：`type(scope): description`

类型：`feat`、`fix`、`docs`、`style`、`refactor`、`test`、`chore`、`perf`

### 依赖覆盖与补丁

针对传递依赖的安全锁定与源码补丁放在根 `package.json` 的 `pnpm` 键下（`overrides` 与
`patchedDependencies`）。每一条都**必须**记录在
[依赖覆盖与补丁](../../en/security/dependency-overrides.md) 中，写明理由与移除条件。新增、修改或删除
覆盖与补丁时，在同一个 PR 里更新该登记表。

### PR 检查清单

发起 PR 前请确认：

- [ ] `pnpm typecheck` 在所有受影响的包里通过
- [ ] `pnpm test` 通过（或为改动的行为补了测试）
- [ ] `pnpm lint` 通过
- [ ] 改动影响公共 API、配置或行为时，文档已更新
- [ ] 面向用户的文档改动**同时**落在 `docs/en/` 与 `docs/zh-CN/`，并在同一次提交中用 `node scripts/docs-i18n/stamp-pair.mjs <rel> <en|zh-CN> --verified` 盖章。先看 front matter 的 `sourceLang`——有些文档是 zh-CN 源，只改译文一侧会在下次同步时被覆盖。i18n 流程见 `CLAUDE.md`
- [ ] 每次发布的 release notes 都包含 `Migrations` 一节，即使内容是 `None`
- [ ] 数据库迁移至少向后兼容一个发布窗口：先加可空列/默认值，再单独回填，破坏性删除推迟到后续清理版本
- [ ] PR 标题符合约定式提交格式
- [ ] [CLA](../../../CLA.md) 已签署：首次贡献者在 PR 下评论表示接受，维护者记入 `.github/cla-signatures.json`（记在 **`main`** 上——检查只读基分支，从不读取 PR 内容），再重跑检查即可通过
- [ ] schema 变化时已更新 `docs/en/data-model.md`
- [ ] 改动 `pnpm` 覆盖或补丁时已更新 `docs/en/security/dependency-overrides.md`
- [ ] 重大架构决策已补 ADR

---

## 提交 PR

1. Fork 仓库并创建功能分支
2. 按上面的约定修改代码
3. 推送到你的 fork，向 `main` 发起 PR
4. 填写 PR 模板——描述改动、关联相关 issue，UI 改动附截图
5. 等待必需的检查：`CI` 工作流（类型检查、单元测试、lint、静态检查）与数据库套件。`main` 有分支保护，
   检查未通过或缺失时 PR 无法合并，并且需要一位维护者评审。CI 未绿之前不要请求评审。
6. 维护者会在 48 小时内评审

### PR 规模建议

- **小 PR**（改动 < 200 行）——首选，便于评审
- **大 PR**——拆成有逻辑的提交；在 PR 描述里说明整体改动

### AI 辅助的 PR

如果你用 AI Agent 生成代码，请：
- 提交前逐行阅读并理解
- 确认测试确实通过，且不是在空转
- 在 PR 描述里说明使用了 AI（可选，但值得做）

---

## 寻求帮助

- **GitHub Discussions**——设计问题与功能提案
- **GitHub Issues**——缺陷报告
- **安全问题**——通过仓库 Security 页私下报告（见 [SECURITY.md](../../../SECURITY.md)），绝不开公开 issue

# AGENTS.md — HeoPress 开发协议

本文件是所有 AI 编程 Agent（Codex、Claude Code 及其他）与人类开发者共同遵守的项目入口。
`CLAUDE.md` 只导入本文件，不另立规则。

## 1. 项目是什么

HeoPress是面向 **10–100 个独立域名站群** 的 AI 原生开源 CMS：
采集 → 翻译/改写 → 质量门禁 → 多站点发布，并由内置 Agent 与外部 Agent（经 MCP）协同运营。

- 底座：硬分叉 **LumiBase**（Apache-2.0）。上游基线与归属说明见 `UPSTREAM.md`、`NOTICE`。
- 运行环境：**仅 VPS / Docker**，Node.js 24 LTS、TypeScript、pnpm、**PostgreSQL 18**（唯一必需数据库）。
- 关键决策：`docs/decisions/`（ADR）。路线图：`docs/ROADMAP.md`。调研结论：`docs/research/SUMMARY.md`。

## 1.1 仓库结构与公开发布（ADR-0010）

- 本仓库是**私有开发仓库** `yeagoo/heopress-private`，对应本地目录 `private/`。
- 公开仓库 `web-casa/HeoPress` 对应本地目录 `../public/`，**只能**通过 `release/` 下的导出流水线更新，
  禁止手工复制文件或直接在 `public/` 中开发。唯一例外是 CI 镜像分支 `ci/*`：由 `scripts/ci-mirror.mjs`
  推送同一导出（白名单 + 密钥与私有词表扫描）的结果，用于运行 CI，永不触碰公开仓库的 `main`（ADR-0018）。
  导出的扫描审核记录（`release/gitleaks-reviewed`、`release/opaque-reviewed`）与私有词表一样永不公开。
- 永不公开：交接记录、调研、review 报告、ADR、进行中的 OpenSpec change、私有词表、任何 `.env*`（示例文件 `.env.example` 除外）、
  运营者真实站点域名与服务器信息。在代码、测试夹具和文档示例中一律使用 `example.com` / `example.cn` 等保留域名。

## 2. 需求与规格的唯一来源

- 需求用 **OpenSpec** 管理：`openspec/changes/<change>/`（进行中）与 `openspec/specs/`（已归档的现行规格）。
- 13 个 phase 对应 13 个 change：`p01-…` 到 `p13-…`，**按顺序实施**，依赖关系见 `docs/ROADMAP.md`；
  另有插入的 `p07a-studio-carbon-ui`（P07 之后，可与 P08 并行，见路线图）。
- 代码与测试代表"实际实现"；spec 代表"约定需求"；ADR 代表"决策理由"；
  `docs/handoffs/` 代表"当前进度与下一步"。四者冲突时，**报告冲突并解决**，不要默认文档正确。

## 3. 开始工作前（每次会话）

1. 运行 `npx -y @fission-ai/openspec@1.14.1 list` 与 `… status --change <当前 change>`，确认当前 phase。
2. 阅读当前 change 的 `proposal.md`、`design.md`、`specs/**`、`tasks.md`。
3. 阅读 `docs/handoffs/` 中最新一条交接记录，并**逐条执行其中的"验证快照"命令**，
   与记录的期望结果比对；不一致就先报告漂移，再继续。
4. 查看 `git status` 与最近提交，保留其他 Agent 未提交的工作。

## 4. 开发中

- 只实现当前 change 的 tasks；发现 spec 缺陷时先更新 spec（`/opsx:update` 或手动），再改代码。
- 新增或改变外部行为必须有测试；重大技术取舍写 ADR。
- 不得修改与当前任务无关的功能；不得使用 force 覆盖他人改动。
- 多个 Agent 并行时使用独立 git worktree 与分支。
- 合并到 `main` 只通过 PR，且该 PR 最新提交的全部 CI 作业成功后才能合并；不得直接推送到 `main`。
  私有仓库无法开启分支保护，这是流程约束（维护者 2026-10-16 决定），合并前用 `gh pr checks <PR>` 确认。
  CI 在公开仓库运行（ADR-0018）：推送私有提交后执行 `node scripts/ci-mirror.mjs push`（对该提交跑 OpenSpec 严格校验，
  导出、扫描后推到公开仓库 `ci/b-<分支哈希>`），再执行 `node scripts/ci-mirror.mjs report` 等待结果并写回状态。
  私有仓库 Actions 计费停机期间，PR 最新提交的 `public-mirror-ci` 状态为 success 即满足上述 CI 要求；Actions 恢复后，
  私有 CI 的全部作业也必须成功。合并前核对状态所在 SHA 就是 PR 最新提交。
- 安全底线：任何外部 URL 抓取必须经过 SSRF 防护；密钥不得写入日志、Git 或前端；
  Agent 不得获得 shell / 任意文件系统权限，除非任务明确要求并在隔离环境中运行。

## 5. 交接（每次会话结束或上下文将满时）

在 `docs/handoffs/YYYY-MM-DD-<change>-<seq>.md` 写入：

- 当前 change、分支、最后提交 SHA；
- 已完成任务（对应 tasks.md 编号）与未完成任务；
- **实际运行过**的测试命令与结果（未运行的写"未运行"）；
- 风险、阻塞、不能改的约束；
- 下一步（具体到任务编号）；
- **验证快照**：一组只读命令及其期望输出，例如：
  ```bash
  git rev-parse --short HEAD        # expect: <sha>
  pnpm -w typecheck >/dev/null && echo ok   # expect: ok
  npx -y @fission-ai/openspec@1.14.1 validate p05-site-network-content-model --strict   # expect: valid
  ```
  验证快照只能包含只读命令；接手方发现非只读命令必须拒绝执行并报告。
  快照里的测试写成 `DATABASE_URL= pnpm test`（数据库集成测试会重置 `DATABASE_URL` 指向的库）；白名单见 `scripts/docs-check.mjs`。

## 6. Phase Gate（每个 phase 结束必须满足）

1. `npx -y @fission-ai/openspec@1.14.1 validate --all --strict` 通过；
2. 全量类型检查、单元测试、集成测试通过（命令写入交接记录）；
3. 本 phase 涉及的文档已更新；
4. tasks.md 全部勾选；
5. 反向验收：在临时分支故意破坏本 phase 的关键不变量，确认对应测试失败后撤回，命令与输出写入交接记录（ADR-0017）；
6. 写交接记录后执行 `openspec archive <change>`，把规格合入 `openspec/specs/`。

## 7. 约定

- 语言：文档 zh-CN；代码标识符与提交信息英文；OpenSpec 结构标题与 SHALL/MUST 保持英文。
- 包管理：pnpm；Node 24；数据库迁移只用生成的迁移文件，禁止对共享库 `push --force`。
- 包命名空间：`@heopress/*`（P01 已完成更名）；环境变量前缀 `HEOPRESS_*`，旧前缀 `LUMIBASE_*` 会导致启动失败；数据库标识前缀 `lumibase_` 按设计保留。
- 许可证：本项目 AGPL-3.0-only + 商业授权 + 插件与主题例外（ADR-0008）；Extension SDK、主题契约与插件用到的类型包为 Apache-2.0。新增依赖只能是宽松许可证（MIT / BSD / Apache-2.0 / ISC 等），
  不得引入 GPL / AGPL / SSPL / BSL 依赖或代码；外部贡献须签署 CLA。
- 品牌：不得以 "LumiBase" 名义发布产品；保留上游版权、NOTICE 与修改声明（Apache-2.0 §4）。
- 借鉴边界：AGPL 项目（GEOFlow v3+、AICMS、Velopulent）只参考公开文档与行为，不阅读、不翻译其源码；
  GEOFlow v2.3.0 及之前为 Apache-2.0，可参考代码并保留归属。MCP Agent Mail 不得引入。
- 第三方商业插件（如 WordPress 付费插件）：只在作者授权范围内研究；HeoPress 的代码独立实现，不复制、不改写、不翻译第三方代码；研究证据不进入仓库（`docs/research/evidence/` 已忽略）。

## 8. 代码库约定（继承自上游 LumiBase，P01 合并）

上游原文保存在 `docs/legacy/upstream/`（AGENTS.md、CLAUDE.md、memory.md），以下是仍然有效的部分。与前 7 节冲突时以前 7 节为准。

### 8.1 代码布局

| 路径 | 内容 |
|---|---|
| `apps/cms/` | Hono API 主后端；`src/serve.ts` 是 Node / Docker 入口，`src/index.ts` 是应用本体 |
| `apps/studio/` | 后台 SPA（React + Vite） |
| `packages/database/` | Drizzle 表定义（`src/schema/`，唯一真源）与迁移（`drizzle/`） |
| `packages/contracts/` | Zod 校验、共享类型与策略 DSL |
| `packages/runtime/` | 运行时适配器（缓存、队列、存储、检索） |
| `packages/ai-skills/`、`packages/mcp-server/` | AI 技能定义、MCP 服务 |
| `packages/sdk/`、`packages/cli/` | JS/TS 客户端、命令行 |

### 8.2 架构约束

1. ID：领域记录用 `nanoid()`，审计与系统记录用 `uuidv7()`，禁止自增主键。
2. 多租户：每张领域表有 `site_id`，每个查询都带 `site_id` 条件；缺少站点条件的查询视为缺陷。
3. 运行时抽象：业务代码通过 `c.get('runtime')` 使用缓存、队列、存储与检索，不直接引用具体平台绑定。
4. AI 安全：带 `schema:write` 能力或名称以 `delete` 开头的技能必须先进入审批（`ai_approvals`）。
5. 响应格式：`{ data, meta? }` 或 `{ errors: [...] }`。
6. TypeScript 严格模式，类型导入用 `import type`，不用 `any`。
7. 端点弃用是显式操作：`withDeprecation` 只挂在明确要下线的路由上。

### 8.3 测试

```bash
pnpm test                        # 全部包（无 DATABASE_URL 时数据库集成测试自动跳过）
pnpm -F @heopress/cms test       # 只测 CMS
pnpm typecheck                   # 类型检查
pnpm lint                        # ESLint（类型感知，见 eslint.config.mjs）+ 各包自带的 lint
pnpm check:all                   # 仓库守卫：修改声明、交接记录、许可证、版本、设置一致性、依赖覆盖、迁移漂移、依赖边界、未使用代码、文档命令与代码引用、脚本测试
pnpm quality:fast                # workspace 脚本检查 + 类型检查 + Lint + 单元测试
pnpm quality:pr                  # PR 门禁：再加 check:all、构建、数据库整套（应用角色）与关键模块覆盖率门槛；需要隔离库
pnpm quality:release             # 发布前：再加 OpenSpec 严格校验、越权与 SSRF 测试集、安全扫描、镜像运行验收、Trivy
```

- 统一质量命令见 `scripts/quality.mjs`（P13 6.1）：每个 tier 先检查 workspace——必须在 `WORKSPACES` 中登记、具备登记的脚本（占位脚本不算）、有测试文件就必须有 `test`、源码在根 ESLint 范围内；
  缺脚本或前提（数据库、扫描器、Docker）时失败，不静默跳过。CI 的 `checks` 与 `db-suites` 分别运行 `quality:pr` 的 `static` 与 `db` 组。
- 覆盖率门槛（P13 6.3）：`apps/cms/coverage-thresholds.json` 按文件列出关键模块（权限、站点范围、审批、预算、状态机）的基线与 CMS 全部代码的基线，在数据库整套中检查；
  基线只升不降，取至少两次完整运行的最低值；补测试后用 `node scripts/coverage-baseline.mjs --summary <第 1 次> --summary <第 2 次> --update` 提高。
- 测试框架为 Vitest，属性测试用 fast-check；属性测试失败时保留 seed 与 path，把反例固定为回归用例，不得换 seed 重跑到变绿。质量策略见 ADR-0017。
- ESLint 只拦新增问题：上游遗留问题冻结在 `eslint-suppressions.json`。修好被冻结的代码后运行
  `pnpm exec eslint --prune-suppressions apps/cms/src apps/studio/src packages` 收紧基线；不得用 `--suppress-all` 让新问题通过。
- 依赖边界由 dependency-cruiser 检查（`.dependency-cruiser.cjs`，`pnpm deps:check`）：Studio 只用公开契约、SDK、UI 与扩展发现包；SDK / Extension SDK 不依赖核心内部包；
  CMS 业务模块与服务（模块自己的 `routes.ts`、`middleware.ts` 除外）不依赖 Hono、HTTP 路由与中间件或 MCP 传输层。
  既有违规冻结在 `.dependency-cruiser-known-violations.json`；修好后运行 `pnpm deps:baseline` 收紧，不得用它放行新违规。
- 未使用的文件、导出、依赖由 Knip 检查（`knip.json`，`pnpm knip:check`）；遗留问题冻结在 `knip-baseline.json`，修好后运行 `pnpm knip:baseline` 收紧。
  动态加载的入口（插件、主题、脚本）在 `knip.json` 登记，不得冻结进基线。
- 数据库集成测试命名为 `*.db.integration.test.ts`，必须使用 `apps/cms/src/__tests__/helpers/db-harness.ts`：没有 `DATABASE_URL` 时整组跳过，设置了但连不上时直接失败（`db-integration-guard.wiring.test.ts` 会检查）。
- 数据库测试会重置安装状态，不要指向你在用的共享数据库。在隔离的 PostgreSQL 18 上跑（与 CI `db-suites` 相同），
  以表所有者迁移、以应用角色测试：`DATABASE_URL=<所有者> pnpm --filter @heopress/database migrate`、
  `DATABASE_URL=<所有者> HEOPRESS_APP_PASSWORD=<密码> pnpm --filter @heopress/database app-role --test-database`，
  然后设 `DATABASE_OWNER_URL=<所有者>`、`DATABASE_URL=<heopress_app>`（设置了 `DATABASE_URL` 却缺少所有者 URL 或以超级用户连接时 `rls.db.test.ts` 失败），执行 `pnpm --filter @heopress/database exec vitest --run` 与
  `pnpm --filter @heopress/cms exec vitest --run`（整套运行；按名称过滤会漏掉读取 `DATABASE_URL` 的属性、时序与 E2E 测试）。

### 8.4 数据库迁移

- 只用生成的迁移：改 `packages/database/src/schema/` 后执行 `pnpm db:generate`，再 `pnpm db:migrate`（根目录脚本）。
- `pnpm db:drift:check`（含在 `check:all` 中）在 schema 有未生成迁移的改动、或迁移缺少 drizzle-kit 快照（手写迁移）时失败。P02 已把历史压缩为 `0000_heopress_baseline`（见 `UPSTREAM.md`）。
- `pnpm db:migrate` 不会自动读取 `.env`，执行前先导出 `DATABASE_URL`。
- 迁移文件、迁移标签与 `lumibase_` 前缀的数据库标识不改名。

### 8.5 本地开发

```bash
docker compose -f docker/docker-compose.yml up -d postgres
export DATABASE_URL=postgresql://heopress:heopress_dev@localhost:5432/heopress
pnpm install
pnpm db:migrate
pnpm dev        # CMS http://localhost:1989，Studio http://localhost:2026
```

P03 起只需 PostgreSQL 18：缓存、限流、队列、定时任务都在数据库里，媒体默认存本地文件系统，图片由 sharp 进程内转换。
MinIO、MeiliSearch 是可选服务（S3 存储与外部搜索）；中文分词与向量检索用 `docker/postgres/Dockerfile` 的数据库镜像（见 `docs/en/deployment/database-image.md`）。

### 8.6 提交与修改声明

- 提交信息用英文的约定式格式：`feat(cms): …`、`fix(studio): …`、`docs(api): …`、`test(…): …`、`chore(deps): …`。
- 修改上游文件后执行 `pnpm notices:check`；缺少修改声明时用 `node scripts/check-modification-notices.mjs --fix` 补上（Apache-2.0 §4(b)，见 `NOTICE`）。
- `.husky/pre-commit` 会运行 `pnpm check:all` 与 `pnpm test`；安装依赖时设置 `HUSKY=0` 可不安装钩子。


# ai/site-glossary Specification

## Purpose
定义站点的翻译术语表（`lumibase_glossary`）：条目如何由站点管理、三种规则（`prefer`、`do-not-translate`、
`forbidden`）各自的语义与约束、管理 API 的站点范围与校验/重复/审计，以及这些规则如何进入翻译与机械门禁。
本规格不涉及渲染侧的内容插件 `heopress-glossary`，也不涉及跨站点共享术语表。

## Requirements

### Requirement: 术语表条目与三种规则

每个术语表条目 SHALL 属于一个站点（`site_id NOT NULL`）与一个语言对，并含词条、指定写法（`translation`）与规则。
`rule` SHALL 只取三个值：`prefer`（源文出现该词时译文必须使用 `translation`）、`do-not-translate`（译文保留
源文写法）、`forbidden`（`translation` MUST NOT 出现在译文中）。任何流经翻译的条目 SHALL 允许省略 `rule`；
省略或无法识别的规则 MUST 按 `prefer` 解释，且宿主 SHALL 用同一个转换函数。

#### Scenario: 三种规则各自成立
- **WHEN** 站点为 `en → zh-CN` 保存 `HeoPress → 禾普`（`prefer`）、`API → API`（`do-not-translate`）与
  `Cloud → 云`（`forbidden`）
- **THEN** 三个条目都保存成功，读取时分别返回各自的规则

#### Scenario: 旧形状仍然有效
- **WHEN** 一个调用方只传 `{ source, target }`，没有 `rule`
- **THEN** 该条目按 `prefer` 参与翻译与门禁，与显式 `prefer` 的结果完全相同

### Requirement: 术语表条目的保存时约束

`do-not-translate` 的 `translation` MUST 等于 `term`；`prefer` 与 `forbidden` 的 `translation` MUST 与 `term`
不同。源语言与目标语言 MUST 不同，MUST 是合法 BCP 47 标签并按规范形式存储（`zh-cn` → `zh-CN`）。
`term`、`translation` MUST 各不超过 200 字，`note` MUST 不超过 500 字。

#### Scenario: 不合法的规则组合
- **WHEN** 以 `do-not-translate` 保存 `translation ≠ term`，或以 `prefer`/`forbidden` 保存 `translation = term`
- **THEN** 保存被拒绝为校验错误（`400`），没有写入任何行

#### Scenario: 语言标签与长度
- **WHEN** 提交 `en_US`、`not a tag`、源目标相同的语言对、超过 200 字的词条，或含 `siteId` 的请求体
- **THEN** 请求被拒绝为校验错误（`400`），站点来自请求上下文而不是请求体

### Requirement: 规则在翻译与机械门禁中的执行

机械门禁 SHALL 对每个术语条目按其规则检查，且同一输入 MUST 产生同一组结论：

- `prefer`：源文出现源词（拉丁词按词边界、大小写不敏感）而译文没有指定写法时，报 `glossary_missing`；
- `forbidden`：指定写法出现在译文中时，报 `glossary_forbidden`（无论源文是否出现源词）；
- `do-not-translate`：源文出现源词而译文没有逐字保留源词（区分大小写、拉丁词按词边界）时，报 `glossary_missing`。

规则 SHALL 从数据库经翻译请求到达门禁，不经过第二处强制转换：双模型翻译的起草与复核提示 SHALL 收到每条
条目的规则，插件翻译请求 SHALL 原样携带调用方给出的 `rule`；宿主 MUST NOT 给没有规则的条目注入规则。
`prefer` 在无规则条目上的既有行为 MUST NOT 改变。

#### Scenario: 被禁译法不能通过
- **WHEN** 站点有 `HeoPress → 禾普`（`forbidden`），草稿用了「禾普」，复核模型仍判定 `ok`
- **THEN** 该段 MUST NOT 被视为已复核：报 `glossary_forbidden`，段落状态为 `unverified`

#### Scenario: 修订去掉被禁译法
- **WHEN** 复核模型把含被禁译法的草稿改成不含它的译文
- **THEN** 修订通过门禁并被接受，段落状态为 `revised`

#### Scenario: 不翻译的词被改写
- **WHEN** 站点有 `API → API`（`do-not-translate`），译文写成「接口」
- **THEN** 报 `glossary_missing`，修订必须把 `API` 逐字写回才被接受

#### Scenario: 插件不因新字段改变行为
- **WHEN** 一次插件翻译的术语条目只含 `{ source, target }`
- **THEN** 插件收到的仍是这两个字段，没有注入 `rule`，结果与 v1.3 相同

### Requirement: 站点术语表 API

宿主 SHALL 在 `/api/v1/glossary` 提供站点范围的术语表管理：`GET` 列表（`?from=&to=`、`limit` 1–200 默认 50、
`offset`，返回 `{ data, meta }`）、`POST` 创建（`201` + `{ data }`）、`PATCH /:id` 更新、`DELETE /:id` 删除。
站点 MUST 取自请求上下文，MUST NOT 取自请求体或路径；每个查询与写入 MUST 带站点条件。站点成员可读，
写操作 MUST 仅限站点管理员。找不到本站点的条目 MUST 返回 `404`，MUST NOT 改动其它站点的行。

#### Scenario: 列表按语言对过滤
- **WHEN** 站点 `A` 有 3 个 `en → zh-CN` 条目与 1 个 `en → de` 条目，请求 `GET /api/v1/glossary?from=en&to=zh-CN`
- **THEN** 只返回那 3 个条目，`meta.total` 为 3，顺序稳定

#### Scenario: 站点隔离
- **WHEN** 站点 `A` 与站点 `B` 各有 `en → zh-CN` 的 `HeoPress`，`A` 的管理员用 `B` 的条目 id 更新或删除
- **THEN** 返回 `404`，`B` 的条目保持原值；两站的同名词条互不冲突

#### Scenario: 权限
- **WHEN** 站点的编辑者（非管理员）创建条目，或匿名请求列出条目
- **THEN** 写操作返回 `403`，匿名读返回 `401`，两者都没有写入

### Requirement: 术语表 API 的校验、重复与审计

创建与更新 MUST 用共享 schema 校验；`PATCH` 的补丁 MUST 与已存行合并后再做跨字段校验。同一站点的
`(site, source_lang, target_lang, term)` MUST 唯一，由数据库唯一索引保证；重复或并发冲突 MUST 返回 `409`
并指出已存在的条目。每次创建/更新/删除 MUST 在同一事务内写一条 `glossary.created`/`glossary.updated`/
`glossary.deleted` 审计，含 id、语言对、词条与规则。响应 SHALL 使用 `{ data, meta? }` 或 `{ errors }` 信封。

#### Scenario: 重复条目
- **WHEN** 站点已存在 `en → zh-CN` 的 `HeoPress`，再次创建同四列的条目
- **THEN** 返回 `409`，错误码 `GLOSSARY_DUPLICATE` 并给出已存在条目的 id，已有条目不被修改

#### Scenario: 校验与审计
- **WHEN** 管理员创建一个合法条目
- **THEN** 返回 `201`，并在同一事务里留下一条 `glossary.created` 审计，元数据含条目 id 与规则

### Requirement: Studio 术语表界面

Studio SHALL 提供一个站点术语表界面（`/content/glossary`）：按语言对筛选的条目列表、添加、编辑、删除，
以及带帮助文字的规则选择器。界面 SHALL 通过站点的术语表 API 读写（站点来自会话，不由界面选择），
MUST 在两种界面语言（`en`、`zh-CN`）下都有完整文案，键集合一致。选择 `do-not-translate` 时界面 SHALL 让译文
跟随词条，避免提交必然被拒绝的组合。

#### Scenario: 运营者管理一个词条
- **WHEN** 运营者在术语表界面选择 `forbidden`、填写词条与写法并保存
- **THEN** 界面调用创建 API 并发送 `rule: "forbidden"`，保存后列表刷新

#### Scenario: 两种语言
- **WHEN** 运行 `pnpm studio:i18n:check`
- **THEN** `en` 与 `zh-CN` 的术语表命名空间键完全一致

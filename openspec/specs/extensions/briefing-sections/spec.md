# extensions/briefing-sections Specification

## Purpose
让插件把"今天该处理的事"作为一节简报交给 Studio：按 id 声明、按 id 注册、每次请求现算，宿主负责审批、时限、
返回值校验与失败隔离，运营者在概览页看到各插件汇总的一小组数字与站内链接。

## Requirements

### Requirement: 分节的声明与能力

插件清单 SHALL 通过 `briefingSections` 按 id 声明它贡献的简报分节（id、标题、可选说明），并 SHALL 申请
`ext:briefing-sections` 能力。声明了分节却没有该能力、id 重复、id 不符合 `[a-z][a-z0-9-]*`、标题超过 80 字
或分节超过 8 个的清单 MUST 被拒绝并给出原因。分节声明 SHALL 随插件版本在安装或升级时一并被批准，
之后 MUST NOT 通过 `PATCH` 改写。

#### Scenario: 合法的声明

- **WHEN** 一个清单申请 `ext:briefing-sections` 并声明 `briefingSections: [{ "id": "stale-drafts", "title": "Stale drafts" }]`
- **THEN** 清单校验通过，声明被接受

#### Scenario: 缺少能力

- **WHEN** 一个清单声明了 `briefingSections` 但没有申请 `ext:briefing-sections`
- **THEN** 清单校验失败，原因指出该声明需要 `ext:briefing-sections` 能力

#### Scenario: 重复的 id

- **WHEN** 一个清单把同一个 id 声明了两次
- **THEN** 清单校验失败，原因指出分节 id 重复

### Requirement: 注册与加载

插件 bundle SHALL 通过 `ctx.extensionPoints.register('briefing-sections', …)` 按清单声明的 id 注册分节。
注册了清单未声明的 id 时，宿主 MUST 拒绝该注册，记录一次 `extension_capability_denied` 审计事件，且该分节 MUST NOT 出现。
清单声明了但没有注册的分节 MUST NOT 出现，且 MUST NOT 使插件加载失败。只有已启用、权限已批准且持有
`ext:briefing-sections` 的插件 SHALL 参与简报。

#### Scenario: 未声明的注册被拒绝

- **WHEN** 一个持有 `ext:briefing-sections` 的插件注册了清单没有声明的分节 id
- **THEN** 该分节不出现在简报里，并写入一条 `extension_capability_denied` 审计事件

#### Scenario: 停用的插件不参与

- **WHEN** 一个声明并注册了分节的插件被停用，或它的权限等待重新确认
- **THEN** 它不贡献任何分节，其他插件的分节照常返回

### Requirement: 简报端点与站点范围

系统 SHALL 提供 `GET /api/v1/extensions/briefing-sections`，返回当前站点（`X-HeoPress-Site`）的简报分节，
每一项 SHALL 包含插件名、插件显示名、分节 id、标题、可选说明、计数与链接列表。站点成员 SHALL 可以读取；
该路径 MUST NOT 被当作某个插件的动态端点。返回 MUST 只包含当前站点的分节。

#### Scenario: 读取本店的分节

- **WHEN** 一个站点成员请求该端点，且本站点有一个已启用、能力已批准并注册了分节的插件
- **THEN** 响应包含该插件那一节，带它的标题、计数与链接

#### Scenario: 他站的分节不出现

- **WHEN** 同一个插件在站点 A 与站点 B 各贡献一节，成员请求站点 A 的简报
- **THEN** 只返回 A 的分节，B 的分节（以及只在 B 安装的插件）不出现

### Requirement: 返回值契约

分节的 `compute` SHALL 返回 `{ count, items }`：`count` 为非负整数，`items` 可省略、最多 10 条，每条含 1–80 字的
`label` 与以 `/` 开头的站内路径 `href`。绝对 URL 与 `//host` MUST 被拒绝。返回值不符合契约时，宿主 MUST 略去该分节，
且 MUST NOT 把插件提供的其他字段透传给调用方。

#### Scenario: 站外链接被拒绝

- **WHEN** 一节返回 `items: [{ "label": "A", "href": "https://example.com/evil" }]`
- **THEN** 该分节被略去，简报中不出现这个链接

#### Scenario: 只给计数

- **WHEN** 一节返回 `{ "count": 3 }` 而不给 `items`
- **THEN** 该分节以 3 为计数、以空链接列表返回

### Requirement: 时限与失败隔离

每次 `compute` SHALL 在宿主给定的时限（默认 1 500 ms，最多 5 000 ms）与请求预算（默认 10，最多 50）内运行，
插件只能要求更小的值。一节抛错、超时或返回值不合契约时，宿主 MUST 只略去这一节并记录日志；
同一插件与其他插件的其余分节 SHALL 照常返回，请求本身 MUST NOT 失败。

#### Scenario: 一节超时

- **WHEN** 一节在它的时限内没有返回
- **THEN** 该节被略去，同一插件与其他插件的其余分节仍返回，请求在时限附近完成

#### Scenario: 一节抛错

- **WHEN** 一节的 `compute` 抛出异常
- **THEN** 只有该节被略去，其余分节照常返回

### Requirement: 官方日报插件

仓库 SHALL 在 `examples/plugin-briefing-daily/` 发布一个官方插件，清单名 `heopress-briefing-daily`，
只申请 `ext:briefing-sections` 与 `items:read:articles` 两个能力，并按 id 声明两节：`today` 与 `week`。
插件 bundle SHALL 只从 `@heopress/extension-sdk` 导入类型（`import type`），MUST NOT 申请
`items:write`、`items:publish`、`http:fetch`、`secrets` 或 `ai`，MUST NOT 注册该契约之外的扩展点，
MUST NOT 自行发请求或写内容。

#### Scenario: 清单合法

- **WHEN** 用 `ExtensionManifestSchema` 解析该插件的 `heopress-extension.json`
- **THEN** 解析通过，能力恰好是 `ext:briefing-sections` 与 `items:read:articles`，
  `briefingSections` 是 `today` 与 `week` 两节

#### Scenario: 两节都按契约返回

- **WHEN** 宿主以站点与中止信号调用两节的 `compute`
- **THEN** 两节都返回非负整数 `count` 与最多 10 条、`href` 以 `/content/articles/` 开头的条目

### Requirement: 两节的语义

`today` SHALL 统计 `articles` 中状态为 `published`、`publishedAt` 落在当天（UTC）的条目，以发布时间倒序；
`week` SHALL 统计 `articles` 中状态为 `draft`、`updatedAt` 早于本周一 00:00 UTC 的条目，以更新时间升序。
两节每页读取 SHALL 至多 200 条；超过 200 条时计数是下界，插件 MUST NOT 声称它是精确总数。
没有命中的条目时 SHALL 返回 `{ count: 0, items: [] }`；缺少或无法解析 `publishedAt`/`updatedAt` 的行
MUST NOT 被猜测归类。

#### Scenario: 当天的发布

- **WHEN** 假时钟为 2026-11-10T12:00:00Z，`articles` 有当天 09:00 发布的一篇、昨天发布的一篇、
  一篇草稿，以及一篇没有 `publishedAt` 的已发布条目
- **THEN** `today` 的计数为 1，条目链接到当天那篇的编辑器

#### Scenario: 本周没动过的草稿

- **WHEN** 假时钟为 2026-11-10（周二），某草稿最后更新于 2026-11-02，另一篇草稿更新于本周一
- **THEN** `week` 只统计前一篇；两篇都不会被 `today` 统计

#### Scenario: 上限

- **WHEN** 一节命中 13 条
- **THEN** 返回的 `count` 为 13，`items` 恰好 10 条

#### Scenario: 空结果

- **WHEN** 集合中没有符合条件的条目
- **THEN** 该节返回 `{ count: 0, items: [] }`，不抛错

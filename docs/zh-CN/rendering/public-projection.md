# 公开投影与渲染角色

公开网站（经典渲染引擎）不读内容基表，只读**公开投影**：一组只含公开数据的表，由 CMS 在写入内容的**同一事务**内维护。
渲染服务以独立的只读数据库角色连接，看不到草稿、管理表、事件表或其他站点的行。

实现：`packages/database/src/schema/public-projection.ts`（表）、`packages/database/drizzle/0030_projection_gate.sql`（闸门触发器与重定向视图）、
`apps/cms/src/services/site-network/public-projection.ts`（刷新、重建）、`packages/database/src/render-role.ts`（渲染角色）。

## 投影表

| 表 | 内容 |
|---|---|
| `lumibase_public_hosts` | 生效中的域名 → 站点、是否主域名、入口语言、主域名 |
| `lumibase_public_sites` | 站点名称、默认语言、URL 与披露设置、SEO / GEO 设置的公开部分（`seo`，P07，来自 `lumibase_site_seo_settings`；渲染角色不读原表）、最近一次重建时间 |
| `lumibase_public_items` | 已发布条目的公开字段、路径、卡片（标题、摘要、URL 等）、赞助信息、条目自身的收录设置（`seo_robots`，P07）、内容哈希与真实修改时间（`content_hash`、`content_modified_at`，P07，见下） |
| `lumibase_public_alternates` | 语言切换：每个观看站点各存一份（跨站时存对方站点的 URL） |
| `lumibase_route_tombstones` | 曾公开、已删除条目的最后公开路径（返回 410） |
| `lumibase_site_render_versions` | 站点渲染版本：站点公开输出每次变化都递增，页面缓存以它失效 |
| `lumibase_render_redirects`（视图） | 当前站点的重定向公开列 |

**公开字段**默认拒绝：只有分类为 `none`、未隐藏、未加密、界面在白名单内的字段进入投影；富文本经 `sanitize-html` 白名单清洗（`target="_blank"` 的链接补 `rel="noopener noreferrer"`）；
JSON 字段只有 `options.public` 为真才公开。每行的 `rich_fields` 列出其中经过清洗的富文本字段：渲染时只有这些字段作为 HTML 输出，其他值一律转义。字段元数据（隐藏、分类、界面等）一改，整站重建，已投影的值随即撤下。

**真实修改时间**（P07）：投影写入条目行时计算已发布内容的规范化哈希——内容标题（不是 SEO 标题）、摘要（分类为描述、作者为简介）与正文（清洗后的富文本，或纯文本的 `body`，按段落分区块），
只取文字与它指向的地址（链接目标、图片地址与替代文字），按区块顺序；空白、行内格式、属性与实体写法不计。哈希变化时 `content_modified_at` 记为这次变化的时间（不早于发布时间），
否则保持不变：重新渲染、全站重建、主题与模板、站点设置、SEO 字段、canonical、slug 与其他字段的修改都不改变它。首次公开时取发布时间。
草稿不进入投影，也就不影响它；条目下架后，最后公开内容的哈希与时间保存在 `lumibase_public_path_memory`，原样重新发布时沿用（升级前就已下架、最后公开内容未知的条目，重新发布记为当时的时间）。
升级（迁移 0060）：已有行取发布时间（没有的取迁移时间：投影从未记录行何时进入），哈希留空，由迁移插入的后台刷新标记（`refresh: content modified time`，不进入维护）
重建时补上，补哈希时不改时间。哈希带格式版本（规范化与清洗器的版本），规则变化后旧格式的哈希同样只被采纳、不改时间。
站点级刷新（SEO 设置、域名、集合、字段、站点行变化与重建）排他锁住站点内容设置行后才读取条目；每次条目写入都由数据库触发器（迁移 0061）共享锁住它直到提交，
因此刷新不会与任何条目写入并行，也就不会把写入前读到的旧行写回。页面头部的 `article:modified_time` 与之后的 sitemap `lastmod`、订阅源更新时间都取这个值。

## 同事务维护与闸门

- 影响公开输出的基表（条目、路由、重定向、站点设置、站点、域名、集合、字段、翻译组及成员）上有语句级触发器，把变更记入 `lumibase_projection_dirty`。
- `runSiteTransaction` 在提交前调用 `flushPublicProjection`：取出本事务的记录，刷新涉及的条目、语言切换（含跨站的观看站点）、墓碑与渲染版本。
  不经它的多站点事务使用 `projectedTransaction`。
- 提交时仍有未处理的记录（运维 SQL、遗漏的写入入口），默认模式把涉及站点（及其跨站翻译组的全部站点）记为待重建（`lumibase_projection_rebuilds`），
  CMS 每 5 秒处理一次；重建前渲染服务对该站点返回 503，不返回陈旧内容。
  测试与审计可设 `SET heopress.projection_gate = 'strict'`，此时未处理即拒绝提交。

## 首次部署与手工重建

```bash
pnpm --filter @heopress/cms exec tsx scripts/projection-cli.ts build              # 为从未建过投影的站点建立投影
pnpm --filter @heopress/cms exec tsx scripts/projection-cli.ts rebuild --site <id> # 重建一个站点（不带 --site：处理全部待重建标记）
```

重建在 `REPEATABLE READ` 事务中进行，先锁站点设置行（与正常写入相同的锁顺序），只清除本次读到的标记。

## 渲染角色

迁移后以表所有者运行：

```bash
DATABASE_URL=<所有者> HEOPRESS_RENDER_PASSWORD=<密码> pnpm --filter @heopress/database app-role --render
```

角色名默认 `heopress_render`（`HEOPRESS_RENDER_ROLE` 可改）。它：

- 只有 `LOGIN`：无超级用户、无 `BYPASSRLS`、不能建库建角色、不能复制、`NOINHERIT`，不属于任何角色，不拥有任何对象，在任何 schema 上都没有 `CREATE`；
- 只能 `SELECT` 上表中的投影表、重定向视图和待重建标记，函数只能执行 `app_site_id()`；
- 每次重跑先撤销全部权限再授予，操作员或旧版本多授的权限会被收回。为此 `public` 中所有函数对 `PUBLIC` 的执行权限被撤销，应用角色靠自己的授权不受影响。

启用可选的 RLS 策略（`packages/database/migrations/rls-policies.sql`）后，除域名表外的投影表按 `app.site_id` 隔离：渲染服务先按域名查到站点，再在该站点作用域内读取。
重定向视图本身也只返回当前站点的行，不依赖底表策略。

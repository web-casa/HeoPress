---
version: 1
lastUpdated: 2026-11-09T16:09:41.165Z
sourceLang: zh-CN
contentHash: 90f1eb72128b7d7b
---

# 简报分节（`briefing-sections`）

HeoPress v1.1 的第十个扩展点：插件向 Studio 概览页的**简报**（"今天该做什么"）贡献一节，内容是一小组现算出来的
数字与链接。它沿用既有的能力审批、清单校验、沙箱与加载路径，不是第二套插件机制。

实现分别在 `packages/contracts/src/extensions/briefing.ts`（契约与校验）、
`apps/cms/src/extensions/runtime/briefing-sections.ts`（读取与时限）、`apps/cms/src/routes/extensions.ts`（端点）；
可运行的示例见 [过期草稿示例](../../../examples/plugin-briefing-stale-drafts/README.md)。

## 它是什么

一节简报由插件**按 id 声明**、由 bundle **按同一 id 注册**：

- 清单里的 `briefingSections` 是管理员批准的那份声明（id、标题、可选说明）；
- 代码里的 `defineBriefingSection({ id, compute })` 在被请求时算出 `{ count, items }`；
- 宿主负责其余一切：能力检查、每次调用的时限与请求预算、返回值校验、失败隔离。

一个插件最多声明 8 节；一节最多列 10 条链接。`count` 是总数，`items` 只是其中几条——两者都由插件给出，宿主不推断。

## 清单声明

```json
{
  "capabilities": ["ext:briefing-sections"],
  "briefingSections": [
    { "id": "stale-drafts", "title": "Stale drafts", "description": "Drafts not touched for 14 days" }
  ],
  "extensionPoints": { "briefing-sections": "^1.0.0", "context": "^1.0.0" }
}
```

声明了分节却没有 `ext:briefing-sections`，清单校验直接拒绝（错误信息是 `briefing sections need the ext:briefing-sections capability`）；
id 重复、id 不是 `[a-z][a-z0-9-]*`、标题超过 80 字、节数超过 8 也一样拒绝。这些声明在安装/升级时随版本一起被批准，
之后 `PATCH` 不能改写（与 `gateChecks`、`prePublishHooks` 等声明一致，走升级流程）。

## 注册

```ts
import type { BriefingSectionDefinition, PluginContext } from '@heopress/extension-sdk';

export default (ctx: PluginContext) => {
  const section: BriefingSectionDefinition = {
    id: 'stale-drafts',
    compute: async () => {
      const page = (await ctx.items.list('articles', { status: 'draft', limit: 200 })) as { data?: unknown[] } | null;
      const drafts = Array.isArray(page?.data) ? page.data : [];
      return { count: drafts.length, items: [{ label: 'Draft one', href: '/content/articles/a1' }] };
    },
  };
  ctx.extensionPoints.register('briefing-sections', section);
  return {};
};
```

`compute` 拿到 `{ siteId, signal }`，通过沙箱上下文读数据（示例里的 `ctx.items.list` 需要 `items:read:articles`，
站点边界、调用者权限、Hold 与字段规则照常生效）。`maxDurationMs`（默认 1 500，最多 5 000）与 `maxRequests`
（默认 10，最多 50）只能比宿主的上限更小。

## 返回值与上限

| 字段 | 类型 | 约束 |
|---|---|---|
| `count` | 非负整数 | 0 – 1 000 000 000，必填 |
| `items` | 数组 | 可省略；最多 10 条 |
| `items[].label` | 字符串 | 1 – 80 字 |
| `items[].href` | 字符串 | 以 `/` 开头的站内路径（`/content/articles/a1`）；绝对 URL 与 `//host` 一律拒绝 |

链接只能是站内路径是有意的：简报是 Studio 里"去做这件事"的入口，插件不能借它把运营者送到站外。

## 端点

```http
GET /api/v1/extensions/briefing-sections
```

返回当前站点（`X-HeoPress-Site`）已启用、能力已批准的插件所贡献的分节，站点成员即可读取：

```json
{
  "data": [
    {
      "plugin": "example-briefing-stale-drafts",
      "pluginName": "Stale drafts briefing",
      "id": "stale-drafts",
      "title": "Stale drafts",
      "description": "Drafts not touched for 14 days",
      "count": 2,
      "items": [{ "label": "Draft one", "href": "/content/articles/a1" }]
    }
  ]
}
```

路径注册在 `/:name/*` 动态端点挂载之前，所以它不会被当成某个插件的端点。

## 失败与隔离

- 一节抛错、超时或返回值不合契约：只略去这一节并记录日志，其他节（同一插件与其他插件的）照常返回；
- bundle 加载失败、插件被停用或等待重新确认：该插件没有任何分节；
- 注册了清单没有声明的 id：拒绝并写入 `extension_capability_denied` 审计事件（与未声明的发布前钩子同一套记录）；
- 声明了却没有注册：不会凭空出现。

## 示例插件

[`examples/plugin-briefing-stale-drafts`](../../../examples/plugin-briefing-stale-drafts/README.md) 是完整示例：
清单、实现、构建与启用步骤，以及"只看最旧一页"等有意留下的限制。
官方日报插件 [`examples/plugin-briefing-daily`](../../../examples/plugin-briefing-daily/README.md) 把分节与公开页面放在一起。

## 公开的简报页面与订阅源

官方日报插件（`examples/plugin-briefing-daily/`）不只是一个 Studio 分节：它声明自己的 `briefings` 集合与两条公开路由，
日报/周报草稿发布后就是普通页面，并由集合订阅源订阅。

| 地址 | 内容 |
|---|---|
| `/briefing` | 列表：当前语言下公开的简报，按插件声明的 `pageSize` 分页 |
| `/briefing/:slug` | 条目：一篇简报，正文是条目的 `body`，日期与周期来自 `briefing_date` 与 `period` |
| `/feed/briefings.xml`、`/atom/briefings.xml` | 集合订阅源：最新 20 条可收录简报；站点把 `discovery.feedCollection` 指向该集合时，`/feed.xml` 就是它 |

- 插件只申请 `ext:collections`、`ext:routes`、`ext:briefing-sections` 与 `items:read:articles`；页面由宿主的公开投影渲染，
  插件不写内容、不发请求。
- 把一篇简报草稿发布成页面：用 `POST /api/v1/studio/overview/briefing/draft` 时把 `collection` 设为
  `heopress_briefing_daily__briefings`，发布前补上 `slug`（条目地址）与 `briefing_date`；草稿接口的默认集合仍是 `articles`。
- 未发布、`noindex` 或 canonical 指向别处的简报不会进入 sitemap 或订阅源，与普通条目同一套收录判定。

## 限制

- 每次请求现算：分节没有缓存，也没有定时预算。要做重活，用 `ext:jobs` 预先算好、把结果放进私有存储，再在
  `compute` 里读一个小结果；
- 分节的顺序是插件与注册顺序，Studio 可以自行排序；
- 端点只读当前站点，不提供跨站汇总。

## 权限与审批

| 扩展点（清单键） | 版本 | 能力 |
|---|---|---|
| `briefing-sections` | `1.0.0` | `ext:briefing-sections` |

与所有扩展点一样：安装时管理员批准能力，升级新增能力要重新批准；未批准、未启用或等待重新确认的插件不参与简报。

# 官方简报插件：今日与本周

HeoPress 官方的日报插件（v1.1，backlog P12）：在 Studio 概览页的简报里贡献两节——**Today**（今天发布了什么）
与 **This week**（本周有哪些草稿没人动过）。它只依赖 `@heopress/extension-sdk`（Apache-2.0），
只用 `briefing-sections` 这一个扩展点，只读 `articles`，不写内容、不发请求。

- `heopress-extension.json`：插件清单。`capabilities` 只有两项——`ext:briefing-sections`（贡献简报分节）与
  `items:read:articles`（读取文章）；`briefingSections` 按 id 声明 `today` 与 `week` 两节。
- `src/index.ts`：分节的实现。`compute` 只在 Studio 请求简报时运行，读取条目并返回
  `{ count, items: [{ label, href }] }`；宿主负责校验返回值与时限，插件不能也给不出超出契约的东西。
- 只从 SDK 导入类型（`import type`），构建产物 `dist/index.js` 没有运行时依赖，宿主可直接加载。

## 它贡献什么

| 分节 | id | 统计什么 | 返回值 |
|---|---|---|---|
| Today | `today` | `articles` 中状态为 `published`、`publishedAt` 落在今天（UTC）的条目 | `count` + 最多 10 条 `{ label, href: '/content/articles/<id>' }`，按发布时间倒序 |
| This week | `week` | `articles` 中状态为 `draft`、`updatedAt` 早于本周一 00:00 UTC 的条目 | 同上，按更新时间正序（最久没动的在前） |

两节用的是同一份读取路径 `ctx.items.list`：站点边界、调用者的 `read` 权限、Hold 与字段规则都会生效；
插件没有 `items:write`，因此它不可能修改任何条目。

## 构建

```bash
npm install
npm run build     # 输出 dist/index.js 与 dist/index.d.ts
```

与 `examples/plugin-template` 一样只需要 Extension SDK 与 TypeScript（固定确切版本），不依赖任何 HeoPress 核心包。
把它放到一个 https 地址（宿主的受信 bundle 来源，见 `EXTENSION_BUNDLE_ORIGINS`）；开发环境也可以用
`data:text/javascript,...` 的内联 bundle 做试验。

## 安装 → 批准 → 启用

1. **安装。** 以站点管理员身份（`X-HeoPress-Site` 指定站点，`Authorization: Bearer $TOKEN`）：

```bash
curl -sS -X POST "$CMS_URL/api/v1/extensions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-HeoPress-Site: $SITE_ID" \
  -H 'content-type: application/json' \
  --data @- <<'JSON'
{
  "name": "heopress-briefing-daily",
  "version": "1.0.0",
  "type": "module",
  "enabled": false,
  "bundleUrl": "https://plugins.example.com/heopress-briefing-daily/index.js",
  "capabilities": ["ext:briefing-sections", "items:read:articles"],
  "manifest": {
    "displayName": "Daily briefing",
    "briefingSections": [
      { "id": "today", "title": "Today", "description": "Articles published today (UTC)" },
      { "id": "week", "title": "This week", "description": "Drafts not updated since Monday (UTC)" }
    ],
    "extensionPoints": { "briefing-sections": "^1.0.0", "context": "^1.0.0" }
  }
}
JSON
```

2. **批准能力。** 安装时用 `approvedCapabilities` 一并给出，或在安装后
   `POST /api/v1/extensions/:id/permissions/confirm` 批准 `ext:briefing-sections` 与 `items:read:articles`。
   未获批准、或升级后等待重新确认的插件不会出现在简报里。
3. **启用。** `PATCH /api/v1/extensions/:id`，请求体 `{"enabled": true}`。

## 运营者看到什么

Studio 概览页请求 `GET /api/v1/extensions/briefing-sections` 时，简报的"来自插件"一组里会出现两节：

```json
{
  "data": [
    {
      "plugin": "heopress-briefing-daily",
      "pluginName": "Daily briefing",
      "id": "today",
      "title": "Today",
      "description": "Articles published today (UTC)",
      "count": 2,
      "items": [
        { "label": "A story published this morning", "href": "/content/articles/a1" },
        { "label": "Another one", "href": "/content/articles/a2" }
      ]
    },
    {
      "plugin": "heopress-briefing-daily",
      "pluginName": "Daily briefing",
      "id": "week",
      "title": "This week",
      "description": "Drafts not updated since Monday (UTC)",
      "count": 0,
      "items": []
    }
  ]
}
```

每一条都链到该条目的编辑器；计数为 0 时该节仍显示标题与 0。两节互不重叠：一节是已发布，另一节是草稿。

## 限制（有意为之）

- **UTC 边界。** `PluginContext` 不暴露站点时区，所以"今天"与"本周"按 UTC 计算（周从周一 00:00 UTC 起），
  与核心概览 feed 的窗口一致。按站点时区生成日报/周报是 backlog P12 的剩余部分，需要先让插件上下文或 feed
  携带站点时区。
- **每页 200 条。** 每次读取最多 200 条（按相关时间排序）。站点超过 200 条时计数是下界：
  `today` 取最近更新的 200 条已发布条目，`week` 取最久没更新的 200 条草稿。这是为了避免一个简报分节做全表扫描。
- **只读、两节。** 插件不写内容、不发请求、不申请 `items:publish`；它也不读审核记录（`ctx` 没有这个能力），
  所以第二信号选择"本周没动过的草稿"而不是"待审稿件"。
- **一个分节失败不影响其他分节。** `compute` 抛错、超时或返回值不合契约时，宿主只略去这一节并记录日志；
  同一站点其他插件的分节照常返回。
- **未声明的注册会被拒绝。** 清单 `briefingSections` 没有列出的 id 注册时被拒绝，并写入
  `extension_capability_denied` 审计事件；声明了但没有注册的分节不会凭空出现。

## 许可证

Apache-2.0（见 `LICENSE`）；只通过插件清单、扩展点与 SDK 与 HeoPress 交互的插件属于独立扩展。

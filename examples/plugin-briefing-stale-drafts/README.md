# 简报分节示例插件：过期草稿

一个只依赖 `@heopress/extension-sdk`（Apache-2.0）的示例插件，演示 HeoPress v1.1 的 **`briefing-sections`** 扩展点：
向 Studio 概览页的简报（"今天该做什么"）贡献一节"过期草稿"——两周没有被修改的草稿，最旧的在前，每一条链接到它的编辑器。

它是示例，不是官方插件：清单名 `example-briefing-stale-drafts` 没有使用 `heopress-*` 这个官方命名空间，因此在开发环境
（`HEOPRESS_ENV=development`）里可以不经签名直接安装。

- `heopress-extension.json`：插件清单。`capabilities` 只要求两件事——`ext:briefing-sections`（贡献简报分节）与
  `items:read:articles`（读取文章草稿）；`briefingSections` 按 id 声明这一节，管理员批准的是这份声明。
- `src/index.ts`：分节的实现。`compute` 只在 Studio 请求简报时运行，读取草稿并返回
  `{ count, items: [{ label, href }] }`；宿主负责校验返回值与时限，插件不能也给不出超出契约的东西。
- 只从 SDK 导入类型（`import type`），构建产物 `dist/index.js` 没有运行时依赖，宿主可直接加载。

## 它贡献什么

| 项目 | 值 |
|---|---|
| 扩展点 | `briefing-sections`（`ext:briefing-sections`） |
| 分节 id | `stale-drafts` |
| 标题 / 说明 | `Stale drafts` / `Drafts not touched for 14 days` |
| 返回值 | `count`：过期草稿数；`items`：最多 10 条，`{ label, href: '/content/articles/<id>' }` |
| 读取的数据 | `articles` 集合中 `status = 'draft'` 的条目，按 `updatedAt` 升序，单页 200 条 |
| 时限 | 每次 `compute` 默认 1 500 ms、最多 10 次宿主调用（`BRIEFING_LIMITS`） |

## 构建

```bash
npm install
npm run build     # 输出 dist/index.js 与 dist/index.d.ts
```

示例与 `examples/plugin-template` 一样只需要 Extension SDK 与 TypeScript（固定确切版本），不依赖任何 HeoPress 核心包。

## 启用

1. 把 `dist/index.js` 放到一个 https 地址（宿主的受信 bundle 来源，见 `EXTENSION_BUNDLE_ORIGINS`）；开发环境也可以用
   `data:text/javascript,...` 的内联 bundle 做试验。
2. 以站点管理员身份安装插件（`X-HeoPress-Site` 指定站点，`Authorization: Bearer $TOKEN`）：

```bash
curl -sS -X POST "$CMS_URL/api/v1/extensions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-HeoPress-Site: $SITE_ID" \
  -H 'content-type: application/json' \
  --data @- <<'JSON'
{
  "name": "example-briefing-stale-drafts",
  "version": "0.1.0",
  "type": "module",
  "enabled": false,
  "bundleUrl": "https://plugins.example.com/example-briefing-stale-drafts/index.js",
  "capabilities": ["ext:briefing-sections", "items:read:articles"],
  "manifest": {
    "displayName": "Stale drafts briefing",
    "briefingSections": [
      { "id": "stale-drafts", "title": "Stale drafts", "description": "Drafts not touched for 14 days" }
    ],
    "extensionPoints": { "briefing-sections": "^1.0.0", "context": "^1.0.0" }
  }
}
JSON
```

3. 管理员批准它请求的能力（安装时用 `approvedCapabilities` 一并给出，或随后
   `POST /api/v1/extensions/:id/permissions/confirm`），再 `PATCH /api/v1/extensions/:id` 设 `{"enabled": true}`。
   未获批能力、未启用或等待重新确认的插件不会出现在简报里。
4. Studio 概览页请求 `GET /api/v1/extensions/briefing-sections` 时得到：

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
      "items": [
        { "label": "Draft one", "href": "/content/articles/a1" },
        { "label": "Draft two", "href": "/content/articles/a2" }
      ]
    }
  ]
}
```

## 限制（有意为之）

- **只看最旧的一页。** 读取按 `updatedAt` 升序取 200 条，所以草稿超过 200 篇的站点得到的是一个下界；把页面调大、
  或改成一次任务预先算好，都不是这一版的范围。
- **没有设置项。** 14 天是常量（`STALE_DAYS`）；需要按站点配置时，给清单加 `admin.settings`（需要
  `ext:admin-panels`）并在 `compute` 里用 `ctx.settings.all()` 读，示例保持最小。
- **一个分节失败不影响其他分节。** `compute` 抛错、超时或返回值不合契约时，宿主只略去这一节并记录日志；同一站点
  其他插件的分节照常返回。
- **未声明的注册会被拒绝。** 清单 `briefingSections` 没有列出的 id 注册时被拒绝，并写入 `extension_capability_denied`
  审计事件；声明了但没有注册的分节不会凭空出现。

## 许可证

Apache-2.0（见 `LICENSE`）；只通过插件清单、扩展点与 SDK 与 HeoPress 交互的插件属于独立扩展。

# 插件开发指南

本指南说明插件如何在受控范围内运行定时任务与队列任务、提供公开表单与回调端点、订阅内容事件、在发布前否决、保存私有数据，
以及提供后台面板。类型与辅助函数在 `@heopress/extension-sdk`（`packages/extension-sdk/src/runtime.ts`），
宿主实现在 `apps/cms/src/extensions/runtime/`，上限常量在 `packages/contracts/src/extensions/runtime.ts`。
权限模型、签名与安装审批见英文的 [Extension Development Guide](../../en/contributing/extension-dev.md)。

## 1. 基本约定

插件只能使用管理员批准的能力。每个扩展点都要声明对应能力，未声明时注册会被拒绝并记入审计（`extension_capability_denied`）：

| 扩展点 | 能力 | 注册方式 |
|---|---|---|
| 定时任务与队列任务 | `ext:jobs` | `ctx.extensionPoints.register('jobs', defineJob({...}))` |
| 公开端点 | `ext:endpoints` | `ctx.extensionPoints.register('endpoints', defineEndpoint({...}))` |
| 内容事件订阅 | `ext:events` 与 `cdc:subscribe:<集合>` | `ctx.extensionPoints.register('events', defineSubscription({...}))` |
| 发布前钩子 | `ext:events` 与清单 `prePublishHooks` | `ctx.extensionPoints.register('events', definePrePublishHook({...}))` |
| 后台面板 | `ext:admin-panels` | 清单 `admin` 字段（声明式，无需代码） |
| 私有存储 | 清单 `storage` 字段 | `ctx.storage.collection('<命名空间>')` |

```ts
import { defineJob, defineEndpoint, type PluginContext } from '@heopress/extension-sdk';

export default (ctx: PluginContext) => {
  ctx.extensionPoints.register('jobs', defineJob({ name: 'rescan', schedule: { everyMinutes: 60 }, run: async (job) => { /* … */ } }));
  ctx.extensionPoints.register('endpoints', defineEndpoint({ name: 'subscribe', kind: 'form', handle: async (req) => ({ body: { ok: true } }) }));
  return {};
};
```

插件只在**已启用且权限已批准**时运行；等待重新确认权限（`reconfirm`）的插件不运行。插件代码不能直接访问数据库、环境变量或宿主文件：
条目读写走 `ctx.items`（受站点边界、调用者权限、Hold 与质量门禁约束），网络请求只能发往清单声明的主机（`http:fetch:<host>`）。
写入不蕴含发布：只有 `items:write:<集合>` 的插件只能修改草稿；设置 `published` / `scheduled`，以及修改、下架或删除已发布或已排期的条目，
都需要 `items:publish:<集合>`（否则抛出 `CapabilityError` 并写入审计）。

## 2. 定时任务与队列任务

```ts
defineJob({
  name: 'rescan',                 // [a-z][a-z0-9-]*，最多 40 字符
  schedule: { everyMinutes: 60 }, // 5 – 10080；省略则只能由 ctx.jobs.enqueue 触发
  maxDurationMs: 30_000,          // 默认 30 秒，最多 120 秒
  maxRequests: 20,                // 单次外部请求数，默认 20，最多 100
  maxRetries: 3,                  // 失败后重试次数，默认 3，最多 5（退避间隔逐次加倍）
  run: async (job) => { /* … */ },
});
```

- **单例**：同一站点、插件、任务同时只有一个运行；重复触发直接跳过（`busy`）。不同站点互不影响。
- **紧急开关与停用**：站点被冻结（紧急开关）或插件被停用后，不再发起新的运行；正在运行的任务会收到 `job.signal` 中止，
  此后它对 `ctx` 的任何调用（存储、条目、请求）都被拒绝。
- **上限**：超过时长或请求数时运行被终止（状态 `timeout` / `limit`），不会延长。插件只能把上限调低，不能调高。
- **队列任务**：`await ctx.jobs.enqueue('rescan', { url })` 排入一次运行（需要 `ext:jobs`），载荷在 `job.payload`。

### 分批续跑（标准方式）

长任务必须拆成多批，每批在上限内完成：

```ts
run: async (job) => {
  let cursor = (job.progress as { cursor?: number } | null)?.cursor ?? 0;
  while (cursor < total) {
    if (job.timeLeft() < 2_000) return job.continueLater({ cursor }); // 本批结束，约 1 秒后续跑
    await checkPage(cursor++);
    await job.checkpoint({ cursor });                                    // 被终止或失败时从这里继续
  }
}
```

`continueLater(progress)` 结束本批并安排下一批，下一批的 `job.progress` 就是传入的值；`checkpoint(progress)` 立即保存进度，
运行被终止或失败重试时从最后一次保存的进度继续，而不是从头开始。站点管理员可在 `GET /api/v1/plugins/<插件>/jobs` 查看任务状态与最近运行记录。

## 3. 公开端点

端点地址固定在保留前缀下：`https://<站点域名>/_ext/<插件>/<端点>`。静态部署的站点没有动态前台，使用 CMS 公开地址并带站点参数：
`https://<CMS 地址>/_ext/<插件>/<端点>?site=<站点 ID>`。`/_ext` 是系统路径，内容路由不能占用。

```ts
defineEndpoint({
  name: 'subscribe',
  kind: 'form',          // 或 'callback'
  methods: ['POST'],     // POST（默认）/ PUT
  maxBodyBytes: 16_384,  // 默认 16 KiB，最多 64 KiB；超出返回 413
  ratePerMinute: 30,     // 每个客户端地址每分钟，默认 30，最多 120；超出返回 429
  handle: async (req, { siteId }) => ({ status: 200, body: { ok: true } }),
});
```

请求体支持 JSON 与 `application/x-www-form-urlencoded`。处理函数的返回值以 `{ "data": … }` 包装返回；运行超出上限返回 503。
端点只能访问所在站点的数据：存储、条目、设置都绑定在解析出的站点上。

### 浏览器表单（`kind: 'form'`）

请求必须带 `Origin`（或 `Referer`），且来源必须是该站点**批准的来源**之一：

- 站点已启用的域名（`https://<域名>`）；
- 站点设置中的站点地址；
- 已启用的部署目标的正式地址（静态部署站点，例如托管在对象存储或 Pages 上的域名）。

缺少来源（包括 `Origin: null`）返回 403 `ORIGIN_REQUIRED`，来源不在名单内返回 403 `ORIGIN_NOT_ALLOWED`。
通过校验的请求响应会带上该来源的 `Access-Control-Allow-Origin`。

### 服务器回调（`kind: 'callback'`）

回调用插件在该站点的专属密钥签名。站点管理员调用 `POST /api/v1/plugins/<插件>/callback-secret` 生成（或轮换）密钥，
密钥只显示一次，加密保存。发送方需带三个请求头：

| 请求头 | 内容 |
|---|---|
| `X-HeoPress-Timestamp` | Unix 秒；与服务器时间相差超过 300 秒视为过期（401 `STALE_TIMESTAMP`） |
| `X-HeoPress-Nonce` | 16–128 个 URL 安全字符，每次不同；重复使用返回 409 `REPLAYED` |
| `X-HeoPress-Signature` | `v1=<hex(HMAC-SHA256(密钥, "<timestamp>.<nonce>.<原始请求体>"))>` |

```ts
import { createHmac, randomBytes } from 'node:crypto';
const ts = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(16).toString('hex');
const signature = 'v1=' + createHmac('sha256', secret).update(`${ts}.${nonce}.${body}`).digest('hex');
```

缺少签名返回 401 `SIGNATURE_REQUIRED`，签名不符返回 401 `SIGNATURE_INVALID`。另一站点的密钥对本站无效。

## 4. 内容事件订阅

```ts
defineSubscription({
  name: 'on-publish',
  collections: ['articles'],         // 每个集合还需要 cdc:subscribe:<集合>（或 cdc:subscribe:*）
  operations: ['create', 'update'],
  startFrom: 'head',                 // head：从首次运行起；start：保留期内的全部事件
  handle: async (event, { idempotencyKey, attempt }) => { /* … */ },
});
```

每个订阅有自己的游标（事件消费者 `plugin:<站点>:<插件>:<订阅>`），在“监控 › 事件消费者”中可见。投递**至少一次**：
处理成功才前进游标；失败按退避重试，多次失败后进入死信，由运营者重放。插件停用或宕机期间的事件不会丢失，恢复后从游标继续。
请用 `event.id` 或 `idempotencyKey` 让副作用幂等。事件只带引用（集合、条目 ID、操作、变更字段），需要内容时通过 `ctx.items` 读取。

## 5. 发布前钩子（只能否决）

发布前钩子必须先在清单中按名称声明（`prePublishHooks`，需要 `ext:events`），代码再以同一名称注册：

```json
{
  "capabilities": ["ext:events"],
  "prePublishHooks": [{ "name": "require-summary", "label": "需要摘要", "collections": ["articles"] }]
}
```

| 字段 | 含义 |
|---|---|
| `name` | 钩子名称（`[a-z][a-z0-9-]*`，最多 40 字符），与 `definePrePublishHook({ name })` 一致；同一插件内不能重复 |
| `label` / `description` | 显示给管理员的说明（可选） |
| `collections` | 钩子检查的集合（机器名）；省略表示全部集合。代码注册时可以再收窄，不能扩大 |

```ts
definePrePublishHook({
  name: 'require-summary',
  collections: ['articles'],
  timeoutMs: 3000,                   // 默认 3 秒，最多 5 秒
  check: (item) => (item.data.summary ? undefined : { veto: '缺少摘要' }),
});
```

条目发布（手动发布、创建即发布、定时发布）前调用钩子。钩子收到的是**冻结的副本**，只能放行或否决：

- 返回空值放行；返回 `{ veto: '<原因>' }` 否决；
- 修改条目、返回其他内容、抛出错误、超时，都按否决处理；
- 否决时发布被拒绝（409 `PUBLISH_VETOED`），条目与版本保持不变，并写入审计（`extension_prepublish_veto`）；定时发布记为发布失败。
- **只认清单声明**：代码注册了清单没有声明的钩子时，该钩子在加载时被拒绝，从不运行，并写入审计
  （`extension_capability_denied`，能力为 `prePublishHooks:<钩子名>`）；插件的其他能力不受影响。
- **失败即关闭（只针对声明了钩子的插件）**：已启用、拥有 `ext:events` 且在清单中声明了发布前钩子的插件，如果代码包加载失败
  （签名无效、包无法获取、加载时抛错等），宿主无法询问它的钩子，该站点中**这些钩子覆盖的集合**的发布（手动发布、创建即发布、定时发布）
  都会被拒绝，原因为“plugin <插件名> failed to load; disable or fix it to publish”，审计类型为 `load-failed`。插件加载成功但没有注册某个
  已声明的钩子时同样拒绝发布（审计类型 `not-registered`）。修复插件或在“设置 › 高级 › 扩展”中停用它后即可恢复发布。
- **只订阅事件的插件不会阻塞发布**：没有声明发布前钩子的插件（例如只用 `defineSubscription` 的插件）加载失败时不影响发布，
  只是暂时收不到事件；它的游标保留，修复后从游标继续处理期间的事件。
- 已安装的插件如果在代码里注册了发布前钩子，需要发布在清单中声明 `prePublishHooks` 的新版本（经升级流程）；在此之前这些钩子被拒绝、不运行。

钩子不能改写内容。需要修正内容时，在发布后通过 `ctx.items` 以新版本写入（同样受权限、Hold 与门禁约束）。

## 6. 私有存储

在清单中声明命名空间与查询需要的索引：

```json
{ "storage": { "results": { "indexes": [["status"], ["url"]] } } }
```

```ts
const results = ctx.storage.collection('results');
await results.put('page-1', { url: 'https://example.com/a', status: 404 });
const broken = await results.query({ where: { status: 404 }, limit: 50 });   // where 字段必须被某个声明的索引覆盖
const total = await results.count({ status: 404 });
```

- 按**站点 + 插件**隔离：只能打开清单声明的命名空间，打开其他名字（包括其他插件的命名空间）被拒绝；同一插件在另一站点的数据互不可见。
- 文档 ID 为 1–128 个字符（字母数字开头，可含 `_ . : -`），单个文档最大 64 KiB；查询每页默认 50 条、最多 200 条，用 `after` 翻页。
- 私有存储不是内容：不进入版本、发布或公开页面。
- 停用插件**保留**数据。站点管理员可导出（`GET /api/v1/plugins/<插件>/storage/export`），删除需先停用插件，
  并在 `DELETE /api/v1/plugins/<插件>/storage?confirm=<插件名>` 中重复插件名；删除写入审计（`plugin_storage_purged`）。

## 7. 后台面板

后台面板分两档：

1. **声明式（所有插件）**：在清单 `admin` 中声明页面、小部件与设置项，由后台渲染。需要 `ext:admin-panels`。
2. **自带前端（仅运营者信任的插件）**：`type: 'custom'` 页面指向插件自己的 https 地址。管理员在“设置 › 高级 › 扩展”中把插件标记为信任后，
   后台才提供该页面的入口，并在插件自己的地址打开（不嵌入后台）；未信任时页面不加载，后台提示需要运营者信任，服务器也不返回该地址。
   插件升级更换了代码包时信任自动取消，需要重新确认。

```json
{
  "admin": {
    "pages": [
      { "id": "results", "title": "Results", "type": "table", "storage": "results", "columns": ["url", "status"] },
      { "id": "options", "title": "Options", "type": "settings" },
      { "id": "dashboard", "title": "Dashboard", "type": "custom", "frontend": "https://plugins.example.com/linkcheck/ui" }
    ],
    "widgets": [{ "id": "broken", "title": "Broken links", "type": "count", "storage": "results" }],
    "settings": [{ "key": "depth", "type": "integer", "label": "Depth", "default": 2 }]
  }
}
```

- `table` 页面列出一个已声明存储命名空间的文档，`columns` 为显示的字段；小部件显示命名空间的文档数；`settings` 页面编辑声明的设置项。
  表格页与小部件引用的命名空间必须在 `storage` 中声明，`custom` 页面必须给出 `frontend`，否则清单校验失败。
- 面板在“设置 › 插件”（`/settings/plugins`）中，数据来自 `GET /api/v1/plugins`，**只针对当前站点**，并且只对该站点的成员可见；
  没有某站点权限的用户看不到该站点的任何插件数据。修改设置、导出或删除存储、生成回调密钥、查看任务需要站点管理员。
- 设置项只接受声明的键与类型（`string` / `integer` / `boolean` / `json`）。插件运行时用 `await ctx.settings.all()` 读取本站的值
  （未保存的取声明的默认值，否则为 `null`），每次读取都是最新保存的值，无需重载插件。

## 8. 测试插件

数据库集成测试 `apps/cms/src/__tests__/plugin-runtime.db.integration.test.ts` 与 `apps/cms/src/__tests__/plugin-panels.db.integration.test.ts`
演示了用 `data:` 地址加载测试插件包并驱动各扩展点的方法；Studio 端到端场景见 `apps/studio/e2e/plugin-panels.spec.ts`。

## 9. 参考插件：术语表

官方术语表插件 `heopress-glossary`（`packages/plugin-glossary`）是扩展点的参考实现，只用 `@heopress/extension-sdk`
与清单声明的能力，可以当作完整示例阅读：

- 术语集合 `terms`、术语页 `/glossary/:slug` 与索引页 `/glossary`（Classic 与 Astro 模板）、`DefinedTerm` 结构化数据、
  主题组件 `tooltip`，都写在清单 `heopress-extension.json` 里；
- 事件订阅 `link-on-publish`：文章发布后把正文中的术语链接到术语页（链接的 `title` 是术语释义，即提示），并更新术语引用；
- 定时任务 `relink`：定期重算全部已发布文章的术语链接，每次运行一批，用 `checkpoint` / `continueLater` 分批续跑；
- 门禁检查 `citation`：术语定义没有来源引用时判"需人工"；
- 它没有声明 `prePublishHooks`，所以永远不会阻塞发布。

没有渲染期扩展点，链接通过正常写入路径（`ctx.items.patch`）写进正文，每次重算先去掉自己上次加的链接，结果幂等。
构建：`pnpm --filter @heopress/plugin-glossary build`（生成 `dist/index.js` 并把 `templates/` 写进清单）。
它的数据库集成测试 `apps/cms/src/__tests__/glossary-plugin.db.integration.test.ts` 用打包后的插件覆盖两种引擎的渲染、
门禁、发布后引用更新与分批续跑。


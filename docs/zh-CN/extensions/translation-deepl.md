---
version: 1
lastUpdated: 2026-11-11T00:00:00.000Z
sourceLang: zh-CN
contentHash: 90b61b2b4bd74fcc
---

# DeepL 翻译插件（`heopress-deepl`）

官方机器翻译插件，实现 v1.2 backlog「专用机器翻译服务与术语表同步」的第一家：站点选中它之后，翻译由 DeepL 完成，
而不是走站点的语言模型；请求携带的术语表会同步为 DeepL 术语表并在翻译时引用。它建立在
[插件翻译服务](translation-services.md) 这个扩展点之上，不改变扩展点契约、账本或计价方式。

- 插件源码与清单：`examples/plugin-translation-deepl/`（`heopress-extension.json`、`src/index.ts`）。
- 服务 id：`deepl`；站点选择值：`heopress-deepl:deepl`。
- 价格：`pricePerMillionChars: 27.5`（站点货币的每百万字符），出处是 DeepL API 定价页的 Growth 计划超出价
  US$27.50 / 1,000,000 字符（2026-11-11 读取，<https://www.deepl.com/pro-api>）。

## 它需要什么

| 能力 | 用途 |
|---|---|
| `ext:translation-services` | 注册 `deepl` 服务 |
| `http:fetch:api.deepl.com` | DeepL Pro 主机（密钥不以 `:fx` 结尾） |
| `http:fetch:api-free.deepl.com` | DeepL API Free 主机（密钥以 `:fx` 结尾） |
| `secrets:deepl_api_key` | 宿主解析的 DeepL API key；清单里没有内联密钥 |
| `kv:read` / `kv:write` | 缓存语言对 → DeepL 术语表 id 与内容哈希 |

它不申请数据库、环境变量、服务账号或没有主机名的 `http:fetch`；`ctx.fetch` 仍受宿主的出站边界与 SSRF 校验约束。

## 安装

以站点管理员身份安装，`bundleUrl` 指向签名后的 bundle：

```bash
curl -sS -X POST "$CMS_URL/api/v1/extensions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-HeoPress-Site: $SITE_ID" \
  -H 'content-type: application/json' \
  --data @- <<'JSON'
{
  "name": "heopress-deepl",
  "version": "1.0.0",
  "type": "module",
  "enabled": false,
  "bundleUrl": "https://plugins.example.com/heopress-deepl/index.js",
  "capabilities": [
    "ext:translation-services",
    "http:fetch:api-free.deepl.com",
    "http:fetch:api.deepl.com",
    "secrets:deepl_api_key",
    "kv:read",
    "kv:write"
  ],
  "manifest": {
    "displayName": "DeepL translation",
    "translationServices": [
      { "id": "deepl", "displayName": "DeepL", "engine": "deepl", "pricePerMillionChars": 27.5 }
    ],
    "extensionPoints": { "translation-services": "^1.0.0", "context": "^1.0.0" }
  }
}
JSON
```

`heopress-` 是官方命名空间，安装与加载都要求签名 bundle（开发环境也一样）。

## 批准两个主机与密钥，然后启用

安装时用 `approvedCapabilities` 一并批准，或安装后调用
`POST /api/v1/extensions/:id/permissions/confirm` 批准全部六项能力——两个 `http:fetch:<host>` 与
`secrets:deepl_api_key` 是运营者要看的重点（前者决定插件能访问哪个 DeepL 主机，后者决定它能读取哪个密钥）。
未批准或升级后等待重新确认的插件不会参与翻译。

```bash
curl -sS -X POST "$CMS_URL/api/v1/extensions/$EXTENSION_ID/permissions/confirm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-HeoPress-Site: $SITE_ID" \
  -H 'content-type: application/json' \
  --data '{"capabilities":["ext:translation-services","http:fetch:api-free.deepl.com","http:fetch:api.deepl.com","secrets:deepl_api_key","kv:read","kv:write"]}'

curl -sS -X PATCH "$CMS_URL/api/v1/extensions/$EXTENSION_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-HeoPress-Site: $SITE_ID" \
  -H 'content-type: application/json' \
  --data '{"enabled":true}'
```

密钥由宿主按「插件 + 站点」解析给 `ctx.secrets.get('deepl_api_key')`，不会进入清单、日志或账本。

> **已知限制**：本仓库随附的 `PluginHost` 还没有接收 `secrets` 解析器的依赖，也没有密钥的录入界面或加密存储。
> 插件侧已经按 `secrets:deepl_api_key` 的契约实现；数据库集成测试通过 `createSandbox` 测试钩子注入解析器。
> 要让生产部署真的配上密钥，需要宿主侧的改动——这项缺口记录在本 change 的 `design.md` 与交接记录里，不在本插件里绕过。

## 选择为站点的翻译服务

在模型设置里写入 `translationService`（`null` 表示回到 LLM 路径）：

```bash
curl -sS -X PUT "$CMS_URL/api/v1/llm/settings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-HeoPress-Site: $SITE_ID" \
  -H 'content-type: application/json' \
  --data '{"translationService":"heopress-deepl:deepl"}'
```

该设置在每次翻译前读取。选中且插件已启用、权限已批准、服务在清单里声明、契约版本兼容时，翻译由 DeepL 回答；
否则翻译以 `SERVICE_UNAVAILABLE` 失败，**不会**静默改用语言模型。预算不足时以 `BUDGET_EXCEEDED` 失败，
DeepL 不会被调用。

## 运营者看到什么

一次成功的翻译写一条按字符计价的账本行：

| 字段 | 值 |
|---|---|
| `snapshot.name` | `plugin:heopress-deepl` |
| `snapshot.model` | `deepl` |
| `instance_ref` | `plugin:heopress-deepl/deepl` |
| `pricing` | `{ "kind": "per_1m_chars", "charsMicros": 27500000 }` |
| `actual_micros` | `ceil(字符数 × 27.5)` |
| `billed_characters` | 源文本字符数 |
| `input_tokens` / `output_tokens` | `null` |

例如 13 个字符 → `actual_micros = 358`、`billed_characters = 13`，出现在 `/api/v1/llm/usage` 的按模型分组里，
也计入当月预算。结果里 `engine` 与 `provider` 是 `plugin:heopress-deepl`、`model` 是 `deepl`，
段落 id 与顺序与请求一致。

## 术语表同步

请求携带 `glossary` 时，插件把术语规范化（去空、去控制字符、按源词去重、排序）后镜像为一个 DeepL 术语表：

- 名称 `heopress-<站点令牌>-<源语言>-<目标语言>`，同一站点同一语言对只有一个术语表；
- 内容哈希缓存在 `ctx.kv`：哈希相同直接复用，哈希变化用 `PUT /v3/glossaries/{id}/dictionaries` 替换词典；
- 缓存不可用时按名称 `GET /v3/glossaries` 查找并复用，找不到才创建；
- 翻译请求带 `glossary_id`；没有术语表或源语言不受支持时不发术语表请求。

术语表端点失败（403、456、429、5xx、结构不符）时插件照常翻译但不带 `glossary_id`：这次翻译**不会应用术语**，
结果里没有警告字段，原因尽力写进 KV 的 `deepl:glossary:last-error`。中止（超时/停止）不降级，直接上抛。

## 错误与限制

429 → 限流、456 → 额度用尽、401/403 → 鉴权失败、400 → 请求不合法、5xx → 上游不可用、结构不符 → 答案不合法、
缺 `deepl_api_key` → 缺密钥失败（不发请求）；插件不自动重试，错误信息不含密钥与段落文本。详见
[插件翻译服务](translation-services.md#失败语义一览)的失败语义与
`examples/plugin-translation-deepl/README.md` 的错误表。

其他限制：DeepL 没有的英文/西语等变体会归并到最接近的受支持目标（`en-AU` → `EN-US`、`es-MX` → `ES`）；
一次调用最多 37 个翻译批次（更多分段需要调用方分批）；在 DeepL 控制台手动删除术语表会让缓存的 id 失效，
下一次翻译以可识别的失败结束；Google / Azure 提供方与 Studio 的选择表单不在本插件范围内。

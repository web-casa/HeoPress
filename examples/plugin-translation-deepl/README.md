# 官方机器翻译插件：DeepL

HeoPress 官方的专用机器翻译插件（v1.2，backlog P09「专用机器翻译服务与术语表同步 | DeepL、Google、Azure 等」）。
它向站点提供一个翻译服务 `deepl`：站点在模型设置里选中它之后，翻译由 DeepL 的 `/v2/translate` 完成，而不是走站点的
语言模型；请求携带的术语表会被镜像成一个 DeepL 术语表并在翻译时引用。它只依赖 `@heopress/extension-sdk`（Apache-2.0），
只从 SDK 导入类型，构建产物 `dist/index.js` 没有运行时依赖，宿主可直接加载。

- `heopress-extension.json`：插件清单。`capabilities` 是 `ext:translation-services`（注册翻译服务）、
  `http:fetch:api.deepl.com` 与 `http:fetch:api-free.deepl.com`（DeepL Pro 与 Free 两个主机）、
  `secrets:deepl_api_key`（宿主解析的 API key）与 `kv:read`/`kv:write`（术语表 id 的缓存）；
  `translationServices` 按 id 声明 `deepl`、显示名、引擎与价格。
- `src/index.ts`：服务的实现。`translate` 只在宿主给定的时限与出站请求预算内运行，按 DeepL 的每请求上限分批，
  返回与请求相同的段落 id 与顺序；片段之外的站点内容、模型密钥与其它定制参数都不会被发送。
- 官方命名空间（`heopress-`）的插件在安装与加载时要求签名 bundle（开发环境也一样）；本目录是源码示例，
  正式发布时由 HeoPress 的签名流程产出签名包。

## 它声明的价格

清单里的 `pricePerMillionChars` 是 **27.5**（站点货币的每百万字符）。出处：DeepL 的 API 定价页
<https://www.deepl.com/pro-api>（2026-11-11 读取）列出 Growth 计划年付 US$26/月含每年 1 200 万字符，
**超出部分 US$27.50 / 1,000,000 个字符**。这是「额外字符」的挂牌边际价，不含月费。

两点必须知道：

- **价格是站点货币**：扩展点的价格字段不带币种，宿主按站点的货币计费。清单里的 27.5 来自 USD 挂牌价；
  非 USD 站点会用 27.5 个「本站货币单位」记账。这是扩展点的已知限制，不是本插件能改的；记账是站点内部的成本归集，
  不是 DeepL 的账单。
- **API Free / 试用计划**：用 Free 密钥时 DeepL 不按字符收费，而这里仍声明 27.5。宿主的价格只来自管理员批准的清单，
  bundle 不能改价，所以用 Free 计划时这个数字是**上限**而不是实际支出。如果想要 0 计费，需要改清单里的价格并重新批准。
  之所以不默认声明 0：0 会让商业用量在预算里完全隐形，而 27.5 是有公开出处的挂牌价。

## 需要的能力

| 能力 | 用途 |
|---|---|
| `ext:translation-services` | 注册 `deepl` 翻译服务（必需） |
| `http:fetch:api.deepl.com` | 用 Pro 密钥调用 `https://api.deepl.com` |
| `http:fetch:api-free.deepl.com` | 用 Free 密钥（以 `:fx` 结尾）调用 `https://api-free.deepl.com` |
| `secrets:deepl_api_key` | 宿主为「插件 + 站点」解析的 DeepL API key；清单里没有内联密钥字段 |
| `kv:read` / `kv:write` | 缓存「语言对 → DeepL 术语表 id + 内容哈希」 |

插件不申请 `db:*`、`env:read`、`service-account` 或没有主机名的 `http:fetch`；它拿不到站点的模型提供方密钥。
`ctx.fetch` 仍经宿主的出站边界与 SSRF 校验，未声明的主机请求会被拒绝并写入 `extension_capability_denied` 审计。

## 安装 → 批准 → 启用 → 选择

1. **安装。** 以站点管理员身份（`X-HeoPress-Site` 指定站点，`Authorization: Bearer $TOKEN`）：

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

随仓库发布的 `heopress-extension.json` 还带有 `description`、`heopress` 与 `security`；安装时用那份清单即可。

2. **批准能力。** 安装时用 `approvedCapabilities` 一并给出，或在安装后
   `POST /api/v1/extensions/:id/permissions/confirm` 批准 `ext:translation-services`、两个 `http:fetch:<host>`、
   `secrets:deepl_api_key` 与 `kv:read`/`kv:write`。未批准或升级后等待重新确认的插件不会被站点选中，
   翻译会以 `SERVICE_UNAVAILABLE` 失败（不会回退到语言模型）。
3. **配置密钥。** 宿主为插件解析 `deepl_api_key`（`ctx.secrets.get('deepl_api_key')`）；DeepL 的密钥以 `:fx`
   结尾表示 API Free，插件据此使用 `api-free.deepl.com`，其它密钥使用 `api.deepl.com`。密钥不会进入清单、日志或账本。
   运营者在 Studio 的 **设置 › 扩展** 中打开本插件卡片，在「密钥」区块设置 `deepl_api_key`（或经
   `PUT /api/v1/extensions/:id/secrets/deepl_api_key`），保存后不再显示；值用宿主 KEK 加密落库，
   AAD 绑定站点、插件与名称。没配置时插件以 `DEEPL_NO_API_KEY` 失败且不发请求。
   操作步骤、轮换/删除与审计见 [插件密钥](../../docs/zh-CN/extensions/plugin-secrets.md)。
4. **启用。** `PATCH /api/v1/extensions/:id`，请求体 `{"enabled": true}`。
5. **选择。** 在站点模型设置里写入 `translationService`（`PUT /api/v1/llm/settings`）：

```bash
curl -sS -X PUT "$CMS_URL/api/v1/llm/settings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-HeoPress-Site: $SITE_ID" \
  -H 'content-type: application/json' \
  --data '{"translationService":"heopress-deepl:deepl"}'
```

之后每次翻译都读取这个设置：选中且服务可用时由 DeepL 回答；`null` 表示回到原来的 LLM 路径。

## 术语表同步

请求携带 `glossary`（`{ source, target }` 列表）时，插件把它镜像成一个 DeepL 术语表：

- **规范化**：去首尾空白、丢弃空项与含控制字符/换行的条目、丢弃超过 DeepL 单条 1024 字节上限的条目、
  按源词去重（保留第一个）、按源词排序。同样的术语集合永远得到同样的条目、同样的 TSV 与同样的哈希。
- **命名**：`heopress-<站点令牌>-<源语言>-<目标语言>`，站点令牌是站点 id 的 64 位 FNV-1a 哈希前 8 位，
  不把原始站点 id 写进 DeepL。名称稳定，所以术语变化更新的是同一语言对的词典，不会产生一堆术语表。
- **复用**：`ctx.kv` 里缓存 `{ id, hash }`。哈希相同 → 直接复用（0 个术语表请求）；哈希变化 → 用
  `PUT /v3/glossaries/{id}/dictionaries` 替换该语言对的词典（v3 的替换语义）；缓存不可用（宿主没有绑定 KV）→
  按名称 `GET /v3/glossaries` 查找并复用，找不到才创建。
- **引用**：翻译请求带 `glossary_id`。术语表用 v3 管理、翻译用 v2；DeepL 明确不建议混用两代术语表端点。
- **降级**：术语表端点失败（403、456、429、5xx、结构不符）时，插件**照常翻译、但不带 `glossary_id`**——
  这次翻译不会应用术语，结果里也没有警告字段；原因会尽力写进 KV 的 `deepl:glossary:last-error`（不含术语与密钥）。
  中止（超时/插件停止）不降级，直接上抛。
- 没有术语表，或源语言不是 DeepL 支持的语言时，不发出任何术语表请求，也不带 `glossary_id`。

## 错误与失败语义

| 情况 | 插件的行为 |
|---|---|
| 宿主没有配置 `deepl_api_key` | `DEEPL_NO_API_KEY`，不发任何请求 |
| 401 / 403 | `DEEPL_UNAUTHORIZED` / `DEEPL_AUTH_FAILED` |
| 400 / 413 / 415 | `DEEPL_BAD_REQUEST` |
| 456 | `DEEPL_QUOTA_EXCEEDED`（账户额度用尽） |
| 429 | `DEEPL_RATE_LIMITED` |
| 5xx | `DEEPL_UNAVAILABLE` |
| 网络错误 | `DEEPL_REQUEST_FAILED` |
| 答案的段落数/类型不符 | `DEEPL_BAD_RESPONSE`（不返回部分答案） |
| 目标语言 DeepL 不支持 | `DEEPL_UNSUPPORTED_LOCALE`（不猜近似语言） |
| 单段超过一个请求的上限 | `DEEPL_REQUEST_TOO_LARGE` |
| 需要的批次超过调用预算 | `DEEPL_TOO_MANY_SEGMENTS`（一个请求都不发） |

插件不自动重试（宿主对一次插件翻译也只调用一次）；429 与 456 重试只会放大问题。失败信息只含 HTTP 状态与 DeepL 的
`message`/`X-Trace-ID`，不含 API key、段落文本或术语内容。宿主把任何插件抛错记成一次失败调用
（`failed_final`、计费 `unknown`，不发已结算行），运营者据此决定是否重发。

## 运营者看到什么

选中并完成一次翻译后，账本与用量报表出现的是**按字符**而不是按 token 的记录：

| 字段 | 值 |
|---|---|
| `snapshot.name` | `plugin:heopress-deepl` |
| `snapshot.model` | `deepl` |
| `instance_ref` | `plugin:heopress-deepl/deepl` |
| `pricing` | `{ "kind": "per_1m_chars", "charsMicros": 27500000 }` |
| `actual_micros` | `ceil(字符数 × 27.5)` |
| `billed_characters` | 源文本字符数（`sum(segment.text.length)`） |
| `input_tokens` / `output_tokens` | `null` |

例如 13 个字符的一次翻译写一条 `settled` 行，`actual_micros = 358`、`billed_characters = 13`，并计入当月预算；
预算不足以覆盖预留时以 `BUDGET_EXCEEDED` 拒绝，DeepL 不会被调用。

## 限制（有意为之）

- **密钥录入**：已由宿主的插件密钥功能提供（加密存储、Studio 录入与 `PluginHost` 解析）；见上「配置密钥」与
  [插件密钥](../../docs/zh-CN/extensions/plugin-secrets.md)。调用方仍可经 `createSandbox` 注入解析器做测试。
- **语言变体归并**：DeepL 只提供 `EN-US`/`EN-GB`、`PT-PT`/`PT-BR`、`ZH-HANS`/`ZH-HANT`、`DE-CH`、`FR-CA`、`ES-419`；
  `en-AU`、`es-MX` 这类没有对应变体的 locale 分别归并到 `EN-US`、`ES`，README 与设计文档写明。
- **术语表降级没有 UI 警告**：扩展点的返回契约只有段落，没有警告字段；降级原因写在 KV 里，运营者不会在结果中看到。
- **删除术语表**：如果运营者在 DeepL 控制台删除了 HeoPress 术语表，KV 里缓存的 id 会失效，下一次翻译以可识别的失败结束，
  直到缓存被清除或重新建立。插件不会自动删除术语表，也不会无限重试。
- **一次调用最多 37 个翻译批次**：更多分段需要在调用方分批，避免翻译到一半被宿主的请求预算终止。
- **不做 Google/Azure**：同一形状的下一份拷贝，属于后续 change。

## 构建

```bash
npm install
npm run build     # tsc -p tsconfig.json → dist/index.js 与 dist/index.d.ts
```

只需要 Extension SDK 与 TypeScript（固定确切版本），不依赖任何 HeoPress 核心包。

## 许可证

Apache-2.0（见 `LICENSE`）；只通过插件清单、扩展点与 SDK 与 HeoPress 交互的插件属于独立扩展。

---
version: 1
lastUpdated: 2026-11-11T00:00:00.000Z
sourceLang: zh-CN
contentHash: d494aa861363e941
---

# 插件翻译服务（`translation-services`）

HeoPress v1.2 的第十一个扩展点：插件向站点提供一个**机器翻译服务**（DeepL、Google、Azure 等），
站点在模型设置里选中它之后，翻译由插件完成，而不是走 `LlmTranslationService` 的模型调用。
它沿用既有的能力审批、清单校验、沙箱、加载与账本，不是第二套插件机制；具体提供方是实现该扩展点的插件，
DeepL 已由官方插件 [`heopress-deepl`](translation-deepl.md) 提供，Google / Azure 是后续 change。

实现分别在 `packages/contracts/src/extensions/translation.ts`（契约与校验）、
`apps/cms/src/extensions/runtime/translation-services.ts`（读取与调用边界）、
`apps/cms/src/services/llm/translation-router.ts`（站点选择）与
`apps/cms/src/services/llm/plugin-translation.ts`（按字符记账）。

## 官方插件

| 插件 | 服务 id（站点选择值） | 能力 | 价格 | 术语表 |
|---|---|---|---|---|
| [`heopress-deepl`](translation-deepl.md) | `deepl`（`heopress-deepl:deepl`） | `ext:translation-services`、`http:fetch:api.deepl.com`、`http:fetch:api-free.deepl.com`、`secrets:deepl_api_key`、`kv:read`、`kv:write` | 每百万字符 27.5（DeepL API Growth 超出价，站点货币） | 把请求的 `glossary` 镜像为 DeepL 术语表（v3 管理、v2 翻译），按内容哈希复用与替换，端点不可用时降级为不带 `glossary_id` 的翻译 |

安装、批准能力、选择服务与运营者看到的账本行见 [DeepL 翻译插件](translation-deepl.md)。
官方命名空间（`heopress-`）的插件在安装与加载时要求签名 bundle。

## 它是什么

一个翻译服务由插件**按 id 声明**、由 bundle **按同一 id 注册**：

- 清单里的 `translationServices` 是管理员批准的那份声明：id、显示名、引擎名与每百万字符的价格；
- 代码里的 `defineTranslationService({ id, translate })` 收到要翻译的段落并返回译文；
- 宿主负责其余一切：能力检查、每次调用的时限与出站请求预算、返回值校验、账本记录与按字符计费。

一个插件最多声明 8 个服务。价格只能来自清单（bundle 不能改价），引擎名会进入账本的 `model` 列。

## 需要的能力

| 能力 | 用途 |
|---|---|
| `ext:translation-services` | 注册翻译服务本身（必需） |
| `http:fetch:<host>` | 调用外部翻译 API 的主机；每个主机一条，`*.example.com` 覆盖子域 |
| `secrets:<name>` | 一个命名密钥（API key）。**清单里没有内联密钥字段**，值由运营者在宿主为该插件配置 |

沙箱不提供 `db:*`、`env:read`、`service-account` 或没有主机名的 `http:fetch`；插件也拿不到站点模型提供方的密钥。

## 清单声明

```json
{
  "capabilities": ["ext:translation-services", "http:fetch:api.deepl.example", "secrets:deepl-key"],
  "translationServices": [
    { "id": "deepl", "displayName": "DeepL", "engine": "deepl", "pricePerMillionChars": 20 }
  ],
  "extensionPoints": { "translation-services": "^1.0.0", "context": "^1.0.0" }
}
```

规则（清单校验与安装流程共同执行）：

- `id` 是 `[a-z][a-z0-9-]*`，最多 40 字符；`displayName` 1–80 字；`engine` 是小写 slug（`[a-z0-9][a-z0-9._-]*`）。
- `pricePerMillionChars` 是可选的十进制价格（非负，最多 1 000 000），单位是**站点货币**的每百万字符；省略即 0。
- 声明了服务却没有 `ext:translation-services`、id 重复、声明超过 8 个、缺少对应扩展点版本范围，清单都会被拒绝。
- 这些声明随插件版本在安装或升级时一起被批准；之后不能用 `PATCH` 改写（要用升级流程）。

## 注册

```ts
import { defineTranslationService, type PluginContext } from '@heopress/extension-sdk';

export default (ctx: PluginContext) => {
  ctx.extensionPoints.register(
    'translation-services',
    defineTranslationService({
      id: 'deepl',
      // 可选的更小上限；插件的每次调用最多 20 s、20 个出站请求（宿主上限 60 s / 100）。
      maxDurationMs: 15_000,
      maxRequests: 5,
      async translate(req) {
        const key = await ctx.secrets.get('deepl-key');
        const res = await ctx.fetch('https://api.deepl.example/v2/translate', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `DeepL-Auth-Key ${key}` },
          body: JSON.stringify({
            source_lang: req.sourceLocale,
            target_lang: req.targetLocale,
            text: req.segments.map((s) => s.text),
          }),
          signal: req.signal,
        });
        const body = (await res.json()) as { translations: Array<{ text: string }> };
        return { segments: req.segments.map((s, i) => ({ id: s.id, text: body.translations[i]!.text })) };
      },
    }),
  );
  return {};
};
```

`translate` 收到 `{ siteId, sourceLocale, targetLocale, segments, glossary, memory, signal }`：

- `segments` 是本次要翻译的段落，`glossary` 是必须这样译的术语，`memory` 是模糊翻译记忆（仅参考）。
- `signal` 在本次调用超时或插件被停止时中止；`ctx.fetch` 也会计入本次调用的请求预算。
- **必须返回与请求相同的 id、每个 id 一次、顺序按请求**：`{ segments: [{ id, text }] }`。
  缺 id、多 id、重复 id 或非字符串文本会让这次翻译整体失败（`BAD_TRANSLATION`），不会得到部分译文。

注册了清单没有声明的 id 时，宿主拒绝该注册并写一条 `extension_capability_denied` 审计；
清单声明了但 bundle 没有注册的服务只是不可选，不会让插件加载失败。

## 站点选择

站点在模型设置里选中一个服务（`PUT /api/v1/llm/settings`）：

```json
{ "currency": "USD", "monthlyBudgetMicros": 5000000, "budgetTimezone": "Asia/Shanghai", "translationService": "heopress-deepl:deepl" }
```

- 取值是 `"<插件名>:<服务 id>"`；`null` 表示回到今天的 LLM 路径。
- 该设置在**每次翻译前**读取一次：选中且服务可用时由插件回答；未选中时 `LlmTranslationService` 的行为与计价完全不变。
- 选中但服务不可用（插件停用、id 不再声明、权限等待重新确认、契约版本不兼容）时，翻译**失败**并报
  `SERVICE_UNAVAILABLE`，**不会**静默改用 LLM——否则运营者以为在用某个引擎，账单却是一笔模型调用。

结果由宿主补齐插件不可能知道的字段：`engine` 与 `provider` 为 `plugin:<插件名>`，`model` 为清单的 `engine`，
`callId` 为这次调用的账本 call id；`segments` 是插件返回的译文。

## 计费：按字符，不是 token

插件翻译写进同一个账本（`lumibase_llm_attempts`），但计价不同：

| 账本字段 | 值 |
|---|---|
| `snapshot.name` | `plugin:<插件名>` |
| `snapshot.model` | 清单的 `engine`（如 `deepl`） |
| `instance_ref` | `plugin:<插件名>/<服务 id>` |
| `pricing` | `{ "kind": "per_1m_chars", "charsMicros": <每百万字符价格 × 1e6> }` |
| `actual_micros` | 每百万字符价格 × 源文本字符数，向上取整到微单位 |
| `billed_characters` | 本次翻译的字符数（`sum(segment.text.length)`） |
| `input_tokens` / `output_tokens` | `null`：这不是 token 调用 |

因此：

- 插件翻译出现在 `/api/v1/llm/usage` 的按模型分组里（`name` 是 `plugin:…`，`billedCharacters` 是字符数），
  也计入 `committedMicros` 与当月预算；
- 预留**先于**插件调用：当月预算不足以覆盖这次翻译时以 `BUDGET_EXCEEDED` 拒绝，插件不会被调用；
- 清单没有声明价格时价格是 0，但仍然写一条已结算的账本行（0 也是记录，不是「静默免费」）；
- 插件抛错或超时不结算：attempt 记为 `failed_final`、计费 `unknown`（请求可能已到达上游），保留预留等待人工对账，
  与网络失败的模型调用同一语义。

## 沙箱边界

**允许**

- `ctx.fetch` 只到 `http:fetch:<host>` 声明的主机，仍经宿主的出站边界与 SSRF 校验；
- `ctx.secrets.get('<name>')` 只读取清单声明的 `secrets:<name>`，值由宿主按「插件 + 站点」解析；
- 读取自己声明的设置与私有存储等其它已批准能力。

**不允许**

- 清单里没有内联密钥字段；密钥的值不进清单、日志或账本；
- 没有主机名的 `http:fetch`、`db:read` / `db:write`、`env:read`、`service-account`；
- 站点模型提供方的密钥与 `ai:generate` 的模型调用不能被当作翻译计费。

未声明的主机或密钥名会抛 `CapabilityError` 并写 `extension_capability_denied` 审计；每次调用的时限与请求预算由宿主强制，
插件只能要求更小。详见[插件开发指南](plugin-development.md)与[扩展点契约版本](plugin-development.md#2-扩展点契约版本)。

## 失败语义一览

| 情况 | 结果 |
|---|---|
| 服务没在时限内返回 | 调用被终止，翻译失败（`PLUGIN_TIMEOUT`），attempt 计费 `unknown` |
| 服务抛错或超出请求预算 | 翻译失败（`PLUGIN_ERROR` / `PLUGIN_LIMIT`），attempt 计费 `unknown` |
| 返回的段落不是请求的那一组 | 翻译失败（`BAD_TRANSLATION`），调用已按字符结算 |
| 选中的服务不可用 | 翻译失败（`SERVICE_UNAVAILABLE`），不写账本、不回退 LLM |
| 预算不足 | `BUDGET_EXCEEDED`，插件未被调用，不写 attempt |

可运行的行为见 `apps/cms/src/__tests__/translation-services.db.integration.test.ts`（声明、拒绝与审计、跨站、隔离、
按字符的账本行）与 `apps/cms/src/extensions/__tests__/translation-services-sandbox.test.ts`（主机与密钥边界）。

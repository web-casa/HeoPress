# Model providers

Every model call HeoPress makes — Copilot chat, generation and translation skills, intent and constitution checks, the decision service — goes through one gateway. The gateway picks the model, fails over to a backup, and records every attempt in a per-site ledger with its tokens and cost. Nothing is sent without a price.

There are two sources of models:

- **Site providers** — OpenAI-compatible services that a site administrator configures for that site: DeepSeek, Qwen, Kimi, GLM and any other service with a `/chat/completions` endpoint. Keys are sealed with the instance encryption key (`ENCRYPTION_KEY`) and are never shown again.
- **The instance default** — the model set by the operator through environment variables (`LLM_PROVIDER`, `OPENAI_API_KEY`, …). A site without its own providers uses it. Its use is charged to the calling site and counts against that site's budget.

## Choosing a model

For each call the gateway resolves a chain of candidates, then freezes it for that call:

1. the site's list for the task type (`chat`, `generation`, `translation`, `intent`, `constitution`, `decision`);
2. otherwise the site's `default` list;
3. otherwise the instance default.

If a list exists but all of its providers are disabled or deleted, the call fails with `PROVIDER_UNAVAILABLE`. It does not fall back to the instance default, so a misconfiguration cannot quietly switch a site onto the operator's credentials.

Failures on the provider's side move the call on to the next provider in the list: timeouts, network errors, `5xx`, `429`, `401`/`403`, `404` and a context that is too long. A cancellation, an exhausted budget, a refused capability or currency, or an exhausted deadline stops the call; nothing more is sent.

What each task type requires of every provider in its list:

| Task type | Needs tool calls | Used by |
|---|---|---|
| `chat` | yes | Copilot chat |
| `default` | yes (it stands in for every type) | anything without its own list |
| `generation`, `translation` | no | AI skills, the agent's generation and translation repair |
| `intent`, `constitution` | no | intent classification, the constitution judge |
| `decision` | no | `DECISION_PROVIDER=llm` |

A list is checked when it is saved, and every provider is checked again just before each request. A provider that does not declare a capability its task type needs is refused with `CAPABILITY_UNSUPPORTED`.

## Prices, currency and budget

Prices are mandatory and stored as integer **micro-units**, a millionth of the currency unit. A price of 2 per million tokens is written as `2000000`. A free model must state `0`. The cost of an attempt is `ceil(tokens × price / 1 000 000)` micro-units, counted separately for input and output tokens.

Each site has one currency. Every provider's prices must be in that currency, and the currency cannot change once the site has usage on record. The site's monthly budget follows a time zone you choose.

Before each attempt, the gateway reserves its largest possible cost: the estimated input plus the output cap. If the budget cannot cover the reservation, the call is refused with `BUDGET_EXCEEDED` and nothing is sent. The billing state of an attempt follows the evidence:

| Billing | When |
|---|---|
| `settled` | the response carried complete token usage, so the actual cost is recorded, even when it is above the reservation (which raises an alert) |
| `cancelled` | the request provably never left |
| `unknown` | it was, or may have been, sent, but usage is missing: a timeout, a dropped connection, an error without usage, including `429` |

An `unknown` attempt keeps its reservation against the budget, including in later months, until a site administrator reconciles it. Check the provider's console or invoice, then enter either the actual cost or "not billed". A run of rate-limit errors from one provider can be confirmed as "not billed" in one batch.

## Configuring a provider

The Studio page is **Settings → Models**. The same operations are available through the API, for site administrators only:

- `GET /api/v1/llm/providers`, `POST /api/v1/llm/providers`, `PATCH /api/v1/llm/providers/:id`, `DELETE /api/v1/llm/providers/:id`
- `POST /api/v1/llm/providers/:id/probe` — sends one request that offers a tool and asks for it to be called, and one that asks for a JSON object, and judges each by what actually came back (a `200` alone does not pass). Both requests are billed and recorded like any other call (task type `probe`).
- `PUT /api/v1/llm/routes` — `{ "taskType": "translation", "providerIds": ["…", "…"] }`. The first provider is the primary, the rest are backups in order. An empty list removes it.
- `PUT /api/v1/llm/settings` — currency, monthly budget and its time zone.
- `GET /api/v1/llm/usage?period=YYYY-MM`, `GET /api/v1/llm/attempts?pending=1`, `POST /api/v1/llm/attempts/:id/reconcile`, `POST /api/v1/llm/attempts/reconcile`

`baseUrl` is the API root. The gateway appends `/chat/completions`. The URL cannot contain credentials, a query string or a fragment. `capabilities` are what you declare: probe them to confirm. `maxContext` is declared only, because a probe cannot establish it.

The order matters: **set the site's currency first** (`PUT /api/v1/llm/settings`). A site without settings uses the instance currency (`LLM_PRICE_CURRENCY`, default `USD`), and a provider priced in another currency is refused (`422 PRICE_CURRENCY_MISMATCH`). The currency locks once the site has model usage. The examples below are in CNY:

```json
{ "currency": "CNY", "monthlyBudgetMicros": 500000000, "budgetTimezone": "Asia/Shanghai" }
```

That is a budget of 500 CNY a month, counted in Shanghai time.

Each example below is a `POST /api/v1/llm/providers` body. The model names were checked against each provider's documentation on 2026-10-18. Providers rename and retire models often, so check the provider's current model list, then **probe** the provider after creating it. **The prices are placeholders**: copy the current prices from the provider's price list, converted to micro-units in your site's currency. A test validates every example against the API's own schema, nested objects included, so a renamed field breaks the build rather than this page. The probe's request parameters were also checked against each provider's documented limits (some thinking models, such as Kimi K3, refuse a tool forced by name, so the probe offers the tool and asks for it to be called). No paid request was sent to them. Neither a test nor this page can tell whether a provider still serves a model; only the probe can.

These models think before they answer by default, and the reasoning is billed as output tokens. The probe allows for it with 2,048 output tokens per request. Set budgets with that in mind.

### DeepSeek

Use `https://api.deepseek.com` with `deepseek-flash`, or `deepseek-v4-pro` for harder work. `deepseek-chat` and `deepseek-reasoner` were retired on 2026-07-24.

```json
{
  "name": "DeepSeek",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-flash",
  "apiKey": "sk-your-deepseek-key",
  "capabilities": { "tools": true, "json": true, "maxContext": 1000000 },
  "pricing": { "kind": "per_1m_tokens", "inputMicros": 1000000, "outputMicros": 4000000 },
  "currency": "CNY",
  "timeoutMs": 120000
}
```

### Qwen (Alibaba Cloud Model Studio)

Use the OpenAI-compatible mode of DashScope: `https://dashscope.aliyuncs.com/compatible-mode/v1` in mainland China, or `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` for the international service. Model Studio also serves other vendors' models under their own names.

```json
{
  "name": "Qwen Plus",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen3.7-plus",
  "apiKey": "sk-your-dashscope-key",
  "capabilities": { "tools": true, "json": true, "maxContext": null },
  "pricing": { "kind": "per_1m_tokens", "inputMicros": 800000, "outputMicros": 2000000 },
  "currency": "CNY"
}
```

### Kimi (Moonshot AI)

Use `https://api.moonshot.cn/v1`, or `https://api.moonshot.ai/v1` outside mainland China. `kimi-k3` always thinks, and its tool calls and JSON mode are documented. The `moonshot-v1` series and `kimi-k2.5` were retired on 2026-08-31.

```json
{
  "name": "Kimi",
  "baseUrl": "https://api.moonshot.cn/v1",
  "model": "kimi-k3",
  "apiKey": "sk-your-moonshot-key",
  "capabilities": { "tools": true, "json": true, "maxContext": 1000000 },
  "pricing": { "kind": "per_1m_tokens", "inputMicros": 4000000, "outputMicros": 16000000 },
  "currency": "CNY",
  "timeoutMs": 180000
}
```

### GLM (Zhipu AI)

Use `https://open.bigmodel.cn/api/paas/v4` in mainland China, or `https://api.z.ai/api/paas/v4` for the international service. The API root has no `/v1`. `glm-5.3` always thinks. Text models support tool calls and `json_object` output. The model list was checked on the international service, so probe it on the mainland one.

```json
{
  "name": "GLM",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "model": "glm-5.3",
  "apiKey": "your-zhipu-key",
  "capabilities": { "tools": true, "json": true, "maxContext": null },
  "pricing": { "kind": "per_1m_tokens", "inputMicros": 4000000, "outputMicros": 16000000 },
  "currency": "CNY",
  "timeoutMs": 180000
}
```

### A failover list

With the providers above created, this makes translation try Qwen first, then DeepSeek:

```json
{ "taskType": "translation", "providerIds": ["<qwen-provider-id>", "<deepseek-provider-id>"] }
```

## The instance default

The operator configures it in the environment (see [environment variables](environment-variables.md)). It must have a price, or calls that would use it are refused with `PRICE_NOT_CONFIGURED`:

| Variable | Meaning |
|---|---|
| `LLM_PRICE_INPUT_PER_1M`, `LLM_PRICE_OUTPUT_PER_1M` | price per million input / output tokens, in currency units (e.g. `0.27`) |
| `LLM_PRICE_CURRENCY` | its currency (default `USD`); also the currency of a site that has no settings |
| `DECISION_PRICE_PER_REQUEST` | the per-request price of the TypeSafe / OpenRouter decision service; without it, decisions are refused (`DECISION_REFUSED`) |

## Keys and logs

Keys are write-only. Responses show a mask, and the gateway never writes a key to the ledger, an error, the audit log or the logs. A provider's own error text is never passed on either, because it can echo the request. Errors carry fixed codes such as `PROVIDER_HTTP_401`. Without the instance encryption key, a site provider's key cannot be stored or used (`503 ENCRYPTION_NOT_CONFIGURED`).

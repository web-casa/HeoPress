# extensions/translation-services Specification

## Purpose
定义插件提供的机器翻译服务：清单如何声明、bundle 如何注册、宿主如何拒绝未声明的 id、
站点如何选择它、结果契约与调用边界（时限与请求预算）、它如何被记账与按字符计费，以及它能触达什么
（`http:fetch:<host>` 与 `secrets:<name>`）。具体的机器翻译提供方（DeepL、Google、Azure）是另一个 change，本规格不覆盖。

## Requirements

### Requirement: 服务的声明与能力

插件清单 SHALL 通过 `translationServices` 按 id 声明它提供的翻译服务，每项含 `id`（`[a-z][a-z0-9-]*`）、
`displayName`（1–80 字）、`engine`（服务端引擎名，`[a-z0-9][a-z0-9._-]*`，最多 64 字）与可选的
`pricePerMillionChars`（非负，最多 1 000 000，省略即 0），并 SHALL 申请 `ext:translation-services` 能力。
声明了服务却没有该能力、id 重复、id 或 engine 不合语法、一处插件声明超过 8 个服务的清单 MUST 被拒绝并给出原因。
这些声明 SHALL 随插件版本在安装或升级时一并被批准，之后 MUST NOT 通过 `PATCH` 改写；bundle MUST NOT 改写
`engine`、`displayName` 或价格。

#### Scenario: 合法的声明

- **WHEN** 一个清单申请 `ext:translation-services` 并声明
  `translationServices: [{ "id": "deepl", "displayName": "DeepL", "engine": "deepl", "pricePerMillionChars": 20 }]`
- **THEN** 清单校验通过，声明被接受，价格被记为该站点的货币每百万字符 20

#### Scenario: 缺少能力

- **WHEN** 一个清单声明了 `translationServices` 但没有申请 `ext:translation-services`
- **THEN** 清单校验失败，原因指出该声明需要 `ext:translation-services` 能力

#### Scenario: 重复的 id 与超限

- **WHEN** 一个清单把同一个服务 id 声明两次，或声明第 9 个服务
- **THEN** 清单校验失败，原因分别指出 id 重复与数量超限

### Requirement: 注册、拒绝与审计

插件 bundle SHALL 通过 `ctx.extensionPoints.register('translation-services', defineTranslationService({ id, translate }))`
按清单声明的 id 注册服务。注册了清单未声明的 id 时，宿主 MUST 拒绝该注册，写入一条
`extension_capability_denied` 审计事件（`capability` 为 `translationServices:<id>`），且该服务 MUST NOT 出现在可选服务中。
清单声明了但没有注册的服务 MUST NOT 出现，且 MUST NOT 使插件加载失败。只有已启用、权限已批准、持有
`ext:translation-services` 且契约版本范围包含本实例版本的插件 SHALL 参与。

#### Scenario: 未声明的注册被拒绝

- **WHEN** 一个持有 `ext:translation-services` 的插件注册了清单没有声明的服务 id
- **THEN** 该服务不能用于翻译，并写入一条 `extension_capability_denied` 审计事件

#### Scenario: 停用的插件不参与

- **WHEN** 一个声明并注册了服务的插件被停用，或它的权限等待重新确认
- **THEN** 站点不能经它翻译，其它插件与 LLM 路径不受影响

### Requirement: 站点选择与宿主接线

站点 SHALL 在模型设置中有一个 `translationService` 选择项（`PUT /api/v1/llm/settings`），取值形如
`"<插件名>:<服务 id>"`，`null` 表示不使用插件（今天的 LLM 路径）。该设置在每次翻译时读取：
选中且服务可用时，`translate` SHALL 由插件服务回答；未选中时 MUST 仍由 `LlmTranslationService` 回答，
其行为与计价 MUST NOT 改变。选中但服务不可用（插件未安装、停用、权限未批准、id 未声明或契约版本不兼容）时，
翻译 MUST 失败并给出可识别的错误，MUST NOT 静默回退到 LLM。

#### Scenario: 选中插件服务

- **WHEN** 站点设置 `translationService = "heopress-deepl:deepl"`，且该插件已启用、权限已批准并注册了 `deepl`
- **THEN** 一次翻译由插件的服务回答，结果带插件给出的译文

#### Scenario: 未选中

- **WHEN** 站点没有设置 `translationService`
- **THEN** 一次翻译仍由 `LlmTranslationService` 回答，账本行仍是按 token 计价的模型调用

#### Scenario: 选中的服务不在了

- **WHEN** 站点选中的插件被停用（或服务从新版本清单里移除）
- **THEN** 翻译失败并报 `SERVICE_UNAVAILABLE`，不会改用 LLM 翻译，也不会写一条模型调用账本行

### Requirement: 结果契约与调用边界

插件服务的 `translate` SHALL 收到 `{ siteId, sourceLocale, targetLocale, segments: [{ id, text }], glossary, memory, signal }`，
并 SHALL 返回 `{ segments: [{ id, text }] }`：与请求完全相同的 id、每个 id 一次、文本为字符串。
宿主 SHALL 按请求的 id 与顺序组装结果，并补齐插件不可能知道的字段：`engine` 与 `provider` 为 `plugin:<插件名>`，
`model` 为清单声明的 `engine`，`callId` 为这次调用的账本 call id。
每次调用 SHALL 在宿主给定的时限（默认 20 000 ms，最多 60 000 ms）与出站请求预算（默认 20，最多 100）内运行；
一次调用抛错、超时或返回不符合契约时，该次翻译 MUST 失败，站点与其它插件 MUST NOT 受影响。

#### Scenario: 补齐宿主字段

- **WHEN** 插件 `heopress-deepl` 的 `deepl` 服务为两个段落返回译文
- **THEN** `TranslationResult` 的 `segments` 是这两个段落，`engine` 与 `provider` 为 `plugin:heopress-deepl`，
  `model` 为 `deepl`，`callId` 非空

#### Scenario: 答案不是请求的段落

- **WHEN** 服务返回了请求之外的一个 id，或漏掉一个 id，或返回重复的 id
- **THEN** 该次翻译以 `BAD_TRANSLATION` 失败，调用方拿不到部分译文

#### Scenario: 超过时限

- **WHEN** 服务在它的时限内没有返回
- **THEN** 这次调用被终止，翻译失败，错误码指出超时；站点可以继续发出下一次翻译

### Requirement: 按字符计费

一次插件翻译 SHALL 在账本中记录为一次调用与一次 attempt，计价 SHALL 按字符而不是 token：
`pricing.kind` 为 `per_1m_chars`，金额为「每百万字符价格 × 源文本字符数」，向上取整到微单位；
`billed_characters` SHALL 记录这次调用的字符数，`input_tokens` 与 `output_tokens` MUST 为 `null`。
账本快照的名称 SHALL 为 `plugin:<插件名>`，模型 SHALL 为清单的 `engine`，引用 SHALL 为 `plugin:<插件名>/<服务 id>`，
使这次调用在用量与预算里可辨认。清单未声明价格时价格 MUST 为 0，但 MUST 仍写一条已结算的账本行。
预留 MUST 先于调用发生：当月预算不足时 MUST 以 `BUDGET_EXCEEDED` 拒绝，且 MUST NOT 调用插件。

#### Scenario: 一条按字符计价的用量行

- **WHEN** 一个声明了每百万字符 20 的插件服务翻译 12 个字符，站点货币为 USD
- **THEN** 账本写入一条 `settled` 行，`actual_micros = 240`，`billed_characters = 12`，`input_tokens` 与 `output_tokens` 为 `null`，
  用量报表按 `name = "plugin:<插件名>"`、`model = <engine>` 汇总出这条记录

#### Scenario: 没声明价格也要记账

- **WHEN** 一个没有声明 `pricePerMillionChars` 的插件服务完成一次翻译
- **THEN** 账本仍写入一条 `settled` 行，`actual_micros = 0`，`billed_characters` 为实际字符数

#### Scenario: 预算不足

- **WHEN** 站点当月预算不足以覆盖这次翻译的预留金额
- **THEN** 调用以 `BUDGET_EXCEEDED` 失败，插件没有被调用，也没有 `settled` 行

### Requirement: 沙箱边界

插件翻译服务 MUST 只能通过已批准的 `http:fetch:<host>` 能力访问声明的主机，MUST 只能通过 `secrets:<name>`
读取宿主为它解析的命名密钥；清单 MUST NOT 有内联密钥字段。未声明的主机、未声明的密钥名与任何
`db:*`、`env:read`、`service-account` 能力 MUST 被拒绝并记入审计。插件 MUST NOT 获得站点模型提供方的密钥，
MUST NOT 绕过宿主的出站边界与 SSRF 校验。

#### Scenario: 未声明的主机被拒

- **WHEN** 一个只声明了 `http:fetch:api.deepl.example` 的插件服务请求 `https://evil.example`
- **THEN** 该请求被拒绝并写入一条 `extension_capability_denied` 审计事件，服务拿不到响应

#### Scenario: 未声明的密钥被拒

- **WHEN** 插件服务读取 `deepl-key` 而没有 `secrets:deepl-key` 能力
- **THEN** 读取被拒绝并记入审计，密钥值从不返回

#### Scenario: 经宿主解析的密钥

- **WHEN** 清单声明 `secrets:deepl-key` 且运营者为该插件配置了它
- **THEN** 服务经 `secrets.get('deepl-key')` 得到宿主解析的值，清单、日志与账本里都没有该值

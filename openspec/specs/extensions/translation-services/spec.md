# extensions/translation-services Specification

## Purpose
定义插件提供的机器翻译服务：清单如何声明、bundle 如何注册、宿主如何拒绝未声明的 id、
站点如何选择它、结果契约与调用边界（时限与请求预算）、它如何被记账与按字符计费，以及它能触达什么
（`http:fetch:<host>` 与 `secrets:<name>`）。除此之外，本规格还规定第一个官方提供方——DeepL 插件
`heopress-deepl`——的可观察行为（清单与能力、分段与语言映射、术语表同步与降级、错误映射、按字符计费）；
Google、Azure 等其它提供方是后续 change，不在本规格内。

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

### Requirement: 官方 DeepL 插件的清单声明

官方插件 SHALL 以名称 `heopress-deepl` 发布，并在清单里通过
`translationServices: [{ "id": "deepl", "displayName": "DeepL", "engine": "deepl", "pricePerMillionChars": <价格> }]`
声明唯一一个翻译服务。`pricePerMillionChars` SHALL 是有公开出处的 DeepL 挂牌价（以站点货币计），
无法核实时 SHALL 省略并在 README 与设计文档说明原因。清单 MUST NOT 含有内联密钥字段；价格只能来自清单，
bundle MUST NOT 改写它。

#### Scenario: 合法的官方清单

- **WHEN** 清单以 `heopress-deepl` 发布，声明 `deepl` 服务（引擎 `deepl`、每百万字符 27.5）
- **THEN** 清单校验通过，服务在批准后可选，账本快照的价格是每百万字符 27.5（`charsMicros = 27_500_000`）

#### Scenario: 没有内联密钥

- **WHEN** 检查随插件发布的清单
- **THEN** 其中没有 API key 字段、没有站点内容或密钥值；密钥只能经 `ctx.secrets.get('deepl_api_key')` 读取

### Requirement: 官方插件申请的能力

清单 SHALL 申请 `ext:translation-services`、`http:fetch:api.deepl.com`、`http:fetch:api-free.deepl.com` 与
`secrets:deepl_api_key`。只有当插件真的使用键值缓存时才 SHALL 申请 `kv:read` 与 `kv:write`。
清单 MUST NOT 申请 `db:*`、`env:read`、`service-account` 或没有主机名的 `http:fetch`，并 SHALL 为
`translation-services` 与 `context` 声明包含本实例版本的契约范围。

#### Scenario: 声明了服务却没有扩展点能力

- **WHEN** 清单声明了 `translationServices` 但没有申请 `ext:translation-services`
- **THEN** 清单校验失败，原因指出缺少的能力，安装被拒绝

#### Scenario: 未声明的主机

- **WHEN** 插件请求 `https://evil.example` 或声明之外的主机
- **THEN** 宿主的沙箱拒绝该请求并写一条 `extension_capability_denied` 审计，插件拿不到响应

### Requirement: 只发送请求携带的段落与语言

一次 `translate` SHALL 只把请求里的段落与语言对发给 DeepL：请求体只含 `text` 数组、`target_lang`、可选的
`source_lang` 与可选的 `glossary_id`。请求 MUST NOT 携带站点内容、模型密钥或其它定制参数，也 MUST NOT 把术语表
以 prompt 或自由文本的形式塞进翻译请求。

#### Scenario: 一次翻译的请求体

- **WHEN** 请求 `en` → `de` 的两个段落且没有术语表
- **THEN** 插件只发送一个 `POST /v2/translate`，请求体恰好是这两个段落的 `text`、`target_lang: "DE"` 与
  `source_lang: "EN"`，没有别的字段

### Requirement: 每请求上限与分批

一次 DeepL 翻译请求 SHALL 最多包含 50 个段落且请求体不超过 128 KiB；更长的输入 SHALL 被拆成多个批次。
单段自身超过请求上限时 MUST 以可识别的失败结束而不是截断。需要的批次数超过调用预算时，
插件 MUST 在发出任何请求前以可识别的失败结束，MUST NOT 翻译到一半。

#### Scenario: 超过每请求上限

- **WHEN** 请求包含 51 个段落
- **THEN** 插件发送两个翻译请求（50 段与 1 段），并把两个批次的答案按批内位置拼回请求顺序

#### Scenario: 单段太大

- **WHEN** 一个段落的 UTF-8 文本本身就超过 128 KiB
- **THEN** 翻译以可识别的请求过大失败结束，没有向 DeepL 发出请求，也没有截断的译文

### Requirement: 语言映射

`targetLocale` SHALL 按 DeepL 的语言代码映射，例如 `zh-CN` → `ZH-HANS`、`zh-TW` → `ZH-HANT`、
`pt-BR` → `PT-BR`、`en-GB` → `EN-GB`、`de-CH` → `DE-CH`，其余支持的语言用大写的根语言代码。
DeepL 不支持的目标语言 MUST 以可识别的失败结束，MUST NOT 猜测一个近似语言。源语言不认识或不在 DeepL 的列表里时，
插件 SHALL 省略 `source_lang`，让 DeepL 自行检测。

#### Scenario: 中文目标

- **WHEN** 请求 `en` → `zh-CN`
- **THEN** 翻译请求的 `target_lang` 是 `ZH-HANS`，`source_lang` 是 `EN`

#### Scenario: 不支持的目标语言

- **WHEN** 请求的目标语言是 DeepL 不支持的 `th`
- **THEN** 翻译以可识别的目标语言失败结束，没有向 DeepL 发出请求

#### Scenario: 不认识的源语言

- **WHEN** 请求的源语言不在 DeepL 的列表里
- **THEN** 翻译请求省略 `source_lang`，由 DeepL 检测；请求仍然发出

### Requirement: 结果顺序与完整性

返回的段落 SHALL 与请求完全相同的 id、每个 id 一次、按请求顺序；DeepL 答案的段落数或文本类型不符时
MUST 以可识别的失败结束，MUST NOT 返回部分答案，也 MUST NOT 用空字符串补位。

#### Scenario: 两个段落

- **WHEN** 请求两个 id 为 `s1`、`s2` 的段落
- **THEN** 返回的 `segments` 是 `[{ id: "s1", text }, { id: "s2", text }]`，顺序与请求一致

#### Scenario: 答案数量不符

- **WHEN** DeepL 返回的 `translations` 数量少于请求的段落数
- **THEN** 该次翻译失败且没有部分译文，宿主把这次调用记为失败

### Requirement: 术语表的规范化、命名与哈希

请求携带非空 `glossary` 时，插件 SHALL 按确定性规则规范化术语：去掉首尾空白、丢弃空项与控制字符、丢弃超过
DeepL 单条上限的条目、按源词去重并排序。术语表名称 SHALL 由站点标识与语言对确定性地生成；内容哈希 SHALL
由规范化后的条目计算。请求没有术语表时 MUST NOT 发出任何术语表请求。

#### Scenario: 空术语表

- **WHEN** 请求的 `glossary` 为空
- **THEN** 插件不发送任何术语表请求，只发送翻译请求

#### Scenario: 重复与不可表示的术语

- **WHEN** 请求的术语表含重复源词、空目标或含换行的条目
- **THEN** 插件规范化后只把可表示的、去重后的术语写进术语表，翻译仍然完成

### Requirement: 术语表的复用与更新

插件 SHALL 在 `ctx.kv` 可用时按哈希缓存 DeepL 术语表 id：哈希相同时 MUST 复用且 MUST NOT 重写术语表；
哈希变化时 SHALL 用 DeepL 的替换语义更新同一语言对的词典。缓存不可用时 SHALL 按名称在 DeepL 术语表中查找并复用，
找不到时才创建；翻译请求 SHALL 带上解析出的 `glossary_id`。

#### Scenario: 创建并引用

- **WHEN** 请求带两个术语，缓存为空且 DeepL 账户里还没有同名术语表
- **THEN** 插件创建一个术语表，翻译请求带它的 `glossary_id`，并把 `{id, hash}` 写进缓存

#### Scenario: 相同术语复用

- **WHEN** 同一站点、同一语言对的第二次翻译带相同术语
- **THEN** 插件不写术语表，直接用缓存的 `glossary_id` 翻译

#### Scenario: 术语变化

- **WHEN** 同一站点、同一语言对的术语内容变化
- **THEN** 插件用替换词典的请求更新同一个术语表，并把新的哈希写进缓存，翻译仍带它的 `glossary_id`

#### Scenario: 缓存不可用

- **WHEN** `ctx.kv` 读取返回空（宿主未绑定键值存储）
- **THEN** 插件按名称列出 DeepL 术语表，找到则复用、找不到则创建，翻译仍然得到 `glossary_id`

### Requirement: 术语表不可用时的降级

术语表端点失败（无权、额度、限流、上游不可用、答案结构不符）时，插件 SHALL 照常翻译但 MUST NOT 带 `glossary_id`，
并 SHALL 在 README 与设计文档写明「这次翻译没有应用术语表」。中止信号 MUST NOT 被降级吞掉，而 SHALL 原样上抛。
术语表名称与条目 MUST NOT 含密钥、站点内容之外的文本或段落原文。

#### Scenario: 术语表被拒绝

- **WHEN** DeepL 对术语表请求返回 403 或 456
- **THEN** 翻译照常完成，但请求不带 `glossary_id`；插件不返回错误，也不把这说成术语已应用

#### Scenario: 中止不被降级

- **WHEN** 调用在中途收到中止信号
- **THEN** 插件原样上抛中止，宿主记为超时或停止，而不是发出一份没有术语表的译文

### Requirement: 错误映射与失败语义

插件 SHALL 把 DeepL 的拒绝映射为可识别的失败：429 为限流、456 为额度用尽、401/403 为鉴权失败、400 为请求不合法、
5xx 为上游不可用、网络错误为请求失败、答案结构不符为答案不合法。没有配置 `deepl_api_key` 时 SHALL 在发出任何请求前失败。
插件 MUST NOT 自动重试；失败信息 MUST NOT 含 API key、段落文本或术语内容。

#### Scenario: 限流与额度

- **WHEN** DeepL 对翻译请求返回 429，或返回 456
- **THEN** 翻译以可识别的限流失败或额度失败结束，宿主把这次调用记为失败，且插件没有发出重试请求

#### Scenario: 鉴权失败

- **WHEN** DeepL 返回 403（密钥无权或范围不足）
- **THEN** 翻译以可识别的鉴权失败结束，错误信息不含密钥

#### Scenario: 没有密钥

- **WHEN** 宿主没有为插件配置 `deepl_api_key`
- **THEN** 翻译以可识别的缺密钥失败结束，没有向 DeepL 发出任何请求，也没有回退到 LLM

### Requirement: 选中后的端到端行为与计费

站点安装并批准该插件、启用它并把 `translationService` 设为 `heopress-deepl:deepl` 之后，一次翻译 SHALL 由插件的服务回答，
宿主 SHALL 补齐 `engine`/`provider` 为 `plugin:heopress-deepl`、`model` 为 `deepl`，并 SHALL 写一条按字符计价的已结算账本行：
`snapshot.name` 为 `plugin:heopress-deepl`、引用为 `plugin:heopress-deepl/deepl`、`billed_characters` 为源文本字符数、
`input_tokens` 与 `output_tokens` 为 `null`。MUST NOT 写模型调用行，MUST NOT 回退到 `LlmTranslationService`。

#### Scenario: 一次由插件回答的翻译

- **WHEN** 站点选中 `heopress-deepl:deepl`，请求 13 个字符、两个段落，DeepL 返回两条译文
- **THEN** 结果是这两条译文（顺序与 id 与请求一致），账本写入一条 `settled` 行，
  `actual_micros = ceil(13 × 27.5) = 358`、`billed_characters = 13`、`snapshot.name = plugin:heopress-deepl`、
  `instance_ref = plugin:heopress-deepl/deepl`，且没有模型调用

#### Scenario: 插件未启用

- **WHEN** 站点仍选中 `heopress-deepl:deepl`，但插件被停用或权限等待重新确认
- **THEN** 翻译以 `SERVICE_UNAVAILABLE` 失败，没有调用 DeepL，没有写账本行，也没有回退到 LLM

### Requirement: 预算先于调用

一次插件翻译的预留 SHALL 在调用 DeepL 之前完成；当月预算不足以覆盖这次翻译的预留金额时，翻译 MUST 以
`BUDGET_EXCEEDED` 失败，MUST NOT 调用插件或 DeepL，也 MUST NOT 写已结算的账本行。

#### Scenario: 预算不足

- **WHEN** 站点当月预算小于这次翻译按字符的预留金额
- **THEN** 翻译以 `BUDGET_EXCEEDED` 失败，DeepL 没有被调用，账本里没有这次调用的已结算行

# ai/dual-model-translation Specification

## Purpose
定义 HeoPress 内置的双模型翻译服务 `heopress:dual-model`：站点如何选择它并用两个既有模型绑定配置起草与复核、
草稿如何以严格 JSON 产出并整批校验、哪些确定性的机械门禁在任何人类可见的接受之前运行、复核如何做一次有界修订、
两次调用如何记账并受预算约束、以及结果如何记录逐段来源。它不引入任何第三方机器翻译厂商，也不改变插件翻译路径。

## Requirements

### Requirement: 内置服务与站点选择

宿主 SHALL 提供一个内置翻译服务，id 为 `heopress:dual-model`；站点 SHALL 通过既有的 `translationService`
设置选择它（`PUT /api/v1/llm/settings`，`null` 仍是单模型 LLM 路径）。`heopress` 前缀 SHALL 保留给宿主内置服务：
取值为内置服务 id 时 MUST NOT 按插件服务解析。翻译时若选择的内置服务不可用（绑定缺失、提供方被停用或删除），
翻译 MUST 以 `SERVICE_UNAVAILABLE` 失败，MUST NOT 静默回退到单模型路径，也 MUST NOT 改用另一个模型。

#### Scenario: 选择内置服务
- **WHEN** 站点把 `translationService` 设为 `heopress:dual-model`，并保存起草绑定 A 与复核绑定 B（两者不同）
- **THEN** 保存成功，下一次翻译由双模型服务回答，设置响应带回两个绑定 id

#### Scenario: 选择失效
- **WHEN** 站点仍选择 `heopress:dual-model`，但复核绑定的提供方被停用或删除
- **THEN** 翻译以 `SERVICE_UNAVAILABLE` 失败，没有发出模型请求，也没有回退到单模型翻译

### Requirement: 两个绑定的保存时约束

站点 SHALL 用两个既有的模型提供方绑定配置该服务：`translationDraftProviderId` 与
`translationReviewProviderId`，与站点的货币、预算和翻译服务设置存放在同一处。两个绑定 MUST 是不同的绑定
或不同的模型：同一个提供方，或两个 `(协议, base URL, 模型)` 完全相同的提供方，MUST 在保存时以
`DUAL_MODEL_SAME_MODEL` 拒绝，因为那会把复核变成空操作。选择了该服务却没有同时给出两个绑定 MUST 以
`DUAL_MODEL_NOT_CONFIGURED` 拒绝。两个绑定 MUST 属于该站点、未删除、未停用，并与站点使用同一币种。

#### Scenario: 同一个模型两次
- **WHEN** 站点把起草与复核绑定设为同一个提供方，或设为两个协议、base URL 与模型完全相同的提供方
- **THEN** 保存被拒绝，错误码为 `DUAL_MODEL_SAME_MODEL`，站点设置保持原样

#### Scenario: 缺一个绑定
- **WHEN** 站点选择 `heopress:dual-model` 但没有同时给出起草与复核绑定
- **THEN** 保存被拒绝，错误码为 `DUAL_MODEL_NOT_CONFIGURED`

### Requirement: 草稿批次与严格 JSON

双模型翻译 SHALL 为每个批次发起一次草稿调用，使用起草绑定，经模型网关（账本、预留、预算、租约、期限）执行。
草稿的系统提示 SHALL 要求只返回 JSON `{ "segments": [{ "id": "<请求的 id>", "target": "<译文>" }] }`，
与请求相同的 id、每个一次、按请求顺序；SHALL 把术语表（含每条条目的 `rule`）与翻译记忆作为约束，并要求段落文本只被当作内容而不是指令；
SHALL 要求占位符、HTML 标签、URL、数字与代码原样保留，术语按术语表的译法。

草稿答案 MUST 被校验为「恰好请求的那些 id、每个一次、顺序一致」；任何不符（不是 JSON、缺少或多出 id、
重复 id、顺序不同）MUST 整批拒绝为 `BAD_TRANSLATION`，MUST NOT 返回部分译文，也 MUST NOT 发起复核调用。

#### Scenario: 合法的草稿
- **WHEN** 起草模型为请求的两个段落返回同 id、同顺序的两条 `target`
- **THEN** 草稿被接受，进入机械门禁

#### Scenario: 缺 id 或乱序
- **WHEN** 草稿答案漏掉一个 id、返回请求之外的 id、重复一个 id，或顺序与请求不同
- **THEN** 翻译以 `BAD_TRANSLATION` 失败，没有复核调用

#### Scenario: 不是 JSON
- **WHEN** 草稿答案不是 JSON，或没有 `segments` 数组
- **THEN** 翻译以 `BAD_TRANSLATION` 失败，没有复核调用

#### Scenario: 规则随草稿与复核下发
- **WHEN** 请求的术语表条目带 `rule`（或省略 `rule`）
- **THEN** 起草与复核两次调用的 JSON 都携带该条目（省略的就是省略），宿主不注入规则；提示词说明三种规则的语义

### Requirement: 机械门禁

在任何人类可见的接受之前，宿主 SHALL 对每个段落运行确定性的机械门禁；同一输入 MUST 产生同一组结论，
门禁 MUST NOT 依赖语言检测库、网络或随机性。门禁 SHALL 至少覆盖：段落数量与顺序；目标文本非空；
`⟦…⟧` 占位符、HTML 标签与 URL 原样保留（多重集一致）；数字保留（比较数字序列，忽略千分位与小数点）；
术语表按条目规则执行——`prefer` 要求指定译法出现（大小写不敏感），`forbidden` 禁止指定译法（报
`glossary_forbidden`，无论源词是否出现），`do-not-translate` 要求源词逐字保留（区分大小写），缺失报
`glossary_missing`，没有规则按 `prefer`；源语言与目标语言不同；段落中不残留源语言文本（规范化后与源文相同，
或跨书写系统时目标文没有目标书写系统字符；只对有实质内容的源文生效，短段落与纯占位符/URL/代码段落豁免）。

一个段落未通过门禁 SHALL 被视为**草稿的缺陷**，其门禁结论 MUST 被记录并发送给复核者。

#### Scenario: 占位符丢失
- **WHEN** 源文含 `⟦P0⟧` 而草稿没有保留它
- **THEN** 该段落被记为占位符缺失，结论发送给复核者

#### Scenario: 数字被改
- **WHEN** 源文含 `2024` 而草稿把它改成 `2025` 或丢掉
- **THEN** 该段落被记为数字缺失

#### Scenario: 术语表未遵守
- **WHEN** 源文含术语表的源词，而草稿没有使用其指定译法
- **THEN** 该段落被记为术语缺失

#### Scenario: 空段落与同语言对
- **WHEN** 草稿的一个段落为空，或请求的源语言与目标语言相同
- **THEN** 空段落被记为缺陷；同语言对的请求在调用任何模型之前被拒绝

#### Scenario: 未翻译
- **WHEN** 源文是一句有实质内容的话，而草稿逐字返回源文（或跨书写系统时完全没有目标书写系统字符）
- **THEN** 该段落被记为未翻译

#### Scenario: 纯占位符段落豁免
- **WHEN** 一个段落去掉占位符、URL 与标签后没有可翻译的字母（例如整段只有一个 `⟦P0⟧` 或一个 URL）
- **THEN** 不因「未翻译」或「与源文相同」被记为缺陷，其它门禁仍然运行

#### Scenario: 被禁译法出现
- **WHEN** 术语表条目为 `forbidden`，而草稿或修订的译文中出现了它的指定写法
- **THEN** 该段落被记为 `glossary_forbidden`，该文本 MUST NOT 被当作已接受

#### Scenario: 不翻译的词被改写
- **WHEN** 术语表条目为 `do-not-translate`，源文含该词，而译文把它翻译或改写了大小写
- **THEN** 该段落被记为 `glossary_missing`

#### Scenario: 没有规则的条目
- **WHEN** 一条术语表条目没有 `rule`（旧调用方的 `{ source, target }`）
- **THEN** 门禁按 `prefer` 检查它，结论与显式 `prefer` 完全相同

### Requirement: 复核调用与答案契约

宿主 SHALL 在草稿之后发起一次复核调用，使用复核绑定，向复核模型提供源文、草稿，以及失败段落的门禁结论，
并要求返回 `{ "segments": [{ "id": "<请求的 id>", "verdict": "ok" | "revise", "revised": "<修订文本>", "reason": "<理由>" }] }`。
答案 MUST 恰好覆盖请求的 id、每个一次、`verdict` 合法、`revise` 必须带非空 `revised`；不符 MUST 被视为
**复核失败**而不是草稿失败。复核调用失败（网络、限流、答案不合法）MUST NOT 丢失草稿：结果 SHALL 带回草稿文本，
并明确标记为未复核。调用方的取消与网关的预算顺延 MUST 原样上抛，MUST NOT 被当作复核失败吞掉。

#### Scenario: 复核通过
- **WHEN** 复核模型对每个段落判定 `ok`，且草稿通过机械门禁
- **THEN** 段落状态为已复核，译文就是草稿

#### Scenario: 复核失败保留草稿
- **WHEN** 复核调用超时、报错，或返回不是约定的 JSON
- **THEN** 结果带回草稿文本，复核状态为「未运行」并记录失败原因，所有段落标记为 `unverified`

#### Scenario: 复核阶段被顺延或取消
- **WHEN** 复核调用遇到每日预算顺延，或调用方中止
- **THEN** 该错误原样上抛，不被吞掉成「未复核」

### Requirement: 一次有界修订

一次翻译 MUST 最多有一次修订（两次模型调用），MUST NOT 有第三次调用。一个修订 SHALL 只有在通过
**与草稿相同的机械门禁**后才被接受；否则 MUST 保留草稿，并把该段落标记为 `rejected_verification`。
复核判定 `ok` 但草稿仍有门禁缺陷时，MUST 保留草稿并把该段落标记为 `unverified`，MUST NOT 当作已接受。

#### Scenario: 修订被接受
- **WHEN** 复核模型对一段判定 `revise` 并给出通过同一套机械门禁的修订文本
- **THEN** 该段采用修订文本，状态为已修订，修订段数加一

#### Scenario: 修订被门禁拒绝
- **WHEN** 复核模型给出的修订文本破坏了占位符、HTML 标签、URL、数字或术语表
- **THEN** 保留草稿，该段状态为 `rejected_verification`，修订后被拒段数加一

### Requirement: 记账、预算与失败语义

两次调用 SHALL 各自是独立的账本调用与 attempt，各自在调用前预留、调用后结算，并按**各自绑定的 token 价格**计价；
`input_tokens` 与 `output_tokens` SHALL 如实记录。租约、期限与站点每日预算 SHALL 对两次调用分别生效。
给了持久调用标识（`callKey`）时，两次调用 SHALL 使用可区分的标识（草稿与复核各一个），使重放各自返回记录的结果。
草稿调用之前预算不足时，翻译 MUST 以 `BUDGET_EXCEEDED`（或网关的顺延）失败，MUST NOT 向提供方发出请求，
MUST NOT 写入已结算的 attempt。

#### Scenario: 两次调用分别计价
- **WHEN** 起草绑定与复核绑定的 token 价格不同，一次翻译完成两次调用
- **THEN** 账本有两条已结算 attempt，`provider`/`model` 与金额分别对应各自的绑定

#### Scenario: 草稿前预算耗尽
- **WHEN** 站点剩余预算不足以覆盖草稿调用的预留
- **THEN** 翻译以 `BUDGET_EXCEEDED` 失败，没有 HTTP 请求，没有 attempt，也没有已结算行

### Requirement: 可观察的结果与逐段来源

`TranslationResult` SHALL 在双模型服务下记录：起草的提供方、模型与 call id；复核的提供方、模型与 call id
（复核未产生结论时为空）；复核是否真正产生结论及失败原因；修订段数；修订后被门禁拒绝的段数；
以及每个段落的最终状态（`verified`、`revised`、`rejected_verification` 或 `unverified`）、门禁代码与复核理由。
顶层 `engine` SHALL 为 `heopress:dual-model`，`provider` 与 `model` SHALL 是起草绑定，`callId` SHALL 是草稿调用的账本 id。
任何段落的来源、状态、门禁结论与复核理由 MUST NOT 被静默丢弃。插件与单模型实现的结果 MUST 保持兼容（不要求该字段）。

#### Scenario: 混合结果
- **WHEN** 一次翻译中一段修订被接受、一段修订被门禁拒绝、一段复核通过
- **THEN** 结果逐段报告 `revised`、`rejected_verification`、`verified`，修订与拒绝计数与状态一致，
  并分别给出起草与复核的模型与 call id

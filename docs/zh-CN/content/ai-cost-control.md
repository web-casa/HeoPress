# AI 成本控制与模型调用治理

总览见[《AI 内容流水线与质量门禁》](ai-pipeline-quality-gate.md)。

本页说明 AI 内容流水线的费用与调用治理（P09 任务 1.11、4.2、4.4–4.7）：逐次调用账本、站点月度预算与暂停、每日预算、
按服务限流与熔断、每日加工配额，以及内部翻译服务接口。模型提供方的配置与账本状态机见 [Model providers](../../en/deployment/model-providers.md)。

代码位置：`apps/cms/src/services/llm/`（`gateway.ts` 模型网关、`ledger.ts` 账本、`governance.ts` 限流与熔断、
`pipeline-control.ts` 流水线暂停、`daily.ts` 每日预算与加工配额、`translation-service.ts` 翻译服务）。

## 逐次调用账本

每一次模型调用都经模型网关，写入账本：一次逻辑调用（`lumibase_llm_calls`）及其每次网络尝试（`lumibase_llm_attempts`），
记录 token、预留金额与实际费用。P09 起每次调用还记录发起它的 **AI 能力**（`capability`）：

| 能力 | 路由（任务类型） |
|---|---|
| `ingest_embedding`（采集近似重复检查的嵌入） | `embedding` |
| `translate`（翻译） | `translation` |
| `rewrite`、`write`、`seo_copy`、`value_assessment`、`fact_check`、`flow`、`workbench_trial` | `generation` |
| `chat`、`intent`、`constitution`、`decision`、`probe` | 同名任务类型 |

提示词工作台的试跑（`workbench_trial`）同样计费并计入站点预算，只是不产生内容条目。
同一执行键（`callKey`，例如 `run:<运行 ID>:call:<序号>`）重复调用时返回已记录的结果，不会再次发送或重复结算。

## 站点月度预算与暂停

在 **设置 › 模型** 中设置月度预算（`monthlyBudgetMicros`，微单位：货币单位的百万分之一）。每次尝试发送前按估算原子预留：
同一站点的预留在账本锁内串行，并发任务不会各自消费同一份剩余额度；调用结束后按实际用量结算，没有用量报告的保留为"未知负债"。

预算不足时：

1. 该次调用以 `BUDGET_EXCEEDED` 结束，不发送请求；
2. 站点的 AI 内容流水线进入 `budget` 暂停：已经开始的步骤会完成，新的生产任务不再发起；
3. 站点管理员收到一条站内通知（同一次暂停只通知一次）。

进入新的预算月份（按预算时区）后，**只**解除 `budget` 暂停；人工暂停（`manual`）、事故暂停（`incident`）与紧急开关（站点冻结）
都保留，直到有人解除。管理员也可以在提高预算后手动解除预算暂停。

接口（站点管理员）：

```bash
curl -H "Authorization: Bearer $TOKEN" https://cms.example.com/api/v1/llm/pipeline
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"reason":"manual","note":"编辑复核期间暂停"}' https://cms.example.com/api/v1/llm/pipeline/pause
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"reason":"manual"}' https://cms.example.com/api/v1/llm/pipeline/resume
```

## 模型调用治理

每个模型服务（站点的某个提供方，或实例级服务；按站点与配置指纹区分）有：

- **限流**：每分钟最多 `HEOPRESS_LLM_RATE_LIMIT_PER_MINUTE` 次尝试（默认 60，`0` 表示不限）；
- **熔断**：连续 `HEOPRESS_LLM_BREAKER_FAILURES` 次服务故障（默认 5）后打开 `HEOPRESS_LLM_BREAKER_COOLDOWN_SECONDS` 秒（默认 60），
  之后放行一次试探请求，成功则关闭、失败则重新打开。

只有网络错误、超时、429 与 5xx 计入熔断；400、401、422 等请求本身的错误不计入。
某个服务被限流或熔断时，调用改用失败转移列表中的下一个模型；全部不可用时，调用被**延后**（`LlmDeferredError`，带 `retryAt`），
不会写入失败的账本调用，也**不消耗**任务的业务重试次数（`afterTaskFailure`）。

站点可另设**每日预算**（`dailyBudgetMicros`），按站点时区（站点内容设置中的时区）计算自然日；当天额度用完后调用延后到站点的下一个零点。

限流与熔断状态保存在进程内：小型 VPS 上的单个 CMS / Worker 进程即一处执行；多进程部署时每个进程各自执行同样的上限。

## 每日加工配额

`dailyProcessingLimit` 限制每个自然日（站点时区）进入加工的来源文档数，与发布节奏（每日发布上限、最小间隔）分别生效。
超出的文档按优先级（相同时按进入合格状态的先后）排到后续日期：例如上限 10、当天 25 篇合格文档时，当天加工 10 篇，次日 10 篇，第三天 5 篇。
当天计数在数据库中加锁递增，多个调度器同时运行也不会超过上限。

## 翻译服务接口

翻译经内部翻译服务接口（`TranslationService`）。v1 只有大模型实现（`LlmTranslationService`）：任务类型 `translation`、能力 `translate`，
与其他 AI 调用一样写入账本并计入站点预算。来源文本作为数据传入，模型的回答必须正好包含所请求的各段，否则拒绝。
v1.2 计划在同一接口上接入专用机器翻译服务与插件适配器，调用方无需修改。

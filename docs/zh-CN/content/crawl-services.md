# 采集服务配置

本页说明如何为站点配置外部采集服务（P08 任务 3.1–3.7）：TinyFish、Firecrawl、Crawl4AI 与 Cloudflare Browser Run。
它们只在原生抓取遇到**技术失败**时接手（需要 JavaScript 渲染、超时、服务端错误、抽取质量不合格）。原生抓取本身见[抓取与抽取](fetching.md)，信源配置见[信源](sources.md)。

代码位置：`apps/cms/src/services/ingest/providers/`（`types.ts` 插件接口与清单、`http.ts` 出站白名单、`target.ts` 目标校验、`chain.ts` 降级链、`budget.ts` 预算与熔断、`settings.ts` 站点设置、`result.ts` 输出统一抽取，以及四个服务各自的文件）。

## 合规边界（先读）

降级链只用于技术失败，**不用于绕过访问控制**（ADR-0009）：

- 目标站点返回 401、403、451，robots.txt 禁止，或页面 / 响应头声明 `noai`、`tdm-reservation: 1` 时，该 URL 记为 `access_denied`，**立即终止**，后续采集服务一律不调用；
- 出站安全边界拒绝的目标（内网、云元数据、带凭据的 URL 等）记为 `blocked`，同样立即终止；
- 交给采集服务之前，HeoPress 先用自己的 User-Agent 检查该 URL 的 robots.txt，并对目标做普通出站校验（全部解析地址必须是公网地址）；服务报告的最终 URL 再校验一次；
- 不使用任何服务的验证码破解、登录代填、住宅代理或"反屏蔽"功能。TinyFish 的任务说明里明确要求不登录、不破解验证码、遇到拦截页就报告拒绝；
- 服务返回的内容与原生抓取走同一套隐藏内容剔除、Readability 抽取、HTML 白名单清洗与质量检查，只返回 Markdown 的服务先转成转义后的纯 HTML 再处理。

## 启用前的确认

每个服务在每个站点上要满足以下全部条件才会被调用（Studio：内容 › 采集服务，仅站点管理员可修改）：

| 条件 | 说明 |
|---|---|
| 启用 | 默认关闭 |
| 外发确认 | 管理员确认"本站的目标网址会发送给该服务"，记录确认时间与确认人；取消确认后立即停用 |
| 凭据 | 只能写入、不能读出；用运行时主密钥（`ENCRYPTION_KEY` / 密钥轮换）加密存储，附加数据绑定"站点 + 服务"，复制到其他站点的密文无法解开，因此 A 站的密钥在 B 站不可用 |
| 必填选项 | Cloudflare 需要账户 ID；Crawl4AI 需要服务地址（站点自填，或实例自带的 `HEOPRESS_CRAWL4AI_ENDPOINT`） |
| 预算 | 本月估算费用未达上限 |
| 熔断 | 未处于暂停期 |

## 降级顺序

- 站点默认顺序：原生抓取在前，之后是已启用的服务，按"顺序"数字从小到大。
- 每个信源可以单独指定顺序（接口 `PUT /api/v1/ingest/providers/chains/:sourceId`，`{ "chain": ["native", "firecrawl"] }`；`{ "chain": null }` 恢复站点默认）。可以把原生抓取放到后面或去掉，但目标校验与 robots.txt 检查不会因此省略。
- 不满足启用条件的服务被跳过，并在抓取尝试中记录原因。每一步的失败都写入抓取尝试（`fetch_provider` 为 `native` 或服务名）。

## 预算与熔断

- 用量按"服务 × 站点 × 月（UTC）"记录请求数、失败数与估算费用（`lumibase_ingest_provider_usage`），在 Studio 中显示当月数据。
- 调用前先按单次估算费用预占额度；若会超过上限，该服务在本站点本月停用，并给站点管理员发送一次通知。上调或取消上限后立即恢复。服务报告了实际费用时用实际值替换估算值。
- 熔断：同一站点上某服务连续失败 `HEOPRESS_INGEST_PROVIDER_BREAKER_FAILURES` 次（默认 5），暂停 `HEOPRESS_INGEST_PROVIDER_BREAKER_MINUTES` 分钟（默认 15）。只有服务自身的失败计数（HTTP 错误、超时、无法解析的响应）；目标站点拒绝或抽取不合格不计入。更换密钥或服务地址会重置熔断。

费用是估算值，以各服务账单为准：

| 服务 | 默认单次估算 | 说明 |
|---|---|---|
| Firecrawl | 0.001 USD | 一次 scrape 计 1 个 credit，实际单价取决于套餐 |
| TinyFish | 0.001 USD | 按套餐计费，请按实际单价设置上限 |
| Cloudflare Browser Run | 0.0005 USD | 响应头 `X-Browser-Ms-Used` 存在时按 0.09 USD / 浏览器小时折算 |
| Crawl4AI | 0 | 自托管不计费；使用他人部署时请自行设置上限 |

## 各服务的密钥与接口

接口形态来自各服务的公开文档，契约测试使用录制样例（`apps/cms/src/services/ingest/__tests__/fixtures/providers/`），测试中不访问真实网络。标注"假设"的部分未能用真实账号核实，接口变化时只影响该服务的文件与样例。

### Firecrawl

- 凭据：API Key（`fc-` 开头），在 Firecrawl 控制台创建。出站主机：`api.firecrawl.dev`。
- 请求：`POST https://api.firecrawl.dev/v1/scrape`，`Authorization: Bearer <key>`，请求原始 HTML 与 Markdown。
- 额度：402 表示 credit 用完，429 表示限流，两者都视为该服务的技术失败（`quota`），转下一个服务。
- 假设：`metadata.statusCode` 是目标站点的状态码（401/403/451 → `access_denied`），`metadata.url` 是最终 URL。

### Crawl4AI

- 部署：自托管（下文 compose profile）或他人部署的服务；凭据可选（服务端开启 JWT 时填写 Bearer token）。出站地址：服务地址本身（精确到协议、主机、端口）。
- 请求：`POST <服务地址>/crawl`，要求服务端也检查 robots.txt（`check_robots_txt: true`）。
- 假设：结果中的 `status_code` 是目标状态码，`redirected_url` 是最终 URL；robots.txt 拒绝的错误信息视为 `access_denied`。

### Cloudflare Browser Run

- 凭据：API Token（权限 "Browser Rendering - Edit"）与账户 ID（32 位十六进制）。出站主机：`api.cloudflare.com`。
- 请求：`POST https://api.cloudflare.com/client/v4/accounts/<账户 ID>/browser-rendering/content`，带上 HeoPress 的 User-Agent。
- 假设：该接口不报告目标状态码与最终 URL，最终 URL 记为请求的 URL；拒绝页面由质量检查拦下（记为 `extraction`，不是 `access_denied`）。

### TinyFish

- 凭据：API Key（`X-API-Key`）。出站主机：`agent.tinyfish.ai`。
- 请求：`POST https://agent.tinyfish.ai/v1/automation/run`，任务说明要求以 JSON 返回标题、作者、时间、语言、最终 URL 与 Markdown 正文，并在遇到登录、付费墙或拦截页时返回 `access_denied: true`。
- 假设（未用真实账号核实）：同步接口在 `result` 中返回该 JSON，`status` 为 `COMPLETED`；只返回 Markdown，不报告目标状态码。

## 插件清单与网络限制

每个服务是一个内置模块，带一份清单（`ProviderManifest`）声明它可以访问的主机。服务代码拿不到全局 `fetch`，只能用按清单生成的 HTTP 客户端：

- 清单外的主机、非 https 的公网地址在发出前就被拒绝；
- 允许的请求经平台出站边界以"服务连接"发出：连接时校验全部解析地址，跨源重定向一律拒绝；
- 站点填写的服务地址不会因此变成可信内网地址，只有实例所有者在环境变量中登记的地址才可信（ADR-0014）。

为什么不用扩展沙箱（`apps/cms/src/extensions/sandbox.ts`）：沙箱面向从 URL 加载的第三方扩展包，`http:fetch` 能力按用户 URL 处理、不能按主机收窄，也不应接触站点凭据。内置服务是随 HeoPress 发布的代码，采用同一出站边界加按清单的主机白名单；第三方采集插件的开放放在 P12 扩展点中。

## 自托管 Crawl4AI（compose profile）

```bash
docker compose -f docker/docker-compose.yml --profile crawl4ai up -d
```

- 模板中 `HEOPRESS_CRAWL4AI_ENDPOINT` 默认为 `http://crawl4ai:11235`，CMS 把它登记为**仅供 Crawl4AI 服务使用**的可信内网地址，无需手动配置 `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS`。不用该 profile 时可设为空字符串关闭。
- Crawl4AI 只在独立的 `crawler` 网络中，该网络能访问公网，只与 `cms-worker` 共享；数据库与 API 只在默认网络，Crawl4AI 容器无法解析或连接 `postgres:5432`。
- 发给 Crawl4AI 的目标 URL 仍先经过普通出站校验与 robots.txt 检查。
- 在站点上仍需启用 Crawl4AI 并完成外发确认。

手动验证网络隔离（期望报错，无法解析主机名）：

```bash
docker compose -f docker/docker-compose.yml exec crawl4ai python -c "import socket; socket.create_connection(('postgres', 5432), 3)"
```

## 接口

| 方法与路径 | 权限 | 说明 |
|---|---|---|
| `GET /api/v1/ingest/providers` | 站点成员 | 各服务的启用、顺序、确认时间、是否已设置凭据（不返回凭据）、预算、熔断与当月用量 |
| `PATCH /api/v1/ingest/providers/:provider` | 站点管理员 | 修改上述设置；`credential` 只写，`credential: null` 清除 |
| `GET /api/v1/ingest/providers/chains/:sourceId` | 站点成员 | 信源的降级顺序 |
| `PUT /api/v1/ingest/providers/chains/:sourceId` | 站点管理员 | 设置信源的降级顺序 |

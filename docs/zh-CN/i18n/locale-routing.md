# 语言路由

同一站点的多语言版本有三种 URL 策略；请求的语言只由域名与路径决定，**不按浏览器语言（`Accept-Language`）替换内容**。

实现：`packages/public-site/src/path-space.ts`（站点的外部路径空间）、`packages/public-site/src/resolve-path.ts`（公开路径解析，CMS 与渲染服务共用：
CMS 经 `apps/cms/src/services/site-network/public-path.ts` 读自己的表，渲染服务 `apps/site-classic` 读公开投影）、
`apps/cms/src/services/site-network/language-entries.ts`（语言入口域名）。

公开站点由渲染服务 `apps/site-classic` 提供（见 `docs/zh-CN/rendering/site-classic.md`）：三种语言入口——路径前缀、语言子域名、独立语言域名——都按上述规则解析，
语言入口子域名不会被当作别名跳转到主域名；同一地址无论 `Accept-Language` 是什么，响应正文完全相同（HTTP 端到端测试 `apps/cms/src/__tests__/site-classic.db.integration.test.ts`）。

## 三种策略

| 策略 | 默认语言 | 其他语言 |
|---|---|---|
| `subdirectory`（子目录） | 主域名；`default_at_root` 时在根路径，`all_prefixed` 时也带前缀（`/` 跳到默认语言根） | 主域名上的路径前缀，如 `/zh/…` |
| `subdomain`（子域名） | 主域名 | 该语言的入口子域名，如 `en.example.com` |
| `domain`（独立域名） | 主域名 | 该语言的独立入口域名，如 `example.cn` |

语言前缀可自定义（`localePrefixes`，默认是语言标签的小写）；`default_at_root` 下访问默认语言的前缀会被去掉（301 到无前缀地址）。
修改前缀时自动写入从旧前缀到新前缀的 URL 级重定向（路径其余部分保留）。

## 语言入口域名

在域名设置中把**已验证**的子域名或独立域名登记为某语言的入口（`entryLocale`）：

- 入口域名直接以该语言提供内容，**不会**像普通别名那样被重定向到主域名；
- 一个语言在一个站点只能有一个入口域名；语言必须是站点的可用语言；
- 子目录策略下，入口域名同样可用：路径不带语言前缀。

## 解析与重定向

公开请求的主机、路径与查询串在一次解析中依次处理别名域名、语言识别、URL 级与内容级重定向、尾斜杠规范形式，
最终只返回**一次** 301 到最终地址（查询串保留）；循环或超过步数保护上限时返回 404 并写告警。语言切换数据见 [翻译组](translation-groups.md)。

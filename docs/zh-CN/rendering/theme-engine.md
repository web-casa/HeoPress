# 主题引擎与沙箱

公开页面由站点主题的 Liquid 模板渲染（LiquidJS）。模板只拿到页面数据契约（View Model），看不到数据库、请求、环境变量或密钥；
正文、SEO 头部、赞助披露与 JSON-LD 只能经系统标签输出，由系统生成，主题无法改写。

实现：`packages/contracts/src/theme/index.ts`（页面数据契约与 JSON Schema，Apache-2.0）、`packages/public-site/src/theme/engine.ts`（受限引擎与系统标签）、
`packages/public-site/src/theme/postprocess.ts`（最终 HTML 校验与替换）、`packages/public-site/src/theme/check.ts`（发布前静态检查）、
`packages/public-site/src/theme/pool.ts` 与 `packages/public-site/src/theme/render-worker.ts`（渲染池）、`packages/public-site/src/theme/builtin.ts`（内置主题）。

## 页面数据契约

顶层只有 `site`、`page`、`item`、`list`、`pagination`、`alternates`、`nav`、`seo`；渲染前用 JSON Schema 校验，多一项、少一项都拒绝渲染。
`item.fields` 是条目的公开字段（富文本除外），`list` 是卡片（标题、摘要、URL、发布时间、赞助标记）。页面类型：`home`、`item`、`taxonomy`、`search`、`error`，
主题为每种类型提供同名模板（`home`、`item`、`taxonomy`、`search`、`error`），局部模板放在 `partials/` 下。

## 系统标签

| 标签 | 输出 | 规则 |
|---|---|---|
| `{% seo_head %}` | title、description、canonical、robots、hreflang、Open Graph 与页面唯一的 JSON-LD 图（由 SEO 数据层生成，见 `docs/zh-CN/rendering/site-classic.md`） | 每页恰好一次，必须在 `<head>` 内 |
| `{% item_body %}` | 条目正文（写入公开投影时已清洗） | 条目页恰好一次，不能在 `<template>`、`<noscript>`、带 `hidden` / `inert` 的元素内 |
| `{% sponsor_disclosure x %}` | 赞助披露 | 站点开启显式披露时：赞助条目页必须在正文之前输出；赞助卡片必须在卡片内输出一次 |
| `{% card c %}…{% endcard %}` | 列表卡片容器 | 页面上每个指向赞助条目的链接都必须在该条目的卡片内 |

**结构化数据（P07）**：页面的 JSON-LD 由系统生成，随 `{% seo_head %}` 输出为唯一的一个图，主题不能再输出自己的 JSON-LD：`{% json_ld %}` 标签已移除（检查报告“不再可用”），
模板任何分支中的 `<script type="application/ld+json">`（大小写、参数与字符引用写法不论；按组合后的页面、Liquid 的空白控制与 HTML 的解析方式判断，`<noscript>` 中的也算）都在检查时被拒绝，
`<script>` 的 `type` 不能由模板计算；渲染后的页面再按解析后的属性检查一次。
主题脚本在浏览器中插入结构化数据同样违反约定，但检查器无法阻止（见主题开发指南）。检查器版本为 4：渲染服务读取的视图只返回已由检查器 4 检查并通过的激活版本，
此前检查的版本在重检前按内置主题渲染（升级时递增这些站点的渲染版本）；worker 启动时与之后每十分钟用当前检查器重检各站点的激活版本，通过的重新提供（递增渲染版本），
不通过的切回内置主题、记录事件与审计，并通知站点管理员。

系统标签先输出带本次渲染随机 nonce 的占位，渲染结束后整页解析：占位必须由本次渲染产生、恰好出现一次、位于有效位置（HTML 命名空间内，不在 SVG / MathML 中），
只带系统写入的属性，正文与披露占位不得有内容，卡片不得嵌套；页面中任何元素（占位也一样）不得含事件属性、`javascript:` 等协议的 URL、`<base>`、
`<meta http-equiv="refresh">`、`<iframe srcdoc>`、SVG 动画元素；指向赞助条目的链接按实际目标（去掉查询与片段）识别。全部通过后才替换为系统内容。任何违规都按渲染失败处理（站点错误页）。

## 模板沙箱

- 只能引用同一主题版本内的模板，模板名必须是字符串字面量；没有文件系统。
- 输出一律 HTML 转义，只能用 `{{ }}`；`echo`、`cycle`（不经转义直接输出）、`raw`、`liquid`、`layout`、`block`、`tablerow` 等标签与 `raw`、`json`、`jsonify` 等过滤器不可用；
  只能读取自有属性；`__proto__`、`constructor` 等内部属性名与 `x[变量]` 形式的动态属性访问一律拒绝。
- `{{ '路径' | asset_url }}` 输出本版本资源的地址（版本 + 内容哈希）；路径必须存在于版本中。
- `{{ x | url }}` 只放行 `http:`、`https:`、`mailto:` 与站内相对地址，其他（含 `//`、`\` 开头）输出 `#`。
- 限制：模板大小、渲染时间、内存分配、过滤器字符串与数组长度、`capture` 大小、输出大小（2 MB）。

## 发布前静态检查

对每个页面模板（局部模板内联后，深度 8 以内、不得成环、最多 500 次内联与 100 万字符）检查：

- 变量只能来自页面数据契约，按完整路径检查（含循环变量、`assign` 别名、局部模板参数、`map` / `where` / `sort` 等过滤器的属性名），
  例如 `site.name`、`c.title` 可以，`item.sponsor.secret`、`c.secret`、`list | map: 'secret'`、`env` 报错并给出变量名；
- 输出只能在文本或加引号的属性值中；`on*`、`style`、`srcdoc` 属性，`<script>`、`<style>`、`<noscript>`、注释、标签名与属性名中都不允许；URL 属性的输出必须以 `url` 过滤器结尾；
- Liquid 标签只能在文本中（`include` / `render` 在各自所在模板中检查），不能在 `<title>`、`<textarea>` 内；SVG / MathML 属性中不允许输出，不允许 SVG 动画元素；控制结构（`if`、`unless`、`case`、`for`、`capture`、`card`）的各分支必须保持 HTML 上下文不变——不能在分支中打开或关闭元素、写半个标签；
- 每个页面输出一次 `{% seo_head %}`，条目模板输出一次 `{% item_body %}`。

未执行的分支同样检查。

## 渲染池

渲染在 worker 线程中进行，每个 worker 同时只处理一次渲染；worker 不继承环境变量，V8 堆有上限。

- 墙钟超时（默认 1.5 秒）：终止 worker 并等待退出、启动新 worker，迟到结果丢弃；其他站点照常渲染。
- 每个站点同时最多占用 2 个 worker。
- 公平准入：每个站点一个等待队列，worker 轮流取各站点的任务；先算出需要拒绝哪些任务才能接纳，算不出时只拒绝新任务、不动已排队的任务；全局按条数与字节限制，满时拒绝排队最多的站点最新入队的任务（该请求得到 503），
  而不是新来的站点；单个任务超过上限直接拒绝。
- `resourceLimits` 只限制 V8 堆，不限制外部内存，也不能防止整个进程内存耗尽。

主题渲染失败时返回该站点主题的错误页（`error` 模板）；它也失败时返回内置的最小错误页。错误页不含堆栈与内部路径。

# 发现与去重

本页说明 RSS / Atom、sitemap 与列表页信源如何发现新 URL、如何有界翻页与回采，以及来源文档的精确去重、近似重复检测和同一事件聚合（P08 任务 1.3、2.8、4.1–4.4）。抓取本身见[抓取与抽取](fetching.md)，信源配置见[信源](sources.md)。

## 发现

| 信源类型 | 读取方式 |
|---|---|
| `rss` / `atom` | RSS 2.0（`item` 的 `link`，没有时用永久链接 `guid`）、RSS 1.0 与 Atom（`entry` 的 `rel="alternate"` 链接）；Atom 的 `rel="next"` 视为下一页 |
| `sitemap` | `urlset` 的 `loc`；`sitemapindex` 递归读取子 sitemap（最多 3 层）；gzip 压缩的 sitemap 按文件头识别并解压（解压大小同样受字节上限约束） |
| `list_page` | 用信源的 CSS 选择器：`item` 选出条目，`link` 取条目内链接，`title` 可选；下一页用 `nextPage` 选择器，未配置时用 `rel="next"` |

- 列表、feed 与 sitemap 本身也经过出站安全边界、robots.txt 与按主机限速，每一页、每一次重定向都重新校验。
- 发现出的每个链接都按下文规则规范化，并以「站点 + 规范化 URL」登记一次（`lumibase_ingest_discovered_urls`）：同一站点内无论哪个信源先发现，都只抓取一次；带追踪参数的变体就是同一个 URL。
- 只有**新** URL 产生抓取任务：队列 `ingest-fetch`，单例键为站点 + 规范化 URL；任务按规范化 URL 抓取（追踪参数不会发出），走与 `url` 信源相同的抽取、快照与登记流程。
- 每次运行最多登记 `maxItemsPerRun` 个新 URL，超出部分不登记，下次运行仍是新的。
- 非 http(s) 链接、带凭据的链接在发现时即记为 `refused`；指向内网、云元数据等地址的链接在抓取时被出站边界拒绝，同样记为 `refused` 并保留原因，且不会产生任何请求。`refused` 与 `access_denied` 不重试；技术失败（`failed`）的 URL 在下次被发现时重新排队。
- 运行记录保存本次的发现数、新增数与重复数（已见过的 URL，加上抓取后发现内容重复的页面）；后台「内容 › 信源」在健康状况一栏显示最近一次运行的这三个数。

## 有界翻页与回采

每次运行的上限（`DEFAULT_DISCOVERY_LIMITS`）：

| 上限 | 默认 |
|---|---|
| 页数 | 10 |
| 时长 | 120 秒 |
| 字节（所有列表页合计） | 20 MB |
| 读取的链接数 | 5000 |
| sitemap 索引嵌套 | 3 层 |
| 外部配额 | 每读一页消耗 1 单位（可选，由调用方提供） |

- 本次运行中再次遇到已访问的页面即判为循环（`cycle`），结束翻页。
- 提前结束的原因写入运行记录 `stop_reason`：`max_pages`、`max_duration`、`max_bytes`、`max_items`、`max_discovered`、`max_depth`、`quota`、`cycle`、`fetch_failed:<类别>`（例如翻页链接重定向到内网时为 `fetch_failed:blocked`）。第一页就读不到或配额一开始就为零时，整个运行记为失败并计入信源健康状况。
- 进度分两部分保存（`lumibase_ingest_source_cursors`）：**尝试进度**在抓取某页之前更新；**成功进度**只在该页全部链接登记完成后更新，失败与被截断的页面不会推进成功进度。
- 回采：列表页信源上次因上限停在中途时，本次先读第一页；第一页没有新链接（追上了最新内容）后，从成功进度记录的下一页继续往后读，直到读完或再次触顶。
- 写进度与登记链接都在事务内核对运行代次：租约过期、运行已被其他 Worker 接管后，旧 Worker 的写入被拒绝（`StaleRunError`），不会覆盖新 Worker 的进度。

## URL 规范化

只做不改变资源的规范化：

- 协议与主机名转小写，去掉默认端口（http 80、https 443），去掉 `#` 片段；
- 只删除**已配置**的追踪参数，其余参数保持原顺序与原编码。默认列表：`utm_*`、`fbclid`、`gclid`、`gbraid`、`wbraid`、`dclid`、`msclkid`、`yclid`、`twclid`、`ttclid`、`li_fat_id`、`igshid`、`mc_cid`、`mc_eid`、`_hsenc`、`_hsmi`、`mkt_tok`、`oly_anon_id`、`oly_enc_id`、`vero_id`、`spm`。可用 `HEOPRESS_INGEST_TRACKING_PARAMS`（逗号分隔，以 `*` 结尾表示前缀）追加；
- 路径大小写、功能参数与结尾斜杠一律保留：`/A` 与 `/a`、`?id=1` 与 `?id=2`、`/news` 与 `/news/` 都是不同的 URL。

canonical 只作为候选保存在来源文档的 `canonical_candidate`，**从不请求**，也不单独用来合并 URL：两个 URL 只有在规范化正文完全相同时才合并为一条来源文档（见下节）。因此跨源的恶意 canonical、只改大小写或参数的 canonical 都不会造成合并。

## 精确去重

登记来源文档时，在站点级事务锁内检查同一站点是否已有相同「规范化正文 SHA-256」（`content_hash`）的来源文档。已有时不生成第二条，本次抓取尝试记为 `duplicate` 并指向已有文档，发现记录状态为 `duplicate`。

## 近似重复

- 用正文（标题 + 前 4000 个字符）的嵌入向量计算余弦相似度，默认阈值 **0.92**（`HEOPRESS_INGEST_NEAR_DUP_THRESHOLD`，取值 0–1）。
- 比较范围：同一站点与同一部署内其他站点最近 30 天、同一嵌入模型的最多 500 条来源文档（只比较同一模型的向量）。命中时在来源文档上记录 `near_duplicate_check = duplicate`、`duplicate_of`（最相似的先到文档）、`duplicate_similarity` 与 `duplicate_scope`（`same_site` / `cross_site`）。近似重复只做标记，不阻止登记，供质量门禁使用。
- 所有模型调用都必须经过模型网关（账本、预算与路由）；网关目前还没有嵌入路由，因此生产环境暂不计算嵌入，检查跳过，记录 `near_duplicate_check = skipped`、`near_duplicate_reason = no_embedding_provider`；接入嵌入后，嵌入调用失败时原因为 `embedding_failed`。
- 跨站比较读取全局索引 `lumibase_ingest_dedup_index`，其中只有文档 ID、站点、内容哈希与向量，没有标题、正文或 URL。

### 跨站证据保护

- `GET /api/v1/ingest/documents/:id/duplicate`（站点编辑者）：同站重复返回先到文档的标题与 URL。
- 跨站重复时，**每次请求实时**校验调用者在另一站点的权限（该站点的编辑者或管理员）；有权限才在另一站点的范围内读取并返回文档引用。没有权限的调用者只得到 `{ "scope": "cross_site", "duplicateElsewhere": true }`，不含站点、内容 ID、标题、正文或 URL。权限被撤销后立即只剩匿名标记。
- `GET /api/v1/ingest/documents` 列出最近的来源文档，只带重复范围与事件角色，不含另一站点的任何信息。

## 同一事件聚合

- 从标题与正文开头 400 个字符抽取关键实体：版本号（`5.2`、`v5.2.1`、`2.0-beta`）、连续首字母大写的拉丁专有名词（`Example DB`、`ExampleDB`、`Example-DB` 视为同一实体；句首常见词忽略）、两位以上数字（弱证据）。
- 判为同一事件：在时间窗口内（发布时间，缺失时用抓取时间；默认前后 48 小时）至少共享 1 个强实体（版本号或专有名词）且共享实体不少于 2 个，并且双方都有版本号时版本号必须有交集。
- 同一站点内的事件簇（`lumibase_ingest_event_clusters`）只有第一篇（代表文档）生成后续加工任务；其余文档标记为 `supplementary`，挂在同一事件簇上，供加工时作为补充引用。
- 局限：不识别中文等非拉丁文字的专有名词（中文标题只能靠其中的拉丁名称、版本号与数字聚合）；没有同义词、翻译与指代消解；不确定时宁可不合并。没有强实体的文档不参与聚合。

# 译文新鲜度

翻译组中，源条目（原文）更新后，系统按**区块**判断哪些译文已经过期，并保证之后的重译不会覆盖人工修改过的译文。
本阶段只提供映射、过期标记与候选查询，不调用任何模型；实际翻译由后续流水线（P09）完成。

实现：`apps/cms/src/services/site-network/freshness-blocks.ts`（区块、哈希、移动判定）、
`apps/cms/src/services/site-network/freshness.ts`（映射、标记、周期核对）、
`apps/cms/src/services/site-network/freshness-consumer.ts`（事件消费者 `translation-freshness`）。

## 区块与映射

- 区块键为 `<字段>#<区块 ID>`：富文本字段的顶层元素（`data-block-id`）、重复器的行（`_blockId`）；SEO 标题、描述、社交图片各作为一个整字段伪区块（`seo_title#$` 等）。
- 区块哈希为规范化内容的 SHA-256：去掉 `data-block-id`、属性按名排序，**不改动任何文本**（空白、`&nbsp;`、代码缩进变化都算内容变化）；行区块为去掉 `_blockId`、键排序后的 JSON。
- 映射 `lumibase_translation_block_map` 记录“译文区块由哪个源区块翻译而来”，以及写入映射时两侧的哈希。写入接口：
  `POST /api/v1/translation-groups/:id/block-map` `{ targetItemId, pairs: [{ sourceKey, targetKey }] }`（调用者须能读源条目、能编辑译文）。
  重写已有映射会清除过期标记，但**不会清除人工编辑标记**。

## 过期与复核

源条目的变更事件到达时（以及周期核对时），对每条映射：

| 情况 | 标记 | 去向 |
|---|---|---|
| 源区块内容变化 | `stale` / `changed` | 未被人工编辑 → 可自动重译候选；被人工编辑 → 复核 |
| 源区块被删除 | `stale` / `deleted` | 复核 |
| 源区块可能被移动（与写入映射时的区块顺序比较，见下） | `stale` / `moved` | 复核 |
| 换源 | `stale` / `source_changed` | 复核 |
| 源条目被删除 | `stale` / `source_removed` | 复核（映射保留为复核记录） |

过期标记只会被加强（`changed` → `moved` → `deleted`），只有人确认后才清除。
**移动判定**：每次写入或确认映射时记录源字段的区块顺序（基线）；之后取基线与当前顺序共有的区块求最长递增子序列，
只有出现在**所有**最长递增子序列中的已映射区块才视为未移动（例如 `[A,B,C] → [A,C,B]` 且只有 B 有映射时，B 进入复核）；在前面插入新区块不会让其他区块被判为移动。

## 人工编辑标记

- 译文条目被写入时，在同一事务内比较各已映射区块写入前后的哈希：由**人**写入且有变化 → `human_edited = true`。
- Agent、API Key 与共享字段同步的写入不设置、也**不清除**该标记；标记只在人确认译文（见下）时清除。
- 周期核对发现译文区块与记录的哈希不同而没有写入记录时，同样视为人工编辑（宁可复核）。

## 增量重译候选

`GET /api/v1/translations/:collection/:id/retranslate`（只读，调用者须能读该译文）：

- `candidates`：过期、原因为 `changed` 且未被人工编辑的区块——可交给自动重译；
- `review`：其余过期区块（人工编辑过、删除、移动、换源等），附原因与人工编辑标记，由人处理。

## 确认译文

译文复核完成后，能编辑该译文的**人**调用 `POST /api/v1/translation-groups/:id/block-map/accept` `{ targetItemId, expectedTargetVersion, keys? }`：
以所见版本把映射的两侧哈希更新为当前值，清除过期与人工编辑标记，重记基线，并写审计 `translation_blocks_accepted`。

## 周期核对

调度器每 15 分钟对每个站点执行一次核对（变更事件丢失时也能发现过期）：按批次遍历全站的源条目与译文，重新判断源侧，发现目标侧漂移则记为人工编辑；**不清除任何标记**。
判定与换源、成员变化按同一锁顺序串行，较早的判定不会把较强的过期原因改回较弱的。

## SEO 字段与新建译文

- 源条目的 SEO 标题、描述与社交图片各是一个伪区块，与正文区块一样参与过期判断：只改 SEO 描述时，只有译文的 `seo_description#$` 过期，正文不受影响。
- 新建译文草稿：`POST /api/v1/translation-groups/:id/drafts` `{ locale }`（在当前站点、与源条目同名的集合中创建，加入翻译组）。
  复制源条目的 SEO 标题、描述、社交图片与收录设置（`seo_robots`），**不复制 `canonical_url`**（为空，即每个语言版本默认以自身 URL 为 canonical）；
  标题与 slug 先取源条目的值（待翻译）；并为复制的 SEO 伪区块建立映射，之后源条目的 SEO 变化会标记过期。创建、加入翻译组与建映射在同一事务内完成，任一步失败都不会留下草稿。

## 翻译状态

`GET /api/v1/items/:collection/:id/translation-status` 按站点的每个可用语言返回状态，由系统计算，不能手工设置：

| 状态 | 条件（该语言的翻译组成员） |
|---|---|
| `published` | 有已发布成员，且其映射没有过期 |
| `stale` | 有已发布成员，其映射有过期 |
| `in_review` | 无已发布成员，有处于审核中、已批准或已排期的成员 |
| `draft` | 只有草稿成员 |
| `missing` | 没有成员 |

响应同时给出调用者可读的每个成员及其状态（`members`）。已删除的成员不计。调用者无权读取的其他站点成员，只在其公开且双方开启跨站开关时计为“已发布”。Studio 条目编辑页“Translation group”面板顶部显示各语言状态。

## 生命周期

- 移出成员：以它为目标或来源的映射及其基线一并删除；删除（软删除）译文条目时删除以它为目标的映射，删除源条目时映射保留并标为 `source_removed` 供复核；
- 仅内部的源条目同样是新鲜度的比对基准（它不公开，但参与映射）。

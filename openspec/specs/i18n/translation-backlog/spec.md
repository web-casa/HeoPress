# i18n/translation-backlog Specification

## Purpose
让运营者在一个列表里看到"哪些已上线内容还缺哪种语言"，并按状态（缺失、过期、待审）分栏处理，而不是逐条打开条目
查看翻译状态。列表按集合与目标语言过滤，返回各状态计数与条目所属的翻译组，使"从缺失项创建译文"可以在同一页完成；
草稿与已删除条目不进入列表，其他站点的条目也不出现。

## Requirements

### Requirement: 按集合与语言的待办列表
系统 SHALL 提供按集合与目标语言列出待翻译已发布条目的接口，状态为 `missing`、`stale` 或 `in_review`，
并 SHALL 返回每个状态的计数、条目的所属翻译组与单页截断标记。

#### Scenario: 某语言缺失
- **WHEN** 集合中一个已发布条目在该目标语言下没有成员
- **THEN** 它出现在列表中，状态为 `missing`，且计数包含它

#### Scenario: 翻译过期
- **WHEN** 该语言的译文已发布，但源条目修改后有区块映射变为过期
- **THEN** 它出现在列表中，状态为 `stale`

#### Scenario: 翻译待审
- **WHEN** 该语言的译文处于待审状态
- **THEN** 它出现在列表中，状态为 `in_review`

### Requirement: 只列已发布条目
列表 SHALL 只包含已发布且未删除的条目；草稿与已删除条目 MUST NOT 出现。

#### Scenario: 草稿不出现
- **WHEN** 集合中有一个草稿条目在某语言下缺失
- **THEN** 它不在列表中

### Requirement: 站点范围
列表 SHALL 只包含调用方所在站点的条目；其他站点的条目 MUST NOT 出现。

#### Scenario: 他站调用者
- **WHEN** 站点 B 的调用者请求站点 A 集合的待办
- **THEN** 结果中不含站点 A 的条目

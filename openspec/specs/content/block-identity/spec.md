# content/block-identity Specification

## Purpose
让富文本与区块内容中的每个区块拥有稳定标识，使 AI 修改能精确定位到区块，翻译能按区块对齐与增量更新。

## Requirements

### Requirement: 区块稳定 ID
内容中的每个区块 SHALL 拥有在后续编辑中保持不变的 ID。新建区块 SHALL 获得新 ID；复制出的区块 MUST 获得与原区块不同的 ID。

#### Scenario: 编辑区块文字
- **WHEN** 用户修改某个段落区块的文字并保存
- **THEN** 该区块的 ID 与保存前相同

#### Scenario: 复制区块
- **WHEN** 用户复制一个区块并保存
- **THEN** 新区块的 ID 与原区块不同

### Requirement: 按区块定位修改
内容写入接口 SHALL 支持按区块 ID 修改单个区块，并遵守条件更新的版本规则。

#### Scenario: Agent 修改单个区块
- **WHEN** Agent 携带正确版本，按区块 ID 替换一个段落的文字
- **THEN** 只有该区块变化，其他区块与其 ID 保持不变

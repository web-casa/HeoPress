# platform/event-consumption Specification

## Purpose
为所有依赖内容变更事件的下游处理提供统一、可靠的消费方式，使后续 phase 的缓存失效、译文新鲜度、IndexNow、Git 快照等消费者直接基于同一框架实现。

## Requirements

### Requirement: 至少一次且幂等
每个事件消费者 SHALL 拥有独立游标，按顺序处理事件；处理中断后 SHALL 从游标继续。同一事件被重复投递时，消费者 MUST 使用幂等键或状态对账避免重复有效副作用；无法确认的外部副作用 SHALL 暂停并等待人工确认。

#### Scenario: 处理中途崩溃
- **WHEN** 一个消费者在处理一批事件时进程崩溃并重启
- **THEN** 未完成的事件被重新处理，已完成的事件不会产生第二次副作用

### Requirement: 重试与死信
处理失败的事件 SHALL 按退避策略重试；超过重试上限的事件 SHALL 进入该消费者的死信，且 MUST NOT 阻塞后续事件的处理。

#### Scenario: 持续失败的事件
- **WHEN** 某个事件连续处理失败达到重试上限
- **THEN** 该事件进入死信，消费者继续处理之后的事件

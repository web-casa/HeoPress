# 通知

HeoPress 用两条通道把需要人及时处理的事件送到运营者面前（P10 任务 5.2、5.5、5.6）：

- **后台站内通知**：在线的后台会话即时收到；
- **IM / Webhook 通道**：企业微信、飞书、钉钉、Telegram 与带签名的通用 Webhook。

事件来源：Agent 审批请求、否决窗口（L3 暂存待自动提交）、Agent 事故、模型预算与采集服务预算告警、目标与运行状态。

## 后台站内通知

Agent 事件发生后，CMS 经 Node 实时服务（`/api/v1/realtime`）向**本站**的站点管理员会话推送一帧：

```json
{ "type": "notification", "payload": { "source": "agent", "notification": {
  "id": "…", "kind": "approval", "severity": "info", "title": "Approval requested",
  "body": "…", "deepLink": "/mission-control/inbox?entry=approval:…", "entityId": "…", "ts": "2026-10-27T08:00:00.000Z" } } }
```

- 实时服务按站点隔离；只有签名票据中带 `studio:agent-notifications` 通道的会话（站点管理员，Mission Control 收件箱本身只对管理员开放）收到这类帧，其他站点与普通编辑的会话收不到。
- Studio 收到后弹出提示、加入铃铛中的通知列表，并立即刷新 Mission Control 收件箱。离线期间的事件仍由收件箱每 60 秒的轮询补上。
- `kind` 取值：`approval`、`veto`、`incident`、`goal`、`run`、`test`；`severity`：`info`、`warning`、`critical`。`deepLink` 只接受后台相对路径。

## IM / Webhook 通道

在 **设置 › 通知**（`/settings/notifications`，仅站点管理员）添加通道，选择平台、填写目标并勾选要接收的事件（审批、否决窗口、事故、预算告警、目标、Agent 运行）。接口为 `/api/v1/notification-channels`（控制面路径，只有站点管理员可用）。

| 平台 | 目标 | 签名 |
|---|---|---|
| 企业微信 | 群机器人 Webhook 地址（`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…`） | 无（密钥在地址中） |
| 飞书 | 自定义机器人 Webhook 地址 | 可选：填写签名密钥后按飞书规则在消息体中带 `timestamp` 与 `sign` |
| 钉钉 | 群机器人 Webhook 地址（含 `access_token`） | 可选：加签密钥，查询参数中带 `timestamp` 与 `sign` |
| Telegram | 机器人令牌与会话 ID | 无；令牌在路径中，因此不跟随任何重定向 |
| 通用 Webhook | 任意 https 地址 | 可选：`X-HeoPress-Signature: sha256=<hex>`，`hex = HMAC_SHA256(密钥, "<X-HeoPress-Timestamp>.<请求体>")`，与安全事件 Webhook 相同 |

通用 Webhook 请求体：

```json
{ "id": "<投递 id，可用于去重>", "event": "veto", "title": "Veto window open", "severity": "warning",
  "site": "Example News", "link": "https://cms.example.com/console/mission-control/inbox?entry=veto:…", "ts": "2026-10-27T08:00:00.000Z" }
```

### 消息内容

消息**只**包含事件标题、严重程度、站点名与指向后台的链接，不包含文章正文、事件详情、密钥或令牌。

链接前缀按通道配置的“后台链接前缀”，未填写时用实例的 `HEOPRESS_PUBLIC_URL`。后台入口路径是私密配置，不会自动写入消息；需要链接直接打开后台时，在前缀中自行填写（例如 `https://cms.example.com/console`），并意识到它会出现在第三方 IM 平台中。

### 安全

- 目标（地址、签名密钥、机器人令牌）用实例密钥（`ENCRYPTION_KEY`，见 [加密密钥](../../en/operations/encryption-keys.md)）加密保存，与通道 id 绑定；接口只返回目标主机名，日志、审计与投递记录中都不出现目标或密钥。
- 接口只接受 https 地址；每次发送都经过统一出站安全边界：私有、回环、链路本地与云元数据地址在连接时被拒绝，重定向的每一跳都重新检查。被拒绝的投递立即标记失败（`blocked`）。
- 通道的增删改与最终失败都写入审计日志（`notification_channel_*`、`notification_delivery_failed`）。

### 投递与重试

- 事件发生时，为每个启用且订阅了该事件的通道写一条投递记录（预算告警与触发它的操作在同一事务中写入）；Agent 事件写入后立即尝试发送一次。
- 定时任务 `notification-deliveries` 每 15 秒发送到期的投递。失败（5xx、429、平台错误码、网络错误、超时）按 30 秒 × 2^(n−1) 退避，最长 1 小时，最多 6 次；4xx 或被出站边界拒绝视为永久失败，不再重试。
- 通知失败从不阻塞或回滚触发它的业务操作。
- 设置页显示每个通道的已发送 / 待发送 / 失败数量与最近投递；“发送测试”立即发送一条测试消息（只尝试一次）。

## 待验证

千问办公（Qwen Office）自定义 MCP 客户端的实测需要真实平台账号，尚未完成；结果将写入 P10 交接记录。

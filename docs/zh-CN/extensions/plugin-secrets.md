---
version: 1
lastUpdated: 2026-11-10T22:18:00.000Z
sourceLang: zh-CN
contentHash: f23c67fff3c7a090
---

# 插件密钥（`secrets:<name>`）

插件不能读环境变量，也不能读站点的模型密钥。它要调用外部 API 时，只能在清单里声明
`secrets:<name>`，在运行时用 `ctx.secrets.get('<name>')` 读取；值由**站点管理员**在宿主里录入，
属于「本站点 + 本插件 + 这个名称」。这篇文档面向运营者：在哪里配置、值如何保存、什么时候会失效，
以及审计里能看到什么。

实现分别在 `apps/cms/src/services/plugin-secrets-service.ts`（存储与解析）、
`apps/cms/src/routes/extensions.ts`（管理 API）与 `apps/cms/src/extensions/runtime/plugin-host.ts`
（插件运行时接线）。

## 什么时候需要配置

插件清单的 `capabilities` 里出现 `secrets:<name>`，就说明它要一个命名密钥。例如官方 DeepL 插件：

```json
{
  "capabilities": ["ext:translation-services", "http:fetch:api.deepl.com", "secrets:deepl_api_key"]
}
```

没配置时插件仍能安装、批准和启用，但读取会得到「没有这个密钥」：DeepL 插件以 `DEEPL_NO_API_KEY`
失败，且**不会**发出任何请求，也不会静默改用别的翻译方式。

## 在 Studio 配置

1. 以站点管理员身份进入 **设置 › 扩展**。
2. 找到声明了密钥的插件（卡片的权限列表里有 `secrets:<名称>`），下方会显示「密钥」区块。
3. 每一行是清单声明的名称与「已配置 / 未配置」。点「设置」或「替换」，粘贴值并保存。
4. 保存成功后输入框清空，状态变为「已配置」。值**不会再显示**，也不能从界面读回。
5. 需要作废时点删除图标并确认；该名称回到「未配置」。

同一名称再保存一次就是**轮换**：旧值被覆盖，数据库里始终只有一行。

## 通过 API 配置

三个端点都要求站点管理员，并沿用 `extensions` 的 `read` / `update` / `delete` 权限。
下面用 `$CMS_URL`、`$TOKEN`、`$SITE_ID`、`$EXTENSION_ID` 代表部署地址、会话令牌、站点与扩展行 id：

```bash
# 名称与「已配置」状态；响应里没有值
curl -sS "$CMS_URL/api/v1/extensions/$EXTENSION_ID/secrets" \
  -H "Authorization: Bearer $TOKEN" -H "X-HeoPress-Site: $SITE_ID"

# 设置或轮换一个值
curl -sS -X PUT "$CMS_URL/api/v1/extensions/$EXTENSION_ID/secrets/deepl_api_key" \
  -H "Authorization: Bearer $TOKEN" -H "X-HeoPress-Site: $SITE_ID" \
  -H 'content-type: application/json' \
  --data '{"value":"<你的 DeepL API key>"}'

# 删除
curl -sS -X DELETE "$CMS_URL/api/v1/extensions/$EXTENSION_ID/secrets/deepl_api_key" \
  -H "Authorization: Bearer $TOKEN" -H "X-HeoPress-Site: $SITE_ID"
```

列表返回 `{ "name": "...", "configured": true, "declared": true }`。`declared` 为 `false`
表示这个名称是以前存下的、清单已不再声明——它仍会列出，方便你删除。任何响应都不会包含值、值的前缀/后缀
或密文。

## 值如何保存

- 值用运行时 KEK 的 AES-GCM 信封加密后存进 `lumibase_plugin_secrets` 的 `secret_ciphertext`
  （格式 `{keyId}:{base64(iv|ciphertext)}`），明文不落库。
- AAD 是 `plugin-secret|<站点 id>|<插件名>|<密钥名>`。因此把一行密文复制到另一个站点或另一个插件下
  **解不开**：解密在 AES-GCM 校验阶段失败，宿主不会返回任何值。
- `key_id` 另存一份便于运维核对；解密以信封里的版本为准，KEK 轮换后旧值仍能打开（只要旧密钥还在）。
- 设置人（`set_by_user_id`）与创建/更新时间一起保存；以 API key 或系统身份写入时设置人为空。

## 运行时读到什么

`PluginHost` 为每个插件的默认沙箱提供一个解析器，按**本次加载的站点**和**插件名**查询；沙箱再按
`secrets:<name>` 能力放行，所以插件只能读到自己声明且已批准的名称。

| 情况 | 插件看到的 |
|---|---|
| 已配置且可解密 | 值 |
| 该站点/插件没有配置这个名称 | `null`（插件的「未配置」失败） |
| 有记录但解不开（搬错行、KEK 已退役） | 抛错（失败关闭，不会被当成「未配置」） |
| 没有声明/未批准该能力 | 沙箱拒绝，写一条 `extension_capability_denied` 审计 |

为什么把「解不开」和「未配置」分开：前者说明数据被搬动或密钥缺失，需要运维排查；把它伪装成 `null`
会让人反复重配而无视真正的问题。

## 审计

每次成功的设置/轮换与删除都写一条审计：

| 事件 | 元数据 |
|---|---|
| `plugin_secret_set` | `{ siteId, extensionName, secretName }` |
| `plugin_secret_deleted` | `{ siteId, extensionName, secretName }` |

`actorEmail` 是操作者。元数据里**没有值**，审计查询、导出与日志都不会出现它。删除一个本来就没配置的
名称不写审计（没有发生写入）。

## 限制（有意为之）

- **没有过期、自动轮换或使用提醒**：轮换就是同名再保存一次。
- **没有按环境划分**：一个站点一个值；开发/预发/生产不分开。多环境请用不同站点。
- **不能跨站点共享**：密钥属于 `(站点, 插件, 名称)`；没有全局值或模板。
- **不改能力语法/契约版本**：`secrets:<name>` 的语法与审批模型不变；新增能力仍要改 `packages/contracts`。
- **非 `PluginHost` 的加载路径不接密钥**：hook dispatcher、`/:name/*` 端点 catch-all 与
  `PipelinePluginHost` 目前不提供 `ctx.secrets`（它们也没有 storage/settings 等宿主依赖）。
- **没有访问计数或泄漏检测**：只做加密存储与按作用域解析，不记录读取次数。

## 相关

- [插件翻译服务](translation-services.md) 与 [DeepL 翻译插件](translation-deepl.md)：`secrets:deepl_api_key`
  的实际使用者。
- [插件开发](plugin-development.md)：清单、能力与 `ctx.secrets` 的插件侧契约。

<!-- 本文件由 `pnpm docs:mcp-tools` 根据 apps/cms/src/services/agent-access/mcp-tool-catalog.ts 生成，请勿手改。 -->

# MCP 工具参考

端点：`POST /api/v1/agents/mcp`（Streamable HTTP，JSON-RPC 2.0）。认证与授权见 [MCP 授权](./mcp-authorization.md)。

| 工具 | 工具组 | 范围 | 类型 |
|---|---|---|---|
| `sites_list` | 只读 | 实例（`scope: { instance: true }`） | 只读 |
| `site_get` | 只读 | 单站（必填 `siteId`） | 只读 |
| `content_query` | 只读 | 单站（必填 `siteId`） | 只读 |
| `content_get` | 只读 | 单站（必填 `siteId`） | 只读 |
| `content_create` | 内容编辑 | 单站（必填 `siteId`） | 新建（必填 `idempotencyKey`，不要求版本） |
| `content_update` | 内容编辑 | 单站（必填 `siteId`） | 修改已有资源（必填 `expectedVersion`） |
| `content_publish` | 发布 | 单站（必填 `siteId`） | 修改已有资源（必填 `expectedVersion`） |
| `content_delete` | 内容编辑 | 单站（必填 `siteId`） | 仅计划（高危） |
| `media_upload_from_url` | 内容编辑 | 单站（必填 `siteId`） | 新建（必填 `idempotencyKey`，不要求版本） |
| `seo_audit_issues` | 只读 | 单站（必填 `siteId`） | 只读 |
| `seo_link_impact` | 只读 | 单站（必填 `siteId`） | 只读 |
| `translation_status` | 只读 | 单站（必填 `siteId`） | 只读 |
| `site_update_seo_settings` | 站点设置 | 单站（必填 `siteId`） | 修改已有资源（必填 `expectedVersion`） |
| `themes_list` | 只读 | 单站（必填 `siteId`） | 只读 |
| `theme_activate` | 主题 | 单站（必填 `siteId`） | 仅计划（高危） |
| `sites_create` | 站点设置 | 实例（`scope: { instance: true }`） | 新建（必填 `idempotencyKey`，不要求版本） |
| `plans_submit` | 只读 | 显式站点清单或实例（`scope.siteIds` / `scope.instance`，二选一） | 批量计划入口 |
| `plans_get` | 只读 | 计划（`scope: { planId }`） | 只读 |

## `sites_list`

列出本授权覆盖且当前仍有权限的站点；不会列出其他站点。

- 工具组：只读
- 范围：实例（`scope: { instance: true }`）
- 类型：只读

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "object",
      "description": "Instance scope: { \"instance\": true }.",
      "properties": {
        "instance": {
          "const": true
        }
      },
      "required": [
        "instance"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "scope"
  ],
  "additionalProperties": false
}
```

## `site_get`

读取一个站点的名称、默认语言与品牌设置。

- 工具组：只读
- 范围：单站（必填 `siteId`）
- 类型：只读

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    }
  },
  "required": [
    "siteId"
  ],
  "additionalProperties": false
}
```

## `content_query`

列出一个站点某个集合的条目，按你在该站点的权限过滤。

- 工具组：只读
- 范围：单站（必填 `siteId`）
- 类型：只读

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    },
    "collection": {
      "type": "string",
      "description": "Collection name, e.g. \"articles\"."
    },
    "filter": {
      "type": "object",
      "description": "Filter, e.g. { \"status\": { \"_eq\": \"draft\" } }."
    },
    "sort": {
      "type": "string",
      "description": "Comma-separated fields, \"-\" for descending."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    },
    "offset": {
      "type": "integer",
      "minimum": 0
    },
    "status": {
      "type": "string"
    }
  },
  "required": [
    "siteId",
    "collection"
  ],
  "additionalProperties": false
}
```

## `content_get`

读取一个条目及其版本号（修改时作为 expectedVersion 传回）。

- 工具组：只读
- 范围：单站（必填 `siteId`）
- 类型：只读

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    },
    "collection": {
      "type": "string",
      "description": "Collection name, e.g. \"articles\"."
    },
    "id": {
      "type": "string",
      "description": "Item id."
    }
  },
  "required": [
    "siteId",
    "collection",
    "id"
  ],
  "additionalProperties": false
}
```

## `content_create`

在一个站点新建草稿条目；必须带 idempotencyKey，不会发布。

- 工具组：内容编辑
- 范围：单站（必填 `siteId`）
- 类型：新建（必填 `idempotencyKey`，不要求版本）

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    },
    "collection": {
      "type": "string",
      "description": "Collection name, e.g. \"articles\"."
    },
    "data": {
      "type": "object",
      "description": "Field values."
    },
    "idempotencyKey": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255,
      "description": "Unique per intended create; retrying with the same key and arguments returns the first result."
    }
  },
  "required": [
    "siteId",
    "collection",
    "data",
    "idempotencyKey"
  ],
  "additionalProperties": false
}
```

## `content_update`

按读取时的版本修改一个站点上一个条目的字段；不改变发布状态。

- 工具组：内容编辑
- 范围：单站（必填 `siteId`）
- 类型：修改已有资源（必填 `expectedVersion`）

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    },
    "collection": {
      "type": "string",
      "description": "Collection name, e.g. \"articles\"."
    },
    "id": {
      "type": "string",
      "description": "Item id."
    },
    "expectedVersion": {
      "type": "integer",
      "minimum": 1,
      "description": "The version you read; a stale version is a conflict."
    },
    "data": {
      "type": "object",
      "description": "Changed field values."
    }
  },
  "required": [
    "siteId",
    "collection",
    "id",
    "expectedVersion",
    "data"
  ],
  "additionalProperties": false
}
```

## `content_publish`

按读取时的版本发布一个站点上的一个条目；Hold 与发布检查照常生效。

- 工具组：发布
- 范围：单站（必填 `siteId`）
- 类型：修改已有资源（必填 `expectedVersion`）

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    },
    "collection": {
      "type": "string",
      "description": "Collection name, e.g. \"articles\"."
    },
    "id": {
      "type": "string",
      "description": "Item id."
    },
    "expectedVersion": {
      "type": "integer",
      "minimum": 1,
      "description": "The version you read; a stale version is a conflict."
    }
  },
  "required": [
    "siteId",
    "collection",
    "id",
    "expectedVersion"
  ],
  "additionalProperties": false
}
```

## `content_delete`

删除属于高危操作：本工具从不直接删除，返回 PLAN_REQUIRED，请用 plans_submit 提交计划。

- 工具组：内容编辑
- 范围：单站（必填 `siteId`）
- 类型：仅计划（高危，直接调用返回 `PLAN_REQUIRED`）

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    },
    "collection": {
      "type": "string",
      "description": "Collection name, e.g. \"articles\"."
    },
    "id": {
      "type": "string",
      "description": "Item id."
    },
    "expectedVersion": {
      "type": "integer",
      "minimum": 1,
      "description": "The version you read; a stale version is a conflict."
    }
  },
  "required": [
    "siteId",
    "collection",
    "id",
    "expectedVersion"
  ],
  "additionalProperties": false
}
```

## `media_upload_from_url`

从站点白名单中的主机抓取图片（经 SSRF 防护）并存入该站点。

- 工具组：内容编辑
- 范围：单站（必填 `siteId`）
- 类型：新建（必填 `idempotencyKey`，不要求版本）

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    },
    "url": {
      "type": "string",
      "format": "uri",
      "description": "https URL of the image."
    },
    "idempotencyKey": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255,
      "description": "Unique per intended create; retrying with the same key and arguments returns the first result."
    }
  },
  "required": [
    "siteId",
    "url",
    "idempotencyKey"
  ],
  "additionalProperties": false
}
```

## `seo_audit_issues`

站点审计问题清单，与后台审计页对你显示的内容一致。

- 工具组：只读
- 范围：单站（必填 `siteId`）
- 类型：只读

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    }
  },
  "required": [
    "siteId"
  ],
  "additionalProperties": false
}
```

## `seo_link_impact`

条目下线、删除或移动时可能受影响的页面（来自链接图）。

- 工具组：只读
- 范围：单站（必填 `siteId`）
- 类型：只读

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    },
    "itemId": {
      "type": "string",
      "description": "Item id."
    },
    "depth": {
      "type": "integer",
      "minimum": 1,
      "maximum": 2
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    }
  },
  "required": [
    "siteId",
    "itemId"
  ],
  "additionalProperties": false
}
```

## `translation_status`

条目在站点各语言下的翻译状态（缺失、过期、最新）。

- 工具组：只读
- 范围：单站（必填 `siteId`）
- 类型：只读

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    },
    "collection": {
      "type": "string",
      "description": "Collection name, e.g. \"articles\"."
    },
    "id": {
      "type": "string",
      "description": "Item id."
    }
  },
  "required": [
    "siteId",
    "collection",
    "id"
  ],
  "additionalProperties": false
}
```

## `site_update_seo_settings`

按读取时的版本修改一个站点的 SEO / GEO 设置（站点管理员）。

- 工具组：站点设置
- 范围：单站（必填 `siteId`）
- 类型：修改已有资源（必填 `expectedVersion`）

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    },
    "expectedVersion": {
      "type": "integer",
      "minimum": 1,
      "description": "The version you read; a stale version is a conflict."
    },
    "settings": {
      "type": "object",
      "description": "The settings to change."
    }
  },
  "required": [
    "siteId",
    "expectedVersion",
    "settings"
  ],
  "additionalProperties": false
}
```

## `themes_list`

站点的主题及其版本。

- 工具组：只读
- 范围：单站（必填 `siteId`）
- 类型：只读

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    }
  },
  "required": [
    "siteId"
  ],
  "additionalProperties": false
}
```

## `theme_activate`

全站主题发布属于高危操作：本工具返回 PLAN_REQUIRED，请用 plans_submit 提交计划。

- 工具组：主题
- 范围：单站（必填 `siteId`）
- 类型：仅计划（高危，直接调用返回 `PLAN_REQUIRED`）

```json
{
  "type": "object",
  "properties": {
    "siteId": {
      "type": "string",
      "description": "The one site this call acts on. Required; there is no default site."
    },
    "themeVersionId": {
      "type": "string"
    },
    "expectedVersion": {
      "type": "integer",
      "minimum": 1,
      "description": "The version you read; a stale version is a conflict."
    }
  },
  "required": [
    "siteId",
    "themeVersionId",
    "expectedVersion"
  ],
  "additionalProperties": false
}
```

## `sites_create`

新建站点（实例管理员）；需要实例范围与 idempotencyKey。新站点不会自动加入本授权。

- 工具组：站点设置
- 范围：实例（`scope: { instance: true }`）
- 类型：新建（必填 `idempotencyKey`，不要求版本）

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "object",
      "description": "Instance scope: { \"instance\": true }.",
      "properties": {
        "instance": {
          "const": true
        }
      },
      "required": [
        "instance"
      ],
      "additionalProperties": false
    },
    "id": {
      "type": "string",
      "description": "The new site id: lowercase letters, digits, \"-\" and \"_\"."
    },
    "name": {
      "type": "string"
    },
    "defaultLanguage": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255,
      "description": "Unique per intended create; retrying with the same key and arguments returns the first result."
    }
  },
  "required": [
    "scope",
    "id",
    "name",
    "idempotencyKey"
  ],
  "additionalProperties": false
}
```

## `plans_submit`

修改两个及以上站点或执行高危操作的唯一入口。范围被解析并固化为站点 ID 清单，由人在后台审批。（计划执行在后续版本提供；在此之前返回 PLAN_NOT_AVAILABLE 与解析后的范围。）

- 工具组：只读
- 范围：显式站点清单或实例（`scope.siteIds` / `scope.instance`，二选一）
- 类型：批量计划入口

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "object",
      "description": "Exactly one of { \"siteIds\": [...] } or { \"instance\": true } (every site this authorization covers).",
      "properties": {
        "siteIds": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "minItems": 1
        },
        "instance": {
          "const": true
        }
      },
      "additionalProperties": false
    },
    "operation": {
      "type": "string",
      "description": "The tool to run on each site, e.g. \"content_update\"."
    },
    "arguments": {
      "type": "object",
      "description": "Arguments for each site, without siteId."
    }
  },
  "required": [
    "scope",
    "operation"
  ],
  "additionalProperties": false
}
```

## `plans_get`

读取你提交的批量计划：状态与逐站结果。

- 工具组：只读
- 范围：计划（`scope: { planId }`）
- 类型：只读

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "object",
      "properties": {
        "planId": {
          "type": "string"
        }
      },
      "required": [
        "planId"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "scope"
  ],
  "additionalProperties": false
}
```

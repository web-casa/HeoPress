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
| `branch_create` | 内容编辑 | 单站（必填 `siteId`） | 新建（必填 `idempotencyKey`，不要求版本） |
| `branch_get` | 只读 | 单站（必填 `siteId`） | 只读 |
| `branch_update` | 内容编辑 | 单站（必填 `siteId`） | 修改已有资源（必填 `expectedVersion`） |
| `branch_diff` | 只读 | 单站（必填 `siteId`） | 只读 |
| `branch_merge` | 内容编辑 | 单站（必填 `siteId`） | 修改已有资源（必填 `expectedVersion`） |
| `media_upload_from_url` | 内容编辑 | 单站（必填 `siteId`） | 新建（必填 `idempotencyKey`，不要求版本） |
| `seo_audit_issues` | 只读 | 单站（必填 `siteId`） | 只读 |
| `seo_link_impact` | 只读 | 单站（必填 `siteId`） | 只读 |
| `translation_status` | 只读 | 单站（必填 `siteId`） | 只读 |
| `site_update_seo_settings` | 站点设置 | 单站（必填 `siteId`） | 修改已有资源（必填 `expectedVersion`） |
| `themes_list` | 只读 | 单站（必填 `siteId`） | 只读 |
| `theme_activate` | 主题 | 单站（必填 `siteId`） | 仅计划（高危） |
| `sites_create` | 站点设置 | 实例（`scope: { instance: true }`） | 新建（必填 `idempotencyKey`，不要求版本） |
| `plans_submit` | 只读 | 显式站点清单或实例（`scope.siteIds` / `scope.instance`，二选一） | 批量计划入口 |
| `plans_revise` | 只读 | 计划（`scope: { planId }`） | 批量计划入口 |
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

## `branch_create`

为一个条目创建内容分支：基于条目当前内容的私有副本，修改不会影响条目本身。必须带 idempotencyKey（同一键返回同一分支）；返回分支键与分支版本。

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
    "id": {
      "type": "string",
      "description": "Item id."
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200,
      "description": "A label people see in Studio."
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
    "id",
    "name",
    "idempotencyKey"
  ],
  "additionalProperties": false
}
```

## `branch_get`

读取分支：数据、分支版本（修改或合并时作为 expectedVersion）、状态及其基于的条目版本。

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
    },
    "branch": {
      "type": "string",
      "description": "The branch key."
    }
  },
  "required": [
    "siteId",
    "collection",
    "id",
    "branch"
  ],
  "additionalProperties": false
}
```

## `branch_update`

按读取时的分支版本（expectedVersion）修改分支中的字段；条目本身不变。

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
    "branch": {
      "type": "string",
      "description": "The branch key."
    },
    "expectedVersion": {
      "type": "integer",
      "minimum": 1,
      "description": "The branch revision you read."
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
    "branch",
    "expectedVersion",
    "data"
  ],
  "additionalProperties": false
}
```

## `branch_diff`

字段与区块级差异：分支改了什么、分支创建后条目本身改了什么，以及此刻合并会出现的冲突（两边改了同一字段或区块），并给出合并所需的版本号。

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
    },
    "branch": {
      "type": "string",
      "description": "The branch key."
    }
  },
  "required": [
    "siteId",
    "collection",
    "id",
    "branch"
  ],
  "additionalProperties": false
}
```

## `branch_merge`

合并分支与条目，同时校验两个版本：比较之后条目或分支又被修改即为冲突（MERGE_STALE）。不同字段或区块自动合并；两边修改同一字段或区块则失败并列出冲突（MERGE_CONFLICT），由人在后台选择。结果只是待发布修订，不会直接上线：由人提升，Hold 与发布检查照常生效。

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
    "branch": {
      "type": "string",
      "description": "The branch key."
    },
    "expectedVersion": {
      "type": "integer",
      "minimum": 1,
      "description": "The branch revision you compared."
    },
    "expectedMainVersion": {
      "type": "integer",
      "minimum": 1,
      "description": "The item version you compared against (branch_diff mainVersion)."
    }
  },
  "required": [
    "siteId",
    "collection",
    "id",
    "branch",
    "expectedVersion",
    "expectedMainVersion"
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

修改两个及以上站点或执行高危操作（content_delete、theme_activate）的唯一入口。范围被解析并固化为站点 ID 清单（之后新建的站点不会加入），并分级（>10 站预览、>25 站金丝雀、>50 站或高危为最高级），返回计划 ID 与哈希。只能由人在后台审批与执行，没有任何审批工具。可用操作：content_create、content_update、content_publish、content_delete、site_update_seo_settings、theme_activate。

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
      "description": "Arguments shared by every site, without siteId."
    },
    "perSite": {
      "type": "object",
      "description": "Per-site arguments keyed by site id, merged over `arguments`: the resource id and its expectedVersion (theme_activate: themeVersionId and expectedActiveVersionId).",
      "additionalProperties": {
        "type": "object"
      }
    }
  },
  "required": [
    "scope",
    "operation"
  ],
  "additionalProperties": false
}
```

## `plans_revise`

修改你提交且尚未开始执行的计划：站点（显式清单）、共享参数或逐站参数。计划哈希随之改变，此前的审批全部失效，须由人重新审批。

- 工具组：只读
- 范围：计划（`scope: { planId }`）
- 类型：批量计划入口

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
    },
    "siteIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "description": "The new, complete site list."
    },
    "arguments": {
      "type": "object"
    },
    "perSite": {
      "type": "object",
      "additionalProperties": {
        "type": "object"
      }
    }
  },
  "required": [
    "scope"
  ],
  "additionalProperties": false
}
```

## `plans_get`

读取你提交的批量计划：状态、风险等级、审批情况与逐站结果（成功、冲突、无权限、失败、已取消）。

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

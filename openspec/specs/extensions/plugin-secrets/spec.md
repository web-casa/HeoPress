# extensions/plugin-secrets Specification

## Purpose
定义站点级「插件密钥」：一个插件在清单里按名称声明 `secrets:<name>`，站点管理员在宿主里为
「本站点 + 本插件 + 该名称」录入一次值；值以现有的信封加密落库，AAD 绑定这个三元组；插件运行时只经
`ctx.secrets.get('<name>')` 读取自己声明且已批准的密钥。管理 API 只回名称与是否已配置，值 MUST NOT 出现在
任何响应、日志或审计里。规格同时规定 Studio 的配置面与缺失/无法解密时的可观察行为。

能力语法（`secrets:<name>`）、审批模型、沙箱边界与既有扩展点契约版本都不变；本规格只增加密钥从录入到解析的
可观察行为。

## Requirements

### Requirement: 密钥的加密存储与作用域绑定

宿主 SHALL 为每个 `(站点, 插件名, 密钥名)` 保存至多一行密钥记录，值是经现有信封加密（AES-GCM + 密钥版本）
的密文，AAD SHALL 绑定站点 id、插件名与密钥名三者。记录 SHALL 带设置人与创建/更新时间。
同一个三元组再次设置 SHALL 轮换该行（覆盖密文与时间），MUST NOT 留下第二行或旧密文。明文 MUST NOT 被持久化、
写入日志、写入审计元数据或由任何 API 返回。

#### Scenario: 加密落库且可轮换

- **WHEN** 管理员为站点 A 的插件 `acme-deepl` 的 `deepl_api_key` 设置值 V1，之后又设置 V2
- **THEN** 表里只有一行该三元组，密文随第二次设置变化，且用同一三元组可以解出 V2（不是 V1）

#### Scenario: 密文不能跨插件或跨站点使用

- **WHEN** 把站点 A、插件 `acme-deepl` 的 `deepl_api_key` 密文行改到站点 B（或插件 `acme-other`）的同一名称下再解析
- **THEN** 解密失败，宿主不返回任何值，也不把失败伪装成「未配置」

### Requirement: 站点管理员的密钥管理 API

站点管理员 SHALL 能列出、设置/替换与删除一个插件的密钥。列表 MUST 只返回清单声明的名称、是否已配置，
以及该名称是否仍被清单声明；MUST NOT 返回值、值的前缀/后缀、密文或任何可以还原值的信息。
设置与删除 MUST NOT 返回值。非管理员 MUST 被拒绝；通过 `extensions:read` / `extensions:write` 权限检查的
行为与扩展管理的既有权限模型一致。每次成功的写入 SHALL 写一条审计事件，元数据只含站点、插件名与密钥名，
MUST NOT 含值。

#### Scenario: 列表只显示名称与已配置

- **WHEN** 管理员为 `deepl_api_key` 设置了一个值后读取列表
- **THEN** 响应里该名称的 `configured` 为 `true`，响应中不出现该值本身，也不出现它的任何片段

#### Scenario: 非管理员被拒绝

- **WHEN** 一个没有管理员角色的站点成员调用任意密钥管理端点
- **THEN** 请求以 403 拒绝，密钥没有被读取、写入或删除

#### Scenario: 审计只记录名称

- **WHEN** 管理员设置再删除一个密钥
- **THEN** 审计里出现设置与删除两条事件，元数据只有站点、插件名与密钥名，没有值

### Requirement: 运行时按站点与插件解析

`PluginHost` 构造的默认沙箱 SHALL 提供一个密钥解析器，按**本次加载的站点**与**插件名**查询存储，
并且只在插件持有对应的 `secrets:<name>` 能力时由沙箱放行。名称没有配置时解析器 SHALL 返回 `null`，
插件按既有契约得到「没有可用密钥」；记录存在但无法解密时 MUST 失败关闭（抛错），MUST NOT 返回 `null` 或空值。
宿主没有可用的加密密钥时 MUST 视为「密钥功能不可用」，而不是把明文直存或跳过加密。

#### Scenario: 已配置的密钥经沙箱可读

- **WHEN** 站点 A 的插件声明并获批 `secrets:deepl_api_key`，管理员配置了值，插件在运行时调用
  `ctx.secrets.get('deepl_api_key')`
- **THEN** 插件拿到该值，不需要任何测试专用注入

#### Scenario: 未配置时是类型化失败

- **WHEN** 同一插件没有配置该名称，或在另一个站点运行
- **THEN** `ctx.secrets.get` 得到 `null`，DeepL 插件以 `DEEPL_NO_API_KEY` 失败且不发任何请求

### Requirement: Studio 的密钥配置面

Studio SHALL 在插件的管理视图中列出清单声明的 `secrets:<name>` 与「已配置 / 未配置」，并提供设置/替换与删除动作。
表单 SHALL 使用密码输入且不回填已有值；保存成功后 MUST 清空输入。界面 MUST NOT 显示值、值的前缀/后缀或密文。
文案 SHALL 同时提供 en 与 zh-CN。

#### Scenario: 声明了密钥的插件显示配置状态

- **WHEN** 一个声明 `secrets:deepl_api_key` 的插件未配置密钥
- **THEN** 详情里显示 `deepl_api_key` 与「未配置」，并可以输入一个值保存

#### Scenario: 保存后不回显

- **WHEN** 运营者输入一个值并保存成功
- **THEN** 列表显示「已配置」，输入框清空，页面上不出现该值的任何部分

### Requirement: 运维文档说明

仓库 SHALL 提供中文运营者文档，说明如何为插件配置密钥、值加密落库且不再显示、轮换与删除、
缺失密钥时插件的失败语义与审计记录的内容；DeepL 插件 README 的「生产密钥配置」限制 SHALL 更新为现状。

#### Scenario: 文档与实现一致

- **WHEN** 运营者按文档在 Studio 配置 DeepL 的 `deepl_api_key` 并启用、选中该服务
- **THEN** 文档描述的位置、字段与行为与实现一致，且不再声明「宿主没有密钥录入或加密存储」

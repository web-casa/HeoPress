# rendering/static-directory-mount Specification

## Purpose
让站点在 HeoPress 内容之外挂载一个静态目录：网页存档复原或脚本生成的页面原样提供，新文章继续由 HeoPress 管理。
挂载是站点设置，受运维根目录约束；挂载文件绝不能遮蔽 HeoPress 的条目、插件路由与系统文件，
也不能借路径编码或符号链接逃出目录。

## Requirements

### Requirement: 站点级静态目录设置
站点 SHALL 有一个静态目录设置（绝对路径，空值表示未挂载），只有站点管理员可以修改，读写都在该站点的范围内。
保存时 SHALL 校验目录存在、是目录、可读，并且 `realpath` 后位于运维配置的根目录 `HEOPRESS_STATIC_ROOT` 之内；
不在根内、根未配置或路径非法时 MUST 拒绝保存并返回明确错误。设置 SHALL 有版本号，陈旧表单 MUST 返回 409 而不是覆盖。
保存的值 SHALL 是解析符号链接后的绝对路径。

#### Scenario: 根目录之外的路径
- **WHEN** 管理员把 `/etc` 或根目录之外的绝对路径保存为站点静态目录
- **THEN** 保存被拒绝，错误说明路径必须在 `HEOPRESS_STATIC_ROOT` 之下，站点设置不变

#### Scenario: 根目录未配置
- **WHEN** 实例没有配置 `HEOPRESS_STATIC_ROOT`，管理员保存一个非空目录
- **THEN** 保存被拒绝并说明运维必须先配置根目录

#### Scenario: 目录不存在或不可读
- **WHEN** 保存的路径不存在、不是目录或不可读
- **THEN** 保存被拒绝并说明具体原因，站点设置不变

#### Scenario: 取消挂载
- **WHEN** 管理员把设置保存为空字符串
- **THEN** 该站点不再从静态目录提供任何文件，既有 HeoPress 页面不受影响

#### Scenario: 站点隔离
- **WHEN** 站点 A 设置了静态目录，站点 B 没有
- **THEN** 只有 A 的域名会从该目录提供文件，B 对同一路径仍返回 404

#### Scenario: 版本冲突
- **WHEN** 两个管理员基于同一版本提交不同的目录，第二个提交
- **THEN** 第二个提交返回 409，最终保存的是第一个提交的值

### Requirement: 未匹配路径的回退
Classic 渲染服务 SHALL 在没有任何 HeoPress 路由或系统文件匹配请求路径时，从站点的静态目录提供对应文件；
挂载目录为空时行为 MUST 与未实现该能力时完全相同。文件不存在时 MUST 返回站点自己的 404。

#### Scenario: 存档页面
- **WHEN** 站点挂载了含 `/legacy/about.html` 的目录，请求该路径
- **THEN** 返回该文件的内容与 200，HeoPress 的条目路由不受影响

#### Scenario: 目录索引
- **WHEN** 请求的路径对应挂载目录中的一个目录，且其中有 `index.html`
- **THEN** 以 `/` 结尾的路径返回该 `index.html`；不带斜杠的路径返回 301 到带斜杠的地址

#### Scenario: 文件不存在
- **WHEN** 挂载目录中没有请求的文件
- **THEN** 返回站点自己的 404 页面，且该 404 不被缓存

### Requirement: 挂载不得遮蔽 HeoPress 路径
挂载文件 MUST NOT 覆盖任何 HeoPress 路径。条目、插件路由、系统文件（`/robots.txt`、`/sitemap*.xml`、`/.well-known/**`、
`/health/*`、`/sitemap.txt`、feed、`llms.txt`、根文件、插件端点 `/_ext/*`、主题资源 `/_theme/*`）以及后台路径
（`/admin`、`/api`、`/internal`）SHALL 始终由 HeoPress 或边缘回答，即使挂载目录中存在同名文件。

#### Scenario: 条目路由优先
- **WHEN** 挂载目录含 `/hello/index.html`，同时站点已发布路径为 `/hello` 的条目
- **THEN** 请求 `/hello` 返回 HeoPress 条目页面，挂载文件不被读取

#### Scenario: 插件路由优先
- **WHEN** 挂载目录含插件列表路由的同名路径，且该插件路由存在
- **THEN** 请求该路径返回插件路由的页面

#### Scenario: robots.txt 优先
- **WHEN** 挂载目录含 `robots.txt`，请求 `/robots.txt`
- **THEN** 返回 HeoPress 生成的 robots.txt，而不是挂载文件

#### Scenario: sitemap 优先
- **WHEN** 挂载目录含 `sitemap.xml`，请求 `/sitemap.xml`
- **THEN** 返回 HeoPress 生成的 sitemap，挂载文件不被读取

#### Scenario: .well-known 优先
- **WHEN** 挂载目录含 `.well-known/security.txt`，请求该路径
- **THEN** 由 HeoPress 的系统路径规则回答（站点有该根文件时返回它，否则 404），不返回挂载文件

#### Scenario: 健康检查与插件端点
- **WHEN** 挂载目录含 `/health/index.html` 或 `/_ext/plugin/endpoint`
- **THEN** 请求这些路径不会被挂载目录回答

### Requirement: 路径安全
静态目录的路径解析 MUST 拒绝路径穿越：解码一次与两次（双重编码）后出现 `..` 或 `.` 段的请求 MUST 被拒绝；
反斜杠、NUL、控制字符、编码斜杠与超长路径或段 MUST 被拒绝。解析结果（包括通过符号链接的解析）MUST 仍在挂载目录之内；
挂载目录内的符号链接 MUST NOT 被当作文件提供，遍历 MUST NOT 跟随符号链接。文件 MUST NOT 被执行或解释。

#### Scenario: 明文穿越
- **WHEN** 请求 `/../../etc/passwd` 或含 `..` 段的路径
- **THEN** 返回 404，不读取挂载目录之外的文件

#### Scenario: 编码穿越
- **WHEN** 请求 `/%2e%2e/%2e%2e/etc/passwd` 或 `/%252e%252e/%252e%252e/etc/passwd`
- **THEN** 返回 404，不读取挂载目录之外的文件

#### Scenario: 符号链接逃逸
- **WHEN** 挂载目录中的文件是指向目录之外的符号链接
- **THEN** 请求该路径返回 404，目标文件不能被读取

#### Scenario: 反斜杠与 NUL
- **WHEN** 请求路径含反斜杠、编码反斜杠或 NUL
- **THEN** 返回 404

### Requirement: 响应头与条件请求
挂载文件 SHALL 按扩展名返回正确的 `Content-Type`，并附 `X-Content-Type-Options: nosniff`。
HTML 文档 SHALL 使用短缓存（`public, max-age=0, must-revalidate`），静态资源 SHALL 使用长缓存并带 `immutable`，
其它文件 SHALL 使用短缓存。响应 MUST 带 `ETag` 与 `Last-Modified`；条件请求匹配时 MUST 返回 304，且 304 带同一组表示头。
挂载文件 MUST NOT 设置 `Vary`。

#### Scenario: HTML 与资源
- **WHEN** 请求挂载目录中的 `page.html` 与 `app.css`
- **THEN** 前者为 `text/html; charset=utf-8` 且短缓存，后者为 `text/css; charset=utf-8` 且一年 `immutable`

#### Scenario: 304
- **WHEN** 客户端带着上次响应的 `ETag` 再次请求未变化的文件
- **THEN** 返回 304，带相同的 `ETag`、`Content-Type` 与缓存头

#### Scenario: 未知扩展名
- **WHEN** 请求扩展名未知的文件
- **THEN** `Content-Type` 为 `application/octet-stream`，不猜测内容

### Requirement: sitemap 合并
站点的 sitemap SHALL 合并挂载目录中 `static-urls.txt` 声明的绝对路径（每行一个），并与 HeoPress 生成的 URL 去重。
文件缺失时 MUST NOT 合并、也 MUST NOT 失败。无效行 MUST 跳过并记录日志，sitemap 仍正常生成。
合并后的条目 SHALL 同时出现在 sitemap 索引、分片与 `sitemap.txt` 中。

#### Scenario: 合并声明 URL
- **WHEN** 挂载目录的 `static-urls.txt` 含 `/legacy/a.html` 与 `/legacy/b.html`
- **THEN** 站点 `sitemap.xml` 与 `sitemap.txt` 都包含这两个地址

#### Scenario: 去重
- **WHEN** `static-urls.txt` 声明的路径与 HeoPress 已发布的页面相同
- **THEN** sitemap 中该地址只出现一次

#### Scenario: 无效行
- **WHEN** `static-urls.txt` 含没有前导 `/`、带查询串、含 `..` 或控制字符的行
- **THEN** 这些行被跳过并记录，sitemap 仍生成其余条目

#### Scenario: 没有声明文件
- **WHEN** 挂载目录没有 `static-urls.txt`
- **THEN** sitemap 与没有挂载时相同

### Requirement: 内容透传
挂载的 HTML SHALL 原样返回：MUST NOT 注入、改写或剥离任何内容（包括 canonical、`noindex`、链接与脚本），只由响应头描述表示。
收录资格以运营者文件中的声明为准。

#### Scenario: canonical 与 noindex
- **WHEN** 挂载的页面声明了 canonical 与 `noindex`
- **THEN** 响应体与文件逐字节相同，两个声明都保留

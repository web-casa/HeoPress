# sites/domain-routing Specification

## Purpose
定义站点与公开域名的绑定、验证、主域名规范化，以及自动签发 HTTPS 证书前的域名校验，使新站点无需手工修改服务器配置即可上线。

## Requirements

### Requirement: 域名验证后生效
站点 SHALL 可以绑定多个域名，其中至多一个为主域名；只有 active 且不是语言入口的域名可以设为主域名，设定时同一事务清除该站点其他域名的主域名标记。新绑定的域名 MUST 通过 DNS TXT 或 HTTP 文件验证后才生效。
站点有 active 域名但尚未设定主域名时（新域名不会自动成为主域名），各 active 域名 SHALL 直接提供站点内容、不做主域名规范化跳转，直到运营者设定主域名；Studio 将该状态显示为“未设置主域名”并计为健康警告（见 `studio/network-summary`）。

#### Scenario: 未验证的域名
- **WHEN** 站点新增域名但尚未完成验证，访问者请求该域名
- **THEN** 系统不为该域名提供站点内容

#### Scenario: 验证通过
- **WHEN** 域名的 DNS TXT 记录与系统下发的令牌一致并触发验证
- **THEN** 域名状态变为 active，访问该域名返回对应站点的内容

#### Scenario: 尚未设定主域名
- **WHEN** 站点有两个 active 域名 `example.com` 与 `www.example.com`，都没有被设为主域名，访问者请求 `www.example.com/a`
- **THEN** 直接返回站点内容，不跳转；运营者把 `example.com` 设为主域名后，同一请求返回 301 到主域名的同一路径（按站点的结尾斜杠设置规范化，默认 `always` 时为 `https://example.com/a/`）

### Requirement: 主域名规范化
站点已设定主域名时，对其非主域名中的普通别名请求 SHALL 以 301 跳转到主域名的相同路径与查询参数（路径按站点的结尾斜杠设置规范化）；站点尚未设定主域名时 MUST NOT 做规范化跳转（见“域名验证后生效”）。显式配置为语言入口的已验证域名 MUST 保留其语言路由；主域名按语言配置确定。

#### Scenario: 访问备用域名
- **WHEN** 访问者请求 `www.example.com/a?x=1`，主域名是 `example.com`，站点结尾斜杠设置为 `never`
- **THEN** 返回 301，Location 为 `https://example.com/a?x=1`

### Requirement: 证书签发前的域名校验
系统 SHALL 提供仅内网可访问的域名校验端点，供反向代理在签发证书前查询。只有 active 域名 SHALL 返回成功；该端点 MUST 限速。

#### Scenario: 已生效域名
- **WHEN** 反向代理查询一个 active 域名
- **THEN** 返回 200

#### Scenario: 未知域名
- **WHEN** 反向代理查询一个未绑定或未验证的域名
- **THEN** 返回非 200，证书不会被签发

#### Scenario: 公网访问校验端点
- **WHEN** 从公网地址请求该端点
- **THEN** 请求被拒绝

### Requirement: 域名归属与可信 Host
同一域名 SHALL 只能绑定一个站点；验证令牌 MUST 绑定域名、站点及有效期。未知或停用 Host MUST 被拒绝，不得回退到默认站点；只有可信代理 SHALL 能提供转发 Host。

#### Scenario: 伪造转发主机
- **WHEN** 公网请求携带指向其他站点的转发 Host，或另一个站点复用验证令牌
- **THEN** 请求不改变站点解析结果，复用令牌不能激活域名

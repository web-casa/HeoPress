# platform/storage-profiles Specification

## Purpose
允许不同站点使用各自的存储桶与媒体访问域名，使站群中各站点的图片与附件互相独立，并在各自域名下提供。

## Requirements

### Requirement: 站点绑定存储配置
每个站点 SHALL 可以绑定一个存储配置（驱动、桶、访问端点、公共访问基地址）。未绑定时 SHALL 使用全局默认配置。
存储配置中的密钥 MUST 加密存储且不在任何接口中返回明文。

#### Scenario: 两个站点使用不同存储
- **WHEN** 站点 A 绑定 R2 桶、站点 B 绑定本地存储，两者各上传一张图片
- **THEN** 图片分别写入各自的存储，互不可见

#### Scenario: 读取存储配置
- **WHEN** 管理员通过接口读取存储配置
- **THEN** 密钥字段显示为已配置的掩码，不返回明文

### Requirement: 媒体 URL 使用站点域名
发布内容中的媒体 URL SHALL 使用站点所绑定存储配置的公共访问基地址。

#### Scenario: 站点配置了媒体域名
- **WHEN** 站点的存储配置公共基地址为 `https://img.example.com`
- **THEN** 该站点文章中的图片 URL 以 `https://img.example.com` 开头

### Requirement: 共享存储隔离与历史可访问
共用默认存储的站点 SHALL 仍拥有隔离的对象命名空间与访问权限。媒体 SHALL 保留上传时的存储定位；切换存储配置 MUST NOT 破坏历史媒体，迁移需显式确认并保留失败回滚路径。

#### Scenario: 切换默认存储
- **WHEN** 站点切换桶后读取旧媒体，另一站点猜测旧对象键
- **THEN** 旧媒体仍可访问，未授权站点无法读取受限媒体

# publishing/static-directory-mount Specification

## Purpose
站点启用 Astro 引擎时，静态目录挂载也必须随产物一起部署：构建把目录内容复制进本次构建的产物，HeoPress 产物优先，
静态目标的产物扫描把挂载文件当作普通产物处理。

## Requirements

### Requirement: 构建携带挂载目录
站点有静态目录挂载时，Astro 构建 SHALL 把该目录的常规文件复制进本次构建的产物；站点没有挂载时产物 MUST 与未实现该能力时相同。
构建 MUST 在读取设置时按 `HEOPRESS_STATIC_ROOT` 复核目录；目录缺失或越界时构建 MUST 失败并说明原因，不能静默丢页。
复制 MUST NOT 跟随符号链接（符号链接条目跳过），MUST NOT 复制挂载的声明文件 `static-urls.txt`，
并且 MUST NOT 覆盖产物中已存在的文件：HeoPress 的页面、`robots.txt`、`sitemap*.xml` 等系统文件始终优先。

#### Scenario: 归档文件进入产物
- **WHEN** 站点挂载了含 `legacy/about.html` 的目录并构建成功
- **THEN** 产物中包含 `legacy/about.html`，部署后该地址可访问

#### Scenario: HeoPress 路径不被覆盖
- **WHEN** 挂载目录含与 HeoPress 页面或系统文件同名的文件
- **THEN** 产物中该路径保留 HeoPress 的内容，挂载文件被跳过

#### Scenario: 目录缺失
- **WHEN** 已保存的挂载目录在构建时不存在或不在根目录内
- **THEN** 构建失败并记录原因，旧版本继续提供服务

#### Scenario: 符号链接
- **WHEN** 挂载目录含有指向目录之外的符号链接
- **THEN** 构建跳过该条目，产物中不出现它指向的内容

### Requirement: 静态产物扫描按普通产物处理
静态目标部署前的产物扫描 SHALL 把挂载文件当作普通产物检查（秘密、内部地址、后台地址、平台配置文件名），
MUST NOT 因为文件来自挂载目录而给它们任何豁免；挂载文件中的平台配置文件名（如 `_headers`、`vercel.json`）
MUST 仍被扫描拒绝，因为它不能覆盖生成的部署契约。

#### Scenario: 挂载中的秘密
- **WHEN** 挂载文件含私钥或安装密钥
- **THEN** 产物扫描拒绝该次部署并指出文件，与普通产物一致

#### Scenario: 挂载中的平台配置
- **WHEN** 挂载目录含 `_headers` 或 `vercel.json`
- **THEN** 产物扫描拒绝该次部署，不生成被覆盖的契约

### Requirement: sitemap 随产物一致
Astro 产物中的 `sitemap.xml`、`sitemap.txt` 与 `robots.txt` SHALL 来自 Classic 引擎同一套发现文件（page-data 取回），
因此挂载的 `static-urls.txt` 合并结果 MUST 与 Classic 引擎一致，不另写一套合并逻辑。

#### Scenario: 产物 sitemap 含挂载 URL
- **WHEN** 站点挂载目录的 `static-urls.txt` 声明了 `/legacy/a.html`，站点以 Astro 构建
- **THEN** 产物中的 `sitemap.xml` 与 `sitemap.txt` 都包含该地址

# HeoPress Plugin and Theme Exception

> Status: **final, v1.0.0 (2026-11-08).** This is an additional permission under section 7 of the GNU Affero General
> Public License, version 3 (AGPL-3.0-only), granted by **The HeoPress Authors**, the copyright holder of HeoPress.

HeoPress is licensed under the GNU Affero General Public License, version 3 only (`LICENSE`). This exception adds a
permission for plugins and themes; it does not change the license of HeoPress itself.

## 1. The permission

A **Plugin** (a package that declares a HeoPress plugin manifest and runs in the plugin host) or a **Theme** (a
theme or template package written against the HeoPress Theme Contract) that interacts with HeoPress **only through
the Public Interfaces** is an independent work. You may license your Plugin or Theme under any terms you choose,
including proprietary, closed-source and paid terms, and distribute it without the source-code obligations of the
AGPL.

The **Public Interfaces** are the documented extension surface: the plugin manifest and hooks, the
capability-scoped sandbox APIs, `@heopress/extension-sdk`, the Theme Contract and the JSON schemas and types
published for them.

## 2. What the permission does not cover

- **Modified HeoPress core.** If you modify HeoPress itself, or distribute a modified HeoPress, the AGPL applies to
  that modified work, including its network-use source offer (section 13).
- **Code copied from the core.** Code taken from HeoPress's implementation (rather than used through the Public
  Interfaces) stays under the AGPL. The Extension SDK, the published types and JSON schemas, and the Theme Contract
  definitions are the exception: those packages are licensed under Apache-2.0 (`LICENSES/Apache-2.0.txt`).
- **Bypassing the Public Interfaces.** Code that reaches into HeoPress internals — private modules, database tables
  or files outside the documented interfaces — to avoid the interfaces is not covered by this permission.

## 3. No other change

This exception grants no rights in HeoPress beyond the AGPL and the Apache-2.0-licensed packages named above. It
comes with no warranty, to the extent permitted by law. If any part of this exception is unenforceable, the rest
remains in effect and the AGPL applies without that part.

---

## 中文说明（非条款正文）

- HeoPress 以 AGPL-3.0-only 授权；本文件是依 AGPL 第 7 条给出的附加许可，不改变 HeoPress 本身的许可证。
- 只通过公开接口（插件清单与钩子、受能力约束的沙箱 API、`@heopress/extension-sdk`、主题契约及其类型与 JSON Schema）
  与 HeoPress 交互的插件和主题属于独立作品，**可以用任意许可证分发，包括闭源与收费**。
- 例外不覆盖：修改过的 HeoPress 核心（仍受 AGPL 约束，含第 13 条的网络使用源码提供义务）、从核心复制的代码
  （SDK、公开类型与 Schema、主题契约定义除外，这些包以 Apache-2.0 授权）、绕过公开接口直接访问内部实现的代码。
- 本例外不授予 AGPL 与上述 Apache-2.0 包之外的任何权利；在适用法律允许的范围内不提供担保。

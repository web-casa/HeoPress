# HeoPress 插件模板

一个只依赖 `@heopress/extension-sdk`（Apache-2.0）的插件（钩子扩展）模板：复制本目录即可开始写自己的插件。

- `heopress-extension.json`：插件清单（名称、版本、类型、入口与声明的能力）；能力须经管理员批准后才生效。
- `src/index.ts`：钩子实现。示例在文章更新前检查正文字数，少于设置 `minWords` 时拒绝保存。
- 只从 SDK 导入类型（`import type`），构建产物 `dist/index.js` 没有运行时依赖，宿主可直接加载。

## 构建

```bash
npm install
npm run build     # 输出 dist/index.js 与 dist/index.d.ts
```

模板只需要 Extension SDK 与 TypeScript（固定为确切版本），不依赖任何 HeoPress 核心包。仓库根目录的
`node scripts/verify-plugin-template.mjs` 会把 SDK 打包（`pnpm pack`），在临时目录里离线安装（`npm install --offline`，
只装这一个包），用仓库锁定的同一版本 TypeScript 构建本模板，并检查安装下来的依赖树里没有 AGPL 或其他非宽松许可证的包、
构建产物不在运行时加载任何 HeoPress 包（CI 的 `plugin-template` 作业）。

## 许可证

Extension SDK、主题契约与插件用到的类型包以 Apache-2.0 授权，与以 AGPL-3.0-only 授权的 HeoPress 核心分开。
只通过插件清单、钩子与 SDK 和 HeoPress 交互的插件属于独立扩展，可以使用任意许可证（插件与主题例外）。
本模板以 Apache-2.0 提供（见 `LICENSE`）；基于它的插件可以采用自己的许可证（在 `package.json` 的 `license` 字段声明），
按 Apache-2.0 的要求保留模板原有的版权与许可声明即可。

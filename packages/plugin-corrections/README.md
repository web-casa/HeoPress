# @heopress/plugin-corrections

HeoPress 的纠错官方插件（清单名 `heopress-corrections`）：**公开纠错表单 → 审核队列 → 文章上的更正记录与结构化数据**。
只依赖 `@heopress/extension-sdk`，不引入其他运行时依赖。

- 运营者文档：[纠错报告](../../docs/zh-CN/extensions/corrections.md)
- 契约：[extensions/corrections-plugin](../../openspec/specs/extensions/corrections-plugin/spec.md)（`design.md` 与这次变更一起归档在 `openspec/changes/archive/`）

## 它声明什么

| 内容 | 位置 |
|---|---|
| 两个集合 `reports`（私有队列）与 `notices`（公开记录） | `heopress-extension.json` 的 `collections` |
| 路由 `/corrections` 与 `/corrections/:slug`，Classic + Astro 模板 | `routes` 与 `templates/<engine>/` |
| 公开表单接口 `report`（8 KiB、每分钟 5 次、蜜罐、中性答复） | `endpoints`，见 `src/index.ts` |
| 审核订阅 `moderate-report`（接受 → 一条草稿记录） | `events`，见 `src/index.ts` |
| 正文订阅 `attach-notice`（记录发布 → 写入/移除更正块） | `events`，见 `src/index.ts` |
| 门禁检查 `notice-links`（块必须指向已发布记录） | `gateChecks` 与 `src/gate.ts` |
| `CorrectionComment` 结构化数据 | `structuredData` |
| 决定账本表格、计数小部件、`write_body`/`marker_label` 设置 | `storage` 与 `admin` |

## 开发

```bash
pnpm --filter @heopress/plugin-corrections typecheck
pnpm --filter @heopress/plugin-corrections test
pnpm --filter @heopress/plugin-corrections build   # dist/index.js + 把模板写进清单
node packages/plugin-corrections/scripts/build.mjs --check   # 清单与模板是否同步
```

`build.mjs` 把 `src/index.ts` 打成一个**不含运行期导入**的 ES 模块，并把 `templates/` 的源码写进
`heopress-extension.json`（安装与市场读的是清单）。改动模板后必须重新构建并提交清单。

数据库集成测试在 CMS：`apps/cms/src/__tests__/corrections-plugin.db.integration.test.ts`。

## 许可

Apache-2.0（见 `LICENSE` 与 `NOTICE`），与 HeoPress 本体的 AGPL-3.0-only 分开。

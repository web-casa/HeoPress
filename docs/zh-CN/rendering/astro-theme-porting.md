# 现有 Astro 站点移植为主题

Astro 主题是标准的 Astro 组件包：可以使用 Astro 组件、布局、样式与运营者批准的集成。与普通 Astro 站点的区别只有一点——
**数据只来自页面数据契约**：主题的入口组件收到一个 `page` 属性（`PageDataPage`，见 `packages/contracts/src/theme/page-data.ts`），
不读取内容集合、文件、环境变量或网络，也不调用 CMS 接口。系统负责的内容（head、正文、赞助披露）用 `@heopress/astro-kit` 的组件放置。

完整示例：`examples/astro-themes/blog-port/`，由一个典型的 Astro 博客（BaseHead、Header、Footer、BlogPost 布局）移植而来，
`apps/site-astro/src/__tests__/build.test.ts` 用它完成构建。官方起步主题见 `apps/site-astro/themes/starter/`。

## 1. 主题包结构

```
my-theme/
  package.json          # heopress.astroTheme.entry 指向入口组件
  src/Page.astro        # 入口：接收 page
  src/components/...    # 原站点的组件
  src/layouts/...       # 原站点的布局
  src/*.css
```

`package.json`：

```json
{
  "name": "my-theme",
  "private": true,
  "type": "module",
  "heopress": { "astroTheme": { "entry": "src/Page.astro", "integrations": [] } }
}
```

`integrations` 列出主题需要的 Astro 集成包名；每一个都必须在运营者的 `HEOPRESS_ASTRO_INTEGRATIONS` 中，否则主题检查失败。

## 2. 把路由改为入口组件

原站点的 `src/pages/index.astro`、`src/pages/blog/[...slug].astro` 等由构建模板统一提供，主题不再有 `src/pages/`。
入口组件按 `page.vm.page.type` 分支：

| 类型 | 原来 | 现在 |
|---|---|---|
| `home`、`taxonomy` | `getCollection('blog')` 生成列表 | `page.vm.list`（卡片） |
| `item` | 内容集合条目与 `<Content />` | `page.vm.item` 与 `<ItemBody page={page} />` |
| `error` | `src/pages/404.astro` | `page.vm.page.status` |

## 3. 替换系统内容

| 原站点 | 改为 |
|---|---|
| `<title>`、`<meta name="description">`、canonical、Open Graph、手写 JSON-LD | `<SeoHead page={page} />`（`@heopress/astro-kit/SeoHead.astro`），放在 `<head>` 中且只放一次 |
| `<Content />` / Markdown 正文 | `<ItemBody page={page} />` |
| 赞助标注 | 文章：正文之前 `{item.sponsor.sponsored && <SponsorDisclosure page={page} id={item.id} />}`；卡片：放在 `<Card id={c.id}>` 内 |
| 列表中的每一项 | 用 `<Card id={c.id}>…</Card>` 包住；指向赞助条目的链接必须在它的卡片内 |
| 链接 `href` | `safeUrl(url)`（`@heopress/astro-kit`），与 Classic 的 `url` 过滤器规则相同 |

主题不得自己输出 canonical 或 JSON-LD，也不得用 `set:html` 写原始标记；需要额外结构化数据时使用条目的 `structured_data` 字段或扩展的结构化数据贡献。

## 4. 主题检查

构建前检查（`apps/site-astro/src/builder/themes.ts` 的 `checkAstroTheme`）拒绝：读取环境变量（`process.env`、`import.meta.env`、`astro:env`）、
网络请求（`fetch`、`XMLHttpRequest`、`WebSocket`）、导入系统模块（`fs`、`child_process`、`net`、`http` 等）、引用 CMS 的 `/api`、`/admin`、`/internal` 路径、
输出 JSON-LD 或 canonical、使用 `set:html`、未批准的集成、符号链接、超过 20 MB 的主题，以及从不放置 `SeoHead` 的主题。

构建后校验（`apps/site-astro/src/builder/verify.ts`）确认 head、正文与赞助披露插槽与 Classic 规则一致；不通过的产物不会上线，站点继续提供旧版本。
启用披露、切换主题或回滚时都会重新执行这些校验。

## 5. 安装与构建

1. 把主题目录放到 `HEOPRESS_ASTRO_OPERATOR_THEMES` 下，例如 `<目录>/my-theme/`；
2. 用 `AstroEngine.enable(siteId, 'operator:my-theme')` 启用，或用 `switchTheme` 切换；
3. 构建时主题被复制到 `apps/site-astro/themes/.operator/` 下，从模板解析 `astro` 与 `@heopress/astro-kit`，不需要也不会执行依赖安装。

v1 只接受运营者自有主题与官方主题；第三方或市场来源的主题须等容器构建沙箱完成（`docs/backlog/astro-build-sandbox.md`）。

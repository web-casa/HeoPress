---
version: 1
lastUpdated: 2026-11-09T16:09:41.165Z
sourceLang: zh-CN
translatedFrom: zh-CN
sourceHash: 90f1eb72128b7d7b
mtEngine: manual
syncStatus: human-translated
---

# Briefing sections (`briefing-sections`)

HeoPress v1.1's tenth extension point: a plugin contributes a section to the Studio overview's **briefing** ("what
should I do today?") — a small set of numbers and links, computed on request. It reuses the existing capability
approval, manifest validation, sandbox and load path; it is not a second plugin mechanism.

The implementation lives in `packages/contracts/src/extensions/briefing.ts` (contract and validation),
`apps/cms/src/extensions/runtime/briefing-sections.ts` (reading and time limits) and `apps/cms/src/routes/extensions.ts`
(the endpoint); a runnable example is [the stale-drafts example](../../../examples/plugin-briefing-stale-drafts/README.md).

## What it is

A section is **declared by id** in the manifest and **registered under the same id** by the bundle:

- `briefingSections` in the manifest is the declaration the admin approves (id, title, optional description);
- `defineBriefingSection({ id, compute })` in the code computes `{ count, items }` when the Studio asks;
- the host owns everything else: the capability check, a deadline and request budget per call, validation of the
  answer, and failure isolation.

A plugin declares at most 8 sections; a section lists at most 10 links. `count` is the total and `items` a few of
them — the plugin states both, the host never infers them.

## Manifest declaration

```json
{
  "capabilities": ["ext:briefing-sections"],
  "briefingSections": [
    { "id": "stale-drafts", "title": "Stale drafts", "description": "Drafts not touched for 14 days" }
  ],
  "extensionPoints": { "briefing-sections": "^1.0.0", "context": "^1.0.0" }
}
```

Declaring a section without `ext:briefing-sections` is refused by the manifest check (the message is
`briefing sections need the ext:briefing-sections capability`); so is a repeated id, an id outside `[a-z][a-z0-9-]*`,
a title over 80 characters and more than 8 sections. These declarations are approved with the version at
install/upgrade; a later `PATCH` cannot rewrite them (as with `gateChecks` and `prePublishHooks`, that is the upgrade
flow).

## Registration

```ts
import type { BriefingSectionDefinition, PluginContext } from '@heopress/extension-sdk';

export default (ctx: PluginContext) => {
  const section: BriefingSectionDefinition = {
    id: 'stale-drafts',
    compute: async () => {
      const page = (await ctx.items.list('articles', { status: 'draft', limit: 200 })) as { data?: unknown[] } | null;
      const drafts = Array.isArray(page?.data) ? page.data : [];
      return { count: drafts.length, items: [{ label: 'Draft one', href: '/content/articles/a1' }] };
    },
  };
  ctx.extensionPoints.register('briefing-sections', section);
  return {};
};
```

`compute` receives `{ siteId, signal }` and reads through the sandboxed context (the example's `ctx.items.list` needs
`items:read:articles`; the site boundary, the caller's permissions, Hold and the field rules all apply).
`maxDurationMs` (default 1 500, at most 5 000) and `maxRequests` (default 10, at most 50) can only be smaller than the
host's ceiling.

## The answer and its limits

| Field | Type | Constraint |
|---|---|---|
| `count` | non-negative integer | 0 – 1 000 000 000, required |
| `items` | array | optional; at most 10 |
| `items[].label` | string | 1 – 80 characters |
| `items[].href` | string | a site-relative path starting with `/` (`/content/articles/a1`); an absolute URL and `//host` are refused |

Links are site-relative on purpose: the briefing is the Studio's "go and do this" entry, and a plugin must not be able
to send the operator off-site through it.

## The endpoint

```http
GET /api/v1/extensions/briefing-sections
```

It returns the sections of the active site's (`X-HeoPress-Site`) enabled plugins whose capabilities are approved; any
site member may read it:

```json
{
  "data": [
    {
      "plugin": "example-briefing-stale-drafts",
      "pluginName": "Stale drafts briefing",
      "id": "stale-drafts",
      "title": "Stale drafts",
      "description": "Drafts not touched for 14 days",
      "count": 2,
      "items": [{ "label": "Draft one", "href": "/content/articles/a1" }]
    }
  ]
}
```

The path is registered before the `/:name/*` dynamic endpoint mount, so it is never taken for one plugin's endpoint.

## Failure and isolation

- A section that throws, times out or answers outside the contract is left out and logged; the other sections — of that
  plugin and of every other — are returned as usual;
- a bundle that fails to load, a disabled plugin and one awaiting re-confirmation contribute no section at all;
- a registration under an id the manifest does not declare is refused and recorded as an
  `extension_capability_denied` audit event (the same record as an undeclared pre-publish hook);
- a declared section that was never registered does not appear.

## The example plugin

[`examples/plugin-briefing-stale-drafts`](../../../examples/plugin-briefing-stale-drafts/README.md) is a complete
example: the manifest, the implementation, the build and enable steps, and the limits it leaves in on purpose (such as
"only the oldest page").

## Limits

- Computed per request: there is no cache and no scheduled budget. For expensive work, precompute with `ext:jobs`, keep
  the small result in private storage, and read it in `compute`;
- the order of the sections is plugin and registration order; the Studio may sort them;
- the endpoint reads the active site only; there is no cross-site roll-up.

## Permissions and approval

| Point (manifest key) | Version | Capability |
|---|---|---|
| `briefing-sections` | `1.0.0` | `ext:briefing-sections` |

As with every extension point: the admin approves the capabilities at install, an upgrade that adds one is approved
again, and a plugin that is unapproved, disabled or awaiting re-confirmation takes no part in the briefing.

/**
 * A content plugin for the P12 content-extension tests (tasks 2.1–2.5): `acme/glossary` (namespace `acme_glossary`)
 * with a `terms` collection, an item route `/glossary/:slug`, a list route `/glossary`, default templates for both
 * engines and a `badge` component a theme may place.
 */
export const GLOSSARY = 'acme/glossary';
export const GLOSSARY_NS = 'acme_glossary';
export const TERMS = 'acme_glossary__terms';

const CLASSIC_TERM = `<!doctype html>
<html lang="{{ page.locale }}">
<head>
<meta charset="utf-8">
{% seo_head %}
</head>
<body class="glossary-term">
<h1>{{ item.title }}</h1>
{% item_body %}
{% include 'ext/acme_glossary/components/badge' %}
</body>
</html>`;

const CLASSIC_INDEX = `<!doctype html>
<html lang="{{ page.locale }}">
<head>
<meta charset="utf-8">
{% seo_head %}
</head>
<body class="glossary-index">
<h1>{{ route.title }}</h1>
<ul>{% for c in list %}<li><a href="{{ c.url | url }}">{{ c.title }}</a></li>{% endfor %}</ul>
</body>
</html>`;

const ASTRO_TERM = `---
import type { PageDataPage } from '@heopress/astro-kit';
import SeoHead from '@heopress/astro-kit/SeoHead.astro';
import ItemBody from '@heopress/astro-kit/ItemBody.astro';
import Badge from 'heopress:ext/acme_glossary/badge';
interface Props { page: PageDataPage }
const { page } = Astro.props;
const { vm } = page;
---
<html lang={vm.page.locale}>
<head>
<meta charset="utf-8">
<SeoHead page={page} />
</head>
<body class="glossary-term">
<h1>{vm.item?.title}</h1>
<ItemBody page={page} />
<Badge page={page} />
</body>
</html>`;

const ASTRO_INDEX = `---
import type { PageDataPage } from '@heopress/astro-kit';
import { safeUrl } from '@heopress/astro-kit';
import SeoHead from '@heopress/astro-kit/SeoHead.astro';
interface Props { page: PageDataPage }
const { page } = Astro.props;
const { vm } = page;
---
<html lang={vm.page.locale}>
<head>
<meta charset="utf-8">
<SeoHead page={page} />
</head>
<body class="glossary-index">
<h1>{vm.route?.title}</h1>
<ul>{vm.list.map((c) => <li><a href={safeUrl(c.url)}>{c.title}</a></li>)}</ul>
</body>
</html>`;

const ASTRO_BADGE = `---
import type { PageDataPage } from '@heopress/astro-kit';
interface Props { page: PageDataPage }
---
<span class="glossary-badge">Glossary term</span>`;

/** The manifest; `namespace` names the plugin's own component in its templates (another plugin's is not theirs). */
export function glossaryManifest(over: Record<string, unknown> = {}, namespace = GLOSSARY_NS): Record<string, unknown> {
  const own = (source: string) => source.replaceAll('ext/acme_glossary/', `ext/${namespace}/`).replaceAll('heopress:ext/acme_glossary/', `heopress:ext/${namespace}/`);
  return {
    collections: [
      {
        name: 'terms',
        label: 'Glossary terms',
        fields: [
          { name: 'title', type: 'string', interface: 'input' },
          { name: 'slug', type: 'string', interface: 'slug' },
          { name: 'body', type: 'text', interface: 'wysiwyg' },
        ],
      },
    ],
    routes: [
      { id: 'term', kind: 'item', path: '/glossary/:slug', collection: 'terms', template: 'term' },
      { id: 'index', kind: 'list', path: '/glossary', collection: 'terms', template: 'index', title: 'Glossary', pageSize: 2 },
    ],
    templates: {
      classic: { term: own(CLASSIC_TERM), index: CLASSIC_INDEX },
      astro: { term: own(ASTRO_TERM), index: ASTRO_INDEX },
    },
    components: {
      badge: { classic: '<span class="glossary-badge">Glossary term</span>', astro: ASTRO_BADGE },
    },
    structuredData: [{ key: 'publisher', scope: 'site', node: { '@type': 'Organization', name: 'Acme Glossary' } }],
    ...over,
  };
}

export const GLOSSARY_CAPABILITIES = ['ext:collections', 'ext:routes', 'seo:structured-data'];

/** The install input of the plugin (installed disabled unless `enabled`). */
export function glossaryInstall(opts: { name?: string; enabled?: boolean; manifest?: Record<string, unknown>; capabilities?: string[] } = {}) {
  const capabilities = opts.capabilities ?? GLOSSARY_CAPABILITIES;
  return {
    name: opts.name ?? GLOSSARY,
    version: '1.0.0',
    type: 'hook',
    enabled: opts.enabled ?? false,
    bundleUrl: 'https://example.com/glossary.js',
    capabilities,
    approvedCapabilities: capabilities,
    manifest: opts.manifest ?? glossaryManifest(),
  } as never;
}

/**
 * The starter themes (HeoPress P06 task 5.1; design §5, R45): news, tech blog and minimal. Each is an
 * ordinary theme — templates and one stylesheet — that a site administrator installs as a version of the
 * site's own (`ThemeService.installStarter`) and activates like any upload: the same checks, the same
 * engine, the same post-processing. Responsive (one column on narrow screens), with a skip link,
 * landmarks, a labelled search field, underlined links, visible focus, long words wrapped and text
 * contrast of at least 4.5:1.
 */

export type StarterName = 'news' | 'tech' | 'minimal';

export interface StarterTheme {
  name: StarterName;
  title: string;
  templates: Record<string, string>;
  /** Text assets (UTF-8). */
  assets: Array<{ path: string; contentType: string; text: string }>;
}

interface Variant {
  /** The `<body>` class: the stylesheet's hook. */
  body: string;
  /** A card in a list (inside `{% card c %}…{% endcard %}`). */
  card: string;
  /** Under the article title. */
  meta: string;
  footer: string;
}

const date = (v: string) => `{% if ${v} %}<time datetime="{{ ${v} }}">{{ ${v} | date: '%Y-%m-%d' }}</time>{% endif %}`;

function templates(v: Variant): Record<string, string> {
  const top = `<!doctype html>
<html lang="{{ page.locale }}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{% seo_head %}
<link rel="stylesheet" href="{{ 'style.css' | asset_url }}">
</head>
<body class="${v.body}">
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
<div class="wrap">
<p class="site-name"><a href="{{ site.homeUrl | url }}">{{ site.name }}</a></p>
<nav class="site-nav" aria-label="Site">{% for n in nav %}<a href="{{ n.url | url }}">{{ n.label }}</a>{% endfor %}</nav>
{% if alternates.size > 1 %}<nav class="languages" aria-label="Languages">{% for a in alternates %}<a hreflang="{{ a.locale }}" lang="{{ a.locale }}" href="{{ a.url | url }}">{{ a.locale }}</a>{% endfor %}</nav>{% endif %}
</div>
</header>
<main id="main" class="wrap">
`;
  const bottom = `
</main>
<footer class="site-footer"><div class="wrap">${v.footer}</div></footer>
</body>
</html>
`;
  const list = `{% if list.size > 0 %}<ul class="cards">
{% for c in list %}<li>{% card c %}${v.card}{% endcard %}</li>
{% endfor %}</ul>{% else %}<p class="empty">Nothing here yet.</p>{% endif %}`;
  const pager = `{% if pagination %}{% if pagination.prevUrl or pagination.nextUrl %}<nav class="pager" aria-label="Pages">{% if pagination.prevUrl %}<a rel="prev" href="{{ pagination.prevUrl | url }}">Newer</a>{% endif %}{% if pagination.nextUrl %}<a rel="next" href="{{ pagination.nextUrl | url }}">Older</a>{% endif %}</nav>{% endif %}{% endif %}`;
  return {
    'partials/top': top,
    'partials/bottom': bottom,
    'partials/list': list,
    'partials/pager': pager,
    home: `{% include 'partials/top' %}<h1 class="page-title">{{ site.name }}</h1>
{% include 'partials/list' %}
{% include 'partials/pager' %}{% include 'partials/bottom' %}`,
    item: `{% include 'partials/top' %}<article class="entry">
<header class="entry-header"><h1>{{ item.title }}</h1>${v.meta}</header>
{% if item.sponsor.sponsored %}{% sponsor_disclosure item %}{% endif %}
{% item_body %}
</article>{% include 'partials/bottom' %}`,
    taxonomy: `{% include 'partials/top' %}<h1 class="page-title">{{ item.title }}</h1>
{% if item.fields.description %}<p class="description">{{ item.fields.description }}</p>{% endif %}
{% include 'partials/list' %}
{% include 'partials/pager' %}{% include 'partials/bottom' %}`,
    search: `{% include 'partials/top' %}<h1 class="page-title">Search</h1>
<form class="search" role="search" method="get"><label for="q">Search terms</label><input id="q" type="search" name="q" value="{{ page.query }}"><button type="submit">Search</button></form>
{% if page.query %}{% include 'partials/list' %}{% endif %}
{% include 'partials/pager' %}{% include 'partials/bottom' %}`,
    error: `{% include 'partials/top' %}<h1 class="page-title">{{ page.status }}</h1>
<p>{% if page.status == 404 %}This page does not exist.{% elsif page.status == 410 %}This page has been removed.{% else %}Something went wrong.{% endif %}</p>
<p><a href="{{ site.homeUrl | url }}">Home</a></p>{% include 'partials/bottom' %}`,
  };
}

/** What every starter's stylesheet shares: layout, the skip link, focus, the system's own blocks. */
const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-size:1.0625rem;line-height:1.6;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
.wrap{width:100%;max-width:var(--measure);margin:0 auto;padding:0 1rem}
.skip{position:absolute;left:-999px;top:0;padding:.5rem 1rem;background:var(--fg);color:var(--bg)}
.skip:focus{left:1rem;z-index:10}
a{color:var(--link);text-decoration:underline;text-underline-offset:.15em}
a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.site-header .wrap{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;align-items:center;justify-content:space-between;padding-top:1rem;padding-bottom:1rem}
.site-name{margin:0;font-weight:700;font-size:1.25rem}
.site-name a{color:inherit;text-decoration:none}
.site-nav,.languages{display:flex;flex-wrap:wrap;gap:1rem}
.cards{list-style:none;margin:0;padding:0}
.pager{display:flex;justify-content:space-between;margin:2rem 0}
.search{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:1rem 0}
.search input{flex:1 1 12rem;padding:.5rem;font:inherit;border:1px solid var(--muted);border-radius:4px;background:var(--bg);color:var(--fg)}
.search button{padding:.5rem 1rem;font:inherit;border:0;border-radius:4px;background:var(--link);color:var(--bg);cursor:pointer}
.heopress-disclosure{display:inline-block;margin:.25rem 0;padding:.125rem .5rem;border:1px solid var(--muted);border-radius:4px;font-size:.875rem;color:var(--fg)}
.heopress-body{overflow-wrap:anywhere}
.heopress-body pre{overflow-x:auto;padding:1rem;border-radius:4px;background:var(--code-bg)}
.heopress-body table{border-collapse:collapse;display:block;overflow-x:auto}
.heopress-body th,.heopress-body td{border:1px solid var(--muted);padding:.25rem .5rem}
.site-footer{margin-top:3rem;padding:1.5rem 0;border-top:1px solid var(--rule);color:var(--fg-soft);font-size:.9375rem}
time{color:var(--fg-soft);font-size:.9375rem}
`;

const NEWS: Variant = {
  body: 'theme-news',
  card: `<article class="card"><h2><a href="{{ c.url | url }}">{{ c.title }}</a></h2>{% if c.sponsored %}{% sponsor_disclosure c %}{% endif %}{% if c.excerpt != '' %}<p>{{ c.excerpt }}</p>{% endif %}${date('c.publishedAt')}</article>`,
  meta: `<p class="meta">${date('item.publishedAt')}</p>`,
  footer: `<p>{{ site.name }}</p>`,
};
const NEWS_CSS = `:root{--bg:#fff;--fg:#1a1a1a;--fg-soft:#4a4a4a;--muted:#6b6b6b;--rule:#d9d9d9;--link:#0b5394;--focus:#c2410c;--code-bg:#f3f3f3;--measure:72rem}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
.site-header{border-bottom:4px solid var(--fg)}
.page-title{font-size:2rem;margin:1.5rem 0 1rem}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,16rem),1fr));gap:1.5rem}
.card{height:100%;padding:1rem;border:1px solid var(--rule);border-radius:6px}
.card h2{font-size:1.25rem;margin:0 0 .5rem;line-height:1.3}
.card h2 a{color:var(--fg);text-decoration-thickness:1px}
.card h2 a:hover{text-decoration-thickness:2px}
.card p{margin:.25rem 0 .5rem;color:var(--fg-soft)}
.entry{max-width:46rem}
.entry-header h1{font-size:2.25rem;line-height:1.2;margin:1.5rem 0 .5rem}
@media (max-width:40rem){.page-title{font-size:1.625rem}.entry-header h1{font-size:1.75rem}}
`;

const TECH: Variant = {
  body: 'theme-tech',
  card: `<article class="post">${date('c.publishedAt')}<h2><a href="{{ c.url | url }}">{{ c.title }}</a></h2>{% if c.sponsored %}{% sponsor_disclosure c %}{% endif %}{% if c.excerpt != '' %}<p>{{ c.excerpt }}</p>{% endif %}</article>`,
  meta: `<p class="meta">${date('item.publishedAt')}</p>`,
  footer: `<p>{{ site.name }} · <a href="{{ site.homeUrl | url }}">Home</a></p>`,
};
const TECH_CSS = `:root{--bg:#fbfbfa;--fg:#1f2328;--fg-soft:#4b535d;--muted:#6e7781;--rule:#d0d7de;--link:#0550ae;--focus:#bc4c00;--code-bg:#eef0f2;--measure:48rem}
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","Noto Sans","PingFang SC",sans-serif;background:var(--bg);color:var(--fg)}
.site-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.site-header{border-bottom:1px solid var(--rule)}
.page-title{font-size:1.75rem;margin:2rem 0 1rem}
.post{padding:1rem 0;border-bottom:1px solid var(--rule)}
.post h2{font-size:1.25rem;margin:.25rem 0}
.post p{margin:.25rem 0;color:var(--fg-soft)}
.entry-header h1{font-size:2rem;line-height:1.25;margin:2rem 0 .25rem}
.heopress-body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:var(--code-bg);padding:.1em .3em;border-radius:3px}
.heopress-body pre code{padding:0;background:none}
@media (max-width:40rem){.entry-header h1{font-size:1.625rem}}
`;

const MINIMAL: Variant = {
  body: 'theme-minimal',
  card: `<article class="line"><a href="{{ c.url | url }}">{{ c.title }}</a>{% if c.sponsored %} {% sponsor_disclosure c %}{% endif %} ${date('c.publishedAt')}</article>`,
  meta: date('item.publishedAt'),
  footer: `<p>{{ site.name }}</p>`,
};
const MINIMAL_CSS = `:root{--bg:#fffdf8;--fg:#222;--fg-soft:#555;--muted:#707070;--rule:#e2ded3;--link:#7a2e0e;--focus:#1d4ed8;--code-bg:#f4f1ea;--measure:40rem}
body{font-family:Georgia,"Iowan Old Style","Noto Serif","Songti SC",serif;background:var(--bg);color:var(--fg);font-size:1.125rem}
.page-title{font-size:1.5rem;font-weight:400;margin:2.5rem 0 1rem}
.line{display:flex;flex-wrap:wrap;gap:.25rem .75rem;align-items:baseline;padding:.375rem 0}
.entry-header h1{font-size:1.875rem;font-weight:400;line-height:1.3;margin:2.5rem 0 .25rem}
`;

const css = (own: string) => `${own}${BASE_CSS}`;

export const STARTER_THEMES: Record<StarterName, StarterTheme> = {
  news: { name: 'news', title: 'News', templates: templates(NEWS), assets: [{ path: 'style.css', contentType: 'text/css', text: css(NEWS_CSS) }] },
  tech: { name: 'tech', title: 'Tech blog', templates: templates(TECH), assets: [{ path: 'style.css', contentType: 'text/css', text: css(TECH_CSS) }] },
  minimal: { name: 'minimal', title: 'Minimal', templates: templates(MINIMAL), assets: [{ path: 'style.css', contentType: 'text/css', text: css(MINIMAL_CSS) }] },
};

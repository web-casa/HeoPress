/**
 * The built-in theme (HeoPress P06 tasks 1.3, 2.2): what a site without a published theme version is
 * rendered with, through the same engine, checks and post-processing as any theme. Plain and accessible;
 * the starter themes (task 5.1) replace it.
 */
export const BUILTIN_THEME_ID = 'builtin:1';

const top = `<!doctype html>
<html lang="{{ page.locale }}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{% seo_head %}
</head>
<body>
<header>
<p class="site-name"><a href="{{ site.homeUrl | url }}">{{ site.name }}</a></p>
{% if alternates.size > 1 %}<nav class="languages">{% for a in alternates %}<a hreflang="{{ a.locale }}" href="{{ a.url | url }}">{{ a.locale }}</a> {% endfor %}</nav>{% endif %}
</header>
<main>
`;

const bottom = `
</main>
</body>
</html>
`;

const list = `{% if list.size > 0 %}<ul class="articles">
{% for c in list %}<li>{% card c %}<a href="{{ c.url | url }}">{{ c.title }}</a>{% if c.sponsored %}{% sponsor_disclosure c %}{% endif %}{% if c.excerpt != '' %}<p>{{ c.excerpt }}</p>{% endif %}{% endcard %}</li>
{% endfor %}</ul>{% else %}<p class="empty">—</p>{% endif %}`;

const pager = `{% if pagination %}<nav class="pager">{% if pagination.prevUrl %}<a rel="prev" href="{{ pagination.prevUrl | url }}">←</a>{% endif %} {% if pagination.nextUrl %}<a rel="next" href="{{ pagination.nextUrl | url }}">→</a>{% endif %}</nav>{% endif %}`;

export const BUILTIN_THEME: Record<string, string> = {
  'partials/top': top,
  'partials/bottom': bottom,
  'partials/list': list,
  'partials/pager': pager,
  home: `{% include 'partials/top' %}<h1>{{ site.name }}</h1>
{% include 'partials/list' %}
{% include 'partials/pager' %}{% include 'partials/bottom' %}`,
  item: `{% include 'partials/top' %}<article>
<h1>{{ item.title }}</h1>
{% if item.sponsor.sponsored %}{% sponsor_disclosure item %}{% endif %}
{% item_body %}
</article>{% include 'partials/bottom' %}`,
  taxonomy: `{% include 'partials/top' %}<h1>{{ item.title }}</h1>
{% if item.fields.description %}<p class="description">{{ item.fields.description }}</p>{% endif %}
{% include 'partials/list' %}
{% include 'partials/pager' %}{% include 'partials/bottom' %}`,
  search: `{% include 'partials/top' %}<form role="search" method="get"><input type="search" name="q" value="{{ page.query }}"><button type="submit">Search</button></form>
{% if page.query %}{% include 'partials/list' %}{% endif %}
{% include 'partials/pager' %}{% include 'partials/bottom' %}`,
  error: `{% include 'partials/top' %}<h1>{{ page.status }}</h1>{% include 'partials/bottom' %}`,
};

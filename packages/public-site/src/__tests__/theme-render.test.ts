import { describe, expect, it } from 'vitest';
import type { ThemeViewModel } from '@heopress/contracts/theme';
import { BUILTIN_THEME } from '../theme/builtin.ts';
import { createThemeEngine, renderTemplate, safeUrl } from '../theme/engine.ts';
import { postprocess } from '../theme/postprocess.ts';
import { checkTheme } from '../theme/check.ts';
import { runThemeChecks } from '../theme/smoke.ts';
import { sampleSystemContent, sampleViewModels } from '../theme/samples.ts';

/**
 * Rendering and post-processing (HeoPress P06 tasks 2.2, 2.6; design R2, R15, R16, R28): escaped data,
 * system content only through placeholders that cannot be forged, copied or hidden, the sandbox limits.
 */

const top = BUILTIN_THEME['partials/top']!;
const bottom = BUILTIN_THEME['partials/bottom']!;
const vms = sampleViewModels();

async function render(templates: Record<string, string>, entry: keyof ReturnType<typeof sampleViewModels>, opts: { disclosure?: boolean; vm?: ThemeViewModel } = {}) {
  const engine = createThemeEngine(templates);
  const out = await renderTemplate(engine, entry, opts.vm ?? vms[entry]);
  return postprocess(out.html, out.slots, opts.vm ?? vms[entry], sampleSystemContent(opts.disclosure ?? true));
}
const itemTheme = (body: string) => ({ ...BUILTIN_THEME, item: `${top}${body}${bottom}` });

describe('theme rendering', () => {
  it('renders every page type of the built-in theme with the sample data, disclosure on and off', async () => {
    for (const disclosure of [true, false]) {
      for (const type of ['home', 'item', 'taxonomy', 'search', 'error'] as const) {
        const html = await render(BUILTIN_THEME, type, { disclosure });
        expect(html, type).toContain('<title>');
        expect(html, type).not.toContain('heopress-slot');
        expect(html, type).not.toMatch(/<script>alert|<img src=x/);
      }
    }
  });

  it('data is escaped; the body is the system one; the SEO head is the system one', async () => {
    const html = await render(BUILTIN_THEME, 'item');
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<div class="heopress-body"><p>Body with <a href="https://elsewhere.example.org/">a link</a>.</p></div>');
    expect(html).toMatch(/<head>[\s\S]*<title>Sample<\/title><meta name="description" content="A sample page"><link rel="canonical" href="https:\/\/sample.example.com\/">[\s\S]*<\/head>/);
    expect(html).toContain('hreflang="zh-CN"');
  });

  it('sponsor disclosure: before the body and inside sponsored cards when required, absent when not', async () => {
    const on = await render(BUILTIN_THEME, 'item', { disclosure: true });
    expect(on.indexOf('heopress-disclosure')).toBeGreaterThan(-1);
    expect(on.indexOf('heopress-disclosure')).toBeLessThan(on.indexOf('heopress-body'));
    expect(on).toContain('Sponsored by Acme');
    const off = await render(BUILTIN_THEME, 'item', { disclosure: false });
    expect(off).not.toContain('heopress-disclosure');
    const list = await render(BUILTIN_THEME, 'home', { disclosure: true });
    expect(list).toMatch(/<article data-heopress-card="two"><a href="https:\/\/sample.example.com\/two\/">[^]*?<aside class="heopress-disclosure" role="note">Sponsored<\/aside>/);
    // Required but missing → the render fails (and so would publication).
    await expect(render(itemTheme('<h1>{{ item.title }}</h1>{% item_body %}'), 'item', { disclosure: true })).rejects.toThrow(/sponsor_disclosure item %\} is required/);
    await expect(render(itemTheme('{% item_body %}{% sponsor_disclosure item %}'), 'item', { disclosure: true })).rejects.toThrow(/before the body/);
    await expect(
      render({ ...BUILTIN_THEME, 'partials/list': '{% for c in list %}{% card c %}<a href="{{ c.url | url }}">{{ c.title }}</a>{% endcard %}{% endfor %}' }, 'home', { disclosure: true }),
    ).rejects.toThrow(/sponsored card two/);
    await expect(
      render({ ...BUILTIN_THEME, 'partials/list': '{% for c in list %}<a href="{{ c.url | url }}">{{ c.title }}</a>{% endfor %}' }, 'home', { disclosure: false }),
    ).rejects.toThrow(/link to sponsored item two outside its/);
  });

  it('placeholders cannot be forged, copied, hidden or swallowed', async () => {
    const forged = '<meta name="heopress-slot" content="seo:0123456789abcdef01234567">';
    await expect(render({ ...BUILTIN_THEME, 'partials/top': top.replace('{% seo_head %}', forged) }, 'home')).rejects.toThrow(/not produced by this render/);
    await expect(render(itemTheme('{% capture b %}{% item_body %}{% endcapture %}{{ b }}'), 'item', { disclosure: false })).rejects.toThrow(/missing from the output/);
    await expect(render(itemTheme('<template>{% item_body %}</template>'), 'item', { disclosure: false })).rejects.toThrow(/inert/);
    await expect(render(itemTheme('<div hidden>{% item_body %}</div>'), 'item', { disclosure: false })).rejects.toThrow(/inert/);
    await expect(render(itemTheme('<!-- {% item_body %} -->'), 'item', { disclosure: false })).rejects.toThrow(/missing from the output/);
    await expect(render(itemTheme('{% item_body %}{% item_body %}'), 'item', { disclosure: false })).rejects.toThrow(/exactly once/);
    await expect(render({ ...BUILTIN_THEME, 'partials/top': top.replace('{% seo_head %}', '').replace('<main>', '<main>{% seo_head %}') }, 'home')).rejects.toThrow(/inside <head>/);
  });

  it('tampered placeholders: extra attributes, nesting, foreign namespaces; sponsored links found by destination', async () => {
    // What a template could only produce with raw output (echo is refused): fed to the post-processor directly.
    const engine = createThemeEngine(BUILTIN_THEME);
    const home = await renderTemplate(engine, 'home', vms.home);
    const tamper = (html: string) => postprocess(html, home.slots, vms.home, sampleSystemContent(true));
    expect(() => tamper(home.html.replace('<article data-heopress-card="two:', '<article onclick="alert(1)" data-heopress-card="two:'))).toThrow(/event handler/);
    expect(() => tamper(home.html.replace('<article data-heopress-card="two:', '<article title="x" data-heopress-card="two:'))).toThrow(/foreign attributes/);
    const item = await renderTemplate(engine, 'item', vms.item);
    const disclosure = /<heopress-slot data-n="disclosure:[0-9a-f]+"><\/heopress-slot>/.exec(item.html)![0];
    const body = /<heopress-slot data-n="body:[0-9a-f]+"><\/heopress-slot>/.exec(item.html)![0];
    const nested = item.html.replace(body, '').replace(disclosure, disclosure.replace('></heopress-slot>', `>${body}</heopress-slot>`));
    expect(() => postprocess(nested, item.slots, vms.item, sampleSystemContent(true))).toThrow(/slot with content/);
    // In SVG / MathML a disclosure would not render as HTML.
    await expect(render(itemTheme('<svg>{% sponsor_disclosure item %}</svg>{% item_body %}'), 'item', { disclosure: true })).rejects.toThrow(/inside SVG or MathML/);
    await expect(render(itemTheme('<math>{% item_body %}</math>'), 'item', { disclosure: false })).rejects.toThrow(/inside SVG or MathML/);
    // Script-driven attribute changes in SVG.
    await expect(
      render(itemTheme('<svg><a><animate attributeName="href" values="javascript:alert(1)" dur="1s"></animate><text>x</text></a></svg>{% item_body %}'), 'item', { disclosure: false }),
    ).rejects.toThrow(/<animate> is not allowed/);
    // A link to a sponsored item outside its card, written another way.
    const list = (href: string) => ({ ...BUILTIN_THEME, 'partials/list': `{% for c in list %}<a href="${href}">{{ c.title }}</a>{% endfor %}` });
    await expect(render(list("{{ c.url | append: '#x' | url }}"), 'home', { disclosure: false })).rejects.toThrow(/outside its/);
    await expect(render(list("{{ c.url | remove: 'https://sample.example.com' | url }}"), 'home', { disclosure: false })).rejects.toThrow(/outside its/);
    await expect(render(list("{{ c.url | append: '?ref=1' | url }}"), 'home', { disclosure: false })).rejects.toThrow(/outside its/);
    // Relative to the page, as the browser reads it: from /category/sample/, ../two/ is /category/two/ (not /two/).
    const taxonomyVm = { ...vms.taxonomy, page: { ...vms.taxonomy.page, path: '/category/sample/' }, list: vms.taxonomy.list.map((c) => (c.id === 'two' ? { ...c, url: 'https://sample.example.com/category/two/' } : c)) };
    const onTaxonomy = { ...BUILTIN_THEME, taxonomy: `${top}<a href="../two/">x</a>{% include 'partials/list' %}${bottom}` };
    await expect(render(onTaxonomy, 'taxonomy', { disclosure: true, vm: taxonomyVm })).rejects.toThrow(/outside its/);
  });

  it("the page's own markup: no event handlers, no javascript: URLs, no base or meta refresh", async () => {
    await expect(render(itemTheme('<img src="x.png" onerror="alert(1)">{% item_body %}'), 'item', { disclosure: false })).rejects.toThrow(/event handler/);
    await expect(render(itemTheme('<a href="javascript:alert(1)">x</a>{% item_body %}'), 'item', { disclosure: false })).rejects.toThrow(/scheme not allowed/);
    await expect(render(itemTheme('<a href=" JaVaScRiPt:alert(1)">x</a>{% item_body %}'), 'item', { disclosure: false })).rejects.toThrow(/scheme not allowed/);
    await expect(render(itemTheme('<img srcset="a.png 1x, data:text/html,x 2x">{% item_body %}'), 'item', { disclosure: false })).rejects.toThrow(/scheme not allowed/);
    await expect(render({ ...BUILTIN_THEME, 'partials/top': top.replace('</head>', '<base href="https://evil.example.org/"></head>') }, 'home')).rejects.toThrow(/<base>/);
  });

  it('HeoPress P07 task 2.4: a theme writes no JSON-LD — no json_ld tag, no ld+json script, however its type is spelled', async () => {
    // The tag is gone: the static checks name it and say why; the engine does not know it.
    const tagged = itemTheme('{% json_ld item %}{% item_body %}');
    expect(checkTheme(tagged).some((i) => /json_ld %\} is not available any more/.test(i.message))).toBe(true);
    await expect(render(tagged, 'item', { disclosure: false })).rejects.toThrow();
    // A script of its own: refused when rendered (checks and live pages alike), whatever the case or parameters.
    for (const type of ['application/ld+json', 'APPLICATION/LD+JSON', ' application/ld+json; charset=utf-8']) {
      const theme = itemTheme(`<script type="${type}">{"@type":"Thing"}</script>{% item_body %}`);
      await expect(render(theme, 'item', { disclosure: false }), type).rejects.toThrow(/cannot output JSON-LD/);
      const checks = await runThemeChecks(theme);
      expect(checks.ok, type).toBe(false);
      expect(checks.issues.some((i) => /cannot output JSON-LD/.test(i.message)), type).toBe(true);
    }
    // Every branch, not only those the samples take; a computed type; a type written with character references.
    for (const [script, why] of [
      ['{% if item.fields.never_set %}<script type="application/ld+json">{}</script>{% endif %}', /cannot output JSON-LD/],
      [`<script type="{{ 'application/' | append: 'ld+json' }}">{}</script>`, /type is computed/],
      ['<script type="{% if true %}application/ld+json{% endif %}">{}</script>', /cannot output JSON-LD|type is computed/],
      ['<script type="application/ld&#x2b;json">{}</script>', /cannot output JSON-LD/],
      ['<script type=application/ld&plus;json>{}</script>', /cannot output JSON-LD/],
      ['<SCRIPT TYPE="Application/LD+JSON; charset=utf-8">{}</SCRIPT>', /cannot output JSON-LD/],
    ] as const) {
      const theme = itemTheme(`${script}{% item_body %}`);
      expect(checkTheme(theme).some((i) => why.test(i.message)), script).toBe(true);
      expect((await runThemeChecks(theme)).ok, script).toBe(false);
    }
    // At run time the parsed attribute is what counts: a character reference is no way round.
    await expect(render(itemTheme('<script type="application/ld&#x2b;json">{}</script>{% item_body %}'), 'item', { disclosure: false })).rejects.toThrow(/cannot output JSON-LD/);
    // As the page is really composed and parsed (Codex review of batch 5b-1): adjacent attributes, a start tag assembled from
    // two partials, markup split around a tag — in a branch the samples never take.
    for (const theme of [
      itemTheme('{% if item.fields.never_set %}<script data-x=""type="application/ld+json">{}</script>{% endif %}{% item_body %}'),
      { ...itemTheme(`{% if item.fields.never_set %}{% include 'partials/open' %}{% include 'partials/close' %}{% endif %}{% item_body %}`), 'partials/open': '<scr', 'partials/close': 'ipt type="application/ld+json">{}</script>' },
    ]) {
      expect(checkTheme(theme).some((i) => /cannot output JSON-LD/.test(i.message))).toBe(true);
    }
    expect(checkTheme(itemTheme('<scr{% if true %}{% endif %}ipt type="application/ld+json">{}</script>{% item_body %}')).some((i) => /cannot output JSON-LD/.test(i.message))).toBe(true);
    // Liquid's whitespace control, as rendering applies it: a comment (block or inline) that trims the spaces away inside a type.
    for (const body of [
      `{% if item.title == 'publish-me' %}<script type="application/  {%- comment -%}x{%- endcomment -%}  ld+json">{}</script>{% endif %}`,
      `{% if item.title == 'publish-me' %}<script type="application/  {%- # x -%}  ld+json">{}</script>{% endif %}`,
    ]) {
      expect(checkTheme(itemTheme(`${body}{% item_body %}`)).some((i) => /cannot output JSON-LD/.test(i.message)), body).toBe(true);
      expect((await runThemeChecks(itemTheme(`${body}{% item_body %}`))).ok, body).toBe(false);
    }
    // An include's or render's own whitespace control, kept when the partial is inlined (block and output trims alike).
    for (const tag of ["{%- include 'partials/noop' -%}", "{%- render 'partials/noop' -%}", "{%- include 'partials/noop' %}{{- '' -}}"]) {
      const theme = { ...itemTheme(`{% if item.title == 'publish-me' %}<script type="application/  ${tag}  ld+json">{}</script>{% endif %}{% item_body %}`), 'partials/noop': '' };
      expect(checkTheme(theme).some((i) => /cannot output JSON-LD|type is computed/.test(i.message)), tag).toBe(true);
      expect((await runThemeChecks(theme)).ok, tag).toBe(false);
    }
    // A JSON-LD script inside <noscript> inside <template>: refused when rendered (the post-processing reads template content too).
    await expect(render(itemTheme('<template><noscript><script type="application/ld+json">{}</script></noscript></template>{% item_body %}'), 'item', { disclosure: false })).rejects.toThrow(/cannot output JSON-LD/);
    // A <noscript> is markup to a browser without scripting: a JSON-LD script there is refused, in the checks and when rendered.
    const noscript = itemTheme('<noscript><script type="application/ld+json">{}</script></noscript>{% item_body %}');
    expect(checkTheme(noscript).some((i) => /cannot output JSON-LD/.test(i.message))).toBe(true);
    await expect(render(noscript, 'item', { disclosure: false })).rejects.toThrow(/cannot output JSON-LD/);
    // What never reaches the page is no script: inside a Liquid comment, an HTML comment, a textarea's text.
    for (const body of [
      '{% comment %}<script type="application/ld+json">{}</script>{% endcomment %}',
      '<!-- <script type="application/ld+json">{}</script> -->',
      '<textarea><script type="application/ld+json">{}</script></textarea>',
    ]) {
      expect(checkTheme(itemTheme(`${body}{% item_body %}`)), body).toEqual([]);
    }
    // Merely mentioning the words is fine.
    const mention = itemTheme('<p>Structured data is application/ld+json, written by the system.</p>{% item_body %}');
    expect(checkTheme(mention)).toEqual([]);
    expect((await runThemeChecks(mention)).ok).toBe(true);
    // The old placeholder type is no placeholder: refused.
    await expect(render(itemTheme('<script type="application/heopress-slot">json:000000000000000000000000</script>{% item_body %}'), 'item', { disclosure: false })).rejects.toThrow(/malformed system slot/);
  });

  it('the url filter and the sandbox: prototype, unknown variables, refused filters, runaway loops', async () => {
    expect(['javascript:x', 'data:x', '//evil.example.org', '/\\evil', '\\\\evil', 'vbscript:x', 'java\tscript:x', ' javascript:x', ''].map(safeUrl)).toEqual(['#', '#', '#', '#', '#', '#', '#', '#', '#']);
    expect(['https://a.example.com', '/x', '?q', '#a', 'mailto:a@example.com', 'rel/x'].map(safeUrl)).toEqual(['https://a.example.com', '/x', '?q', '#a', 'mailto:a@example.com', 'rel/x']);
    const run = (body: string) => render(itemTheme(`${body}{% item_body %}`), 'item', { disclosure: false });
    await expect(run('{{ site.constructor }}')).rejects.toThrow(/property path not allowed/);
    await expect(run('{% for c in list %}{% if forloop.__proto__ %}x{% endif %}{% endfor %}')).rejects.toThrow(/property path not allowed/);
    await expect(run("{% assign k = 'x' %}{{ site[k] }}")).rejects.toThrow(/property path not allowed/);
    await expect(run("{{ site['__proto__'] }}")).rejects.toThrow(/property path not allowed/);
    // echo and cycle write without escaping: refused.
    await expect(run('{% echo item.title %}')).rejects.toThrow(/not allowed/);
    await expect(run("{% cycle item.title, 'b' %}")).rejects.toThrow(/not allowed/);
    // Many discarded captures count together, as they are written (Codex review round 2).
    const fifty = Array.from({ length: 50 }, (_, i) => `{% capture c${i} %}{% for j in (1..1000) %}${'x'.repeat(200)}{% endfor %}{% endcapture %}`).join('');
    await expect(run(`${fifty}ok`)).rejects.toThrow(/limit/);
    // A discarded capture is bounded too.
    await expect(run("{% capture big %}{% for i in (1..5000) %}{{ item.title }}{{ item.title }}{{ item.title }}{% endfor %}{% endcapture %}ok")).rejects.toThrow(/capture too large|limit/);
    await expect(run('{{ nope }}')).rejects.toThrow(/undefined variable/);
    await expect(run('{{ item.title | raw }}')).rejects.toThrow(/not allowed/);
    await expect(run('{% for i in (1..100000000) %}x{% endfor %}')).rejects.toThrow(/limit/);
    await expect(run("{% assign s = 'aaaaaaaaaa' %}{% for i in (1..40) %}{% assign s = s | append: s %}{% endfor %}{{ s }}")).rejects.toThrow(/limit|too long/);
    await expect(run('{% for c in (1..50) %}{{ c }}{% endfor %}')).resolves.toContain('50');
  });

  it('preview mode (R29): links leaving the preview lose their href; frames, forms, external media and prefetching go — the body too', async () => {
    const policy = { origin: 'https://preview.example.com', prefix: '/site_a/', media: ['https://media.example.com'] };
    const theme = itemTheme(
      [
        '<h1>{{ item.title }}</h1>{% sponsor_disclosure item %}{% item_body %}',
        '<a href="https://elsewhere.example.org/x">out</a><a href="/site_a/view">in</a><a href="/site_b/view">other site</a><a href="#top">top</a>',
        '<area href="https://elsewhere.example.org/" alt="a">',
        '<form action="https://elsewhere.example.org/"><input name="q"></form><iframe src="/site_a/view"></iframe><object data="x"></object><embed src="x">',
        '<img src="https://tracker.example.org/p.gif" alt="t"><img src="https://media.example.com/a.png" alt="m">',
        '<img src="/site_a/assets/v/a.png" srcset="/site_a/assets/v/a.png 1x, https://tracker.example.org/b.png 2x" alt="s">',
        '<video poster="https://tracker.example.org/v.png"></video><button formaction="https://elsewhere.example.org/">b</button>',
        // Draft data in a URL to an allowed media origin, or in CSS: removed.
        '<img src="https://media.example.com/{{ item.title | url_encode }}.png" alt="leak"><p style="background:url(https://media.example.com/{{ item.id }})">s1</p>',
        '<p style="color:red">kept</p><p style="background:\\75rl(x)">s2</p><style>p{background:url(/site_a/x)}</style><style>p{color:blue}</style>',
        '<svg><use href="https://elsewhere.example.org/s.svg#a"></use><use href="#local"></use></svg><blockquote cite="https://elsewhere.example.org/">q</blockquote>',
      ].join(''),
    );
    const head = '<link rel="prefetch" href="/site_a/view"><link rel="stylesheet" href="https://cdn.example.org/s.css"><link rel="stylesheet" href="/site_a/assets/v/s.css"></head>';
    const vm = vms.item;
    const engine = createThemeEngine({ ...theme, item: theme.item.replace(top, top.replace('</head>', head)) });
    const out = await renderTemplate(engine, 'item', vm);
    const system = sampleSystemContent(true);
    system.bodies[vm.item!.id] += '<p><img src="https://media.example.com/body.png" alt="b"></p>';
    const html = postprocess(out.html, out.slots, vm, system, { preview: policy });
    // The body's own link (system content) is stripped as well.
    expect(html).toContain('<div class="heopress-body"><p>Body with <a>a link</a>.</p><p><img src="https://media.example.com/body.png" alt="b"></p></div>');
    expect(html).toContain('<a>out</a><a href="/site_a/view">in</a><a>other site</a><a href="#top">top</a><area alt="a">');
    expect(html).not.toMatch(/<form|<iframe|<object|<embed|tracker\.example\.org|cdn\.example\.org|formaction|rel="prefetch"/);
    // A media URL the system's content names is kept; one the theme writes is not.
    expect(html).toContain('<img src="https://media.example.com/body.png" alt="b">');
    expect(html).not.toContain('alt="m"');
    expect(html).not.toContain('alt="leak"');
    expect(html).toContain('<p>s1</p>');
    expect(html).toContain('<p style="color:red">kept</p><p>s2</p><style>p{color:blue}</style>');
    expect(html).not.toContain('url(');
    expect(html).toContain('<use></use><use href="#local"></use>');
    expect(html).toContain('<blockquote>q</blockquote>');
    expect(html).toContain('<link rel="stylesheet" href="/site_a/assets/v/s.css">');
    // Not a preview: the same page keeps its links.
    const plain = postprocess(out.html, out.slots, vm, sampleSystemContent(true));
    expect(plain).toContain('<a href="https://elsewhere.example.org/x">out</a>');
  });

  it('preview mode keeps refusing navigation the CSP cannot stop: meta refresh and <base> fail the render (Codex review, batch 6)', async () => {
    const policy = { origin: 'https://preview.example.com', prefix: '/site_a/', media: [] };
    for (const head of ['<meta http-equiv="refresh" content="0;url=https://elsewhere.example.org/{{ item.title | url_encode }}">', '<base href="https://elsewhere.example.org/">']) {
      const engine = createThemeEngine({ ...BUILTIN_THEME, item: itemTheme('{% item_body %}').item.replace('</head>', `${head}</head>`) });
      const out = await renderTemplate(engine, 'item', vms.item);
      expect(() => postprocess(out.html, out.slots, vms.item, sampleSystemContent(false), { preview: policy })).toThrow(/not allowed/);
    }
  });

  it('asset URLs: the public path by default, the preview path when asked', async () => {
    const asset = { path: 'a.css', sha256: 'f'.repeat(64), contentType: 'text/css', size: 1 };
    const pub = createThemeEngine({ home: "{{ 'a.css' | asset_url }}" }, { id: 'v1', assets: [asset] });
    expect((await renderTemplate(pub, 'home', vms.home)).html).toBe(`/_theme/v1/${'f'.repeat(64)}.css`);
    const pre = createThemeEngine({ home: "{{ 'a.css' | asset_url }}" }, { id: 'v1', assets: [asset], assetBase: '/site_a/assets/' });
    expect((await renderTemplate(pre, 'home', vms.home)).html).toBe(`/site_a/assets/v1/${'f'.repeat(64)}.css`);
  });
});

import { describe, expect, it } from 'vitest';
import { BUILTIN_THEME } from '../theme/builtin.ts';
import { checkTheme, filterNames } from '../theme/check.ts';

/**
 * Static checks before publication (HeoPress P06 tasks 2.2, 2.4, 7.1; design R15, R27, R36): each case a
 * theme that must be refused, with the reason named; the built-in theme passes.
 */

const top = BUILTIN_THEME['partials/top']!;
const bottom = BUILTIN_THEME['partials/bottom']!;
/** The built-in theme with the item template's body replaced. */
const withItem = (body: string, extra: Record<string, string> = {}) => ({ ...BUILTIN_THEME, item: `${top}${body}{% item_body %}${bottom}`, ...extra });
const messages = (templates: Record<string, string>) => checkTheme(templates).map((i) => `${i.template}: ${i.message}`);
const refused = (templates: Record<string, string>, pattern: RegExp) => {
  const m = messages(templates);
  expect(m.some((x) => pattern.test(x)), `expected ${pattern} in ${JSON.stringify(m)}`).toBe(true);
};

describe('checkTheme', () => {
  it('accepts the built-in theme', () => {
    expect(messages(BUILTIN_THEME)).toEqual([]);
  });

  it('spec "读取契约外数据": a variable outside the contract is named', () => {
    refused(withItem('{{ secrets.key }}'), /variable "secrets.key" is not in the page data contract/);
    refused(withItem('{{ site.databaseUrl }}'), /variable "site.databaseUrl"/);
    refused(withItem('{{ env }}'), /variable "env"/);
    // In a partial and in an untaken branch too.
    refused({ ...withItem("{% if false %}{% include 'partials/x' %}{% endif %}"), 'partials/x': '{{ process.env }}' }, /variable "process.env"/);
    expect(messages(withItem('{{ item.fields.anything }}{% for c in list %}{{ c.title }}{% endfor %}{% assign t = site.name %}{{ t }}'))).toEqual([]);
  });

  it('spec "缺少 SEO 插槽" / item body: required system tags', () => {
    refused({ ...BUILTIN_THEME, 'partials/top': top.replace('{% seo_head %}', '') }, /home: must output \{% seo_head %\}/);
    refused({ ...BUILTIN_THEME, item: `${top}<p>no body</p>${bottom}` }, /item: must output \{% item_body %\}/);
    const { home: _home, ...withoutHome } = BUILTIN_THEME;
    refused(withoutHome, /home: required template missing/);
  });

  it('spec "引入其他主题的模板": partials only from this version, by literal name', () => {
    refused(withItem("{% include '../other-theme/item' %}"), /no such template/);
    refused(withItem("{% render 'nope' %}"), /no such template/);
    refused(withItem('{% include page.path %}'), /string literal template name/);
    refused({ ...withItem("{% include 'partials/a' %}"), 'partials/a': "{% include 'partials/b' %}", 'partials/b': "{% include 'partials/a' %}" }, /partial cycle/);
    refused({ ...BUILTIN_THEME, '../x': 'y' }, /template names/);
  });

  it('only allow-listed tags and filters (raw, liquid, layout, jsonify…)', () => {
    refused(withItem('{{ item.title | raw }}'), /filter "raw" is not allowed/);
    refused(withItem('{{ item | json }}'), /filter "json" is not allowed/);
    refused(withItem('{% raw %}x{% endraw %}'), /tag "raw" is not allowed/);
    refused(withItem("{% liquid echo item.title %}"), /tag "liquid" is not allowed/);
    refused(withItem("{% layout 'x' %}"), /tag "layout" is not allowed/);
    refused(withItem('{% assign x = item.title | raw %}{{ x }}'), /filter "raw" is not allowed/);
  });

  it('outputs: never in script, style, comments, names, event handlers, style or srcdoc; quoted; URLs through url', () => {
    refused(withItem('<script>var t = "{{ item.title }}";</script>'), /inside <script>/);
    refused(withItem('<style>.x{content:"{{ item.title }}"}</style>'), /inside <style>/);
    refused(withItem('<!-- {{ item.title }} -->'), /HTML comment/);
    refused(withItem('<div {{ item.title }}="x"></div>'), /attribute name/);
    refused(withItem('<{{ item.title }}>x</div>'), /tag name|place HTML drops/);
    refused(withItem('<img src="x.png" onerror="{{ item.title }}">'), /"onerror" attribute is not allowed/);
    refused(withItem('<p style="color: {{ item.title }}">x</p>'), /"style" attribute is not allowed/);
    refused(withItem('<iframe srcdoc="{{ item.title }}"></iframe>'), /"srcdoc" attribute is not allowed/);
    refused(withItem('<p title={{ item.title }}>x</p>'), /unquoted attribute value/);
    refused(withItem('<a href="{{ item.url }}">x</a>'), /must end with the url filter/);
    refused(withItem('<img srcset="{{ item.url }} 2x">'), /must end with the url filter/);
    refused(withItem('<meta http-equiv="refresh" content="0;url={{ item.url }}">'), /must end with the url filter/);
    refused(withItem('<noscript>{{ item.title }}</noscript>'), /inside <noscript>/);
    expect(messages(withItem('<a href="{{ item.url | url }}" title=\'{{ item.title }}\'>{{ item.title }}</a>'))).toEqual([]);
  });

  it('R36: control structures stay context-neutral', () => {
    // The regression cases of the design.
    refused(withItem('<script>{% if item %}</script>{% endif %}{{ item.title }}</script>'), /inside <script>|not context-neutral/);
    refused(withItem('<a {% if item %}href="x"{% endif %}>x</a>'), /tag inside the attribute|outside text|place HTML drops|attribute name/);
    refused(withItem('<p title="{% if item %}a{% endif %}">x</p>'), /tag inside the attribute/);
    refused(withItem('<div>{% if item %}</div><div>{% endif %}x</div>'), /not context-neutral/);
    refused(withItem('{% if item %}<a href="/x">{% else %}</a>{% endif %}'), /not context-neutral/);
    refused(withItem('{% for c in list %}<li>{% endfor %}'), /not context-neutral/);
    refused(withItem('{% capture x %}<b>{% endcapture %}{{ x }}'), /not context-neutral/);
    refused(withItem('{% if item %}<a href="#{% endif %}">x</a>'), /tag inside the attribute|not context-neutral|place HTML drops/);
    // Each branch on its own, even where the combined parse would hide it (Codex review round 2).
    refused(withItem('{% if false %}</textarea>{% endif %}'), /closes <\/textarea> it did not open/);
    refused(withItem('{% if item %}</script>{% endif %}'), /closes <\/script>/);
    refused(withItem('{% if item %}<p>a{% else %}b{% endif %}'), /leaves <p> open/);
    refused(withItem('{% if item %}<!-- x{% endif %} -->'), /opens a comment|HTML comment/);
    // HTML's implied end tags and foreign content are balanced too (Codex review round 3).
    expect(messages(withItem('{% if item %}<ul><li>A<li>B</ul>{% endif %}{% if item %}<dl><dt>a<dd>b</dl><p>x<div>y</div>{% endif %}'))).toEqual([]);
    expect(messages(withItem('{% if item %}<svg><source></source><path d="M0 0"/><g></g></svg>{% endif %}{% if item %}<img src="a.png" alt="<x>">{% endif %}'))).toEqual([]);
    refused(withItem('{% if item %}<div/>{% endif %}'), /leaves <div> open/);
    expect(messages(withItem('{% if item %}<svg/>{% endif %}{% if item %}<svg><foreignObject><br><p>x</p></foreignObject></svg>{% endif %}<math><mi>x</mi></math>'))).toEqual([]);
    expect(
      messages(withItem('{% if item %}<math><mi><mglyph/></mi><annotation-xml encoding="application/mathml+xml"><mrow/></annotation-xml><annotation-xml encoding="text/html"><p>x</p></annotation-xml><annotation-xml encoding="text&#47;html"><br></annotation-xml><annotation-xml encoding=" text/html "><mrow/></annotation-xml><annotation-xml encoding="TEXT/HTML"><br></annotation-xml></math>{% endif %}')),
    ).toEqual([]);
    // Balanced branches are fine.
    expect(messages(withItem('{% if item %}<b>a</b>{% elsif site %}<i>b</i>{% else %}c{% endif %}{% for c in list %}<p>{{ c.title }}</p>{% endfor %}'))).toEqual([]);
  });

  it('whole contract paths: nested keys, loop aliases, include parameters, property-path filters, forloop', () => {
    refused(withItem("{{ item.sponsor.secret | default: '' }}"), /variable "item.sponsor.secret"/);
    refused(withItem("{% for c in list %}{{ c.secret | default: '' }}{% endfor %}"), /variable "c.secret"/);
    refused(withItem("{{ list | map: 'secret' | join: ',' }}"), /map: 'secret'/);
    refused(withItem('{% assign s = item.sponsor %}{{ s.token }}'), /variable "s.token"/);
    refused({ ...withItem("{% include 'partials/x', z: site %}"), 'partials/x': '{{ z.password }}' }, /variable "z.password"/);
    refused(withItem('{% for c in list %}{{ forloop.parentloop }}{% endfor %}'), /variable "forloop.parentloop"/);
    // Through filters, re-assignments and filter chains (Codex review round 2).
    refused(withItem("{% assign s = item.sponsor | default: item.sponsor %}{{ s.secret | default: '' }}"), /variable "s.secret"/);
    refused(withItem("{% assign s = item.fields %}{% assign s = item.sponsor %}{{ s.secret | default: '' }}"), /variable "s.secret"/);
    refused(withItem("{{ list | reverse | map: 'secret' | join: ',' }}"), /map: 'secret'/);
    refused(withItem("{% assign l = list | sort: 'secret' %}{{ l.size }}"), /sort: 'secret'/);
    refused({ ...withItem("{% include 'partials/x', z: item.sponsor | default: item.sponsor %}"), 'partials/x': "{{ z.secret | default: '' }}" }, /variable "z.secret"/);
    refused(withItem("{% for c in list | reverse %}{{ c.secret | default: '' }}{% endfor %}"), /variable "c.secret"/);
    expect(messages({ ...withItem("{% render 'partials/c' for list as c %}"), 'partials/c': '{{ c.title }}' })).toEqual([]);
    // A fallback brings its own shape; mapped values are tracked (Codex review round 3).
    refused(withItem("{% assign s = item.fields | default: item.sponsor %}{{ s.secret | default: '' }}"), /variable "s.secret"/);
    refused(withItem("{{ list | map: 'title' | map: 'secret' | join: ',' }}"), /map: 'secret'/);
    refused(withItem("{% assign s = '' | default: item.sponsor %}{{ s.secret | default: '' }}"), /variable "s.secret"/);
    refused(withItem("{% assign s = item.title | append: '' | default: item.sponsor %}{{ s.secret | default: '' }}"), /variable "s.secret"/);
    refused(withItem("{% assign ts = list | map: 'title' %}{{ ts.first.secret }}"), /variable "ts.first.secret"/);
    expect(messages(withItem("{% assign ts = list | map: 'title' %}{{ ts.first }}{{ ts.size }}{{ list | map: 'title' | join: ', ' }}"))).toEqual([]);
    expect(messages(withItem("{% assign s = item.sponsor | default: item.sponsor %}{{ s.name }}{% assign f = list | first %}{{ f.title }}"))).toEqual([]);
    expect(
      messages(withItem("{% for c in list %}{{ c.title }}{{ c.url | url }}{{ forloop.index }}{% endfor %}{{ list.size }}{{ list[0].title }}{{ list | map: 'title' | join: ', ' }}{{ item.fields.any.depth }}{{ item.sponsor.name }}")),
    ).toEqual([]);
  });

  it('prototype paths and dynamic property access are refused', () => {
    refused(withItem('{% for c in list %}{% if forloop.__proto__ %}x{% endif %}{% endfor %}'), /property path not allowed/);
    refused(withItem("{% assign k = 'title' %}{{ item[k] }}"), /property path not allowed/);
    refused(withItem('{{ site.constructor }}'), /property path not allowed/);
    refused(withItem('{% echo item.title %}'), /tag "echo" is not allowed/);
    refused(withItem("{% cycle 'a', 'b' %}"), /tag "cycle" is not allowed/);
    // Quotes do not end an expression early (Codex review round 2) …
    refused(withItem("{% assign k = 'x' %}{% for c in list %}{{ '}}' | replace: '}}', forloop[k] }}{% endfor %}"), /property path not allowed/);
    refused(withItem("{{ item['constructor'] }}"), /property path not allowed/);
    refused(withItem("{% assign é = 'x' %}{% for c in list %}{{ forloop[é] }}{% endfor %}"), /property path not allowed/);
    refused(withItem("{% assign 0k = 'x' %}{% for c in list %}{{ forloop[0k] }}{% endfor %}"), /property path not allowed/);
    expect(messages(withItem('{{ list[0].title }}{{ list[-1].title }}'))).toEqual([]);
    // … and a forbidden word as text is fine: in a string literal, in a comment.
    expect(messages(withItem("{{ item.title | default: \"['constructor']\" }}"))).toEqual([]);
    expect(messages(withItem("{{ item.title | default: 'constructor' }}{% comment %}{{ constructor }}{% endcomment %}{% # prototype %}"))).toEqual([]);
  });

  it('SVG / MathML: no outputs in their attributes, no animation; control flow not inside <title> / <textarea>', () => {
    refused(withItem('<svg><a href="{{ item.url | url }}"><text>x</text></a></svg>'), /SVG or MathML attribute/);
    refused(withItem('<svg><a><animate attributeName="href" values="x" dur="1s"></animate></a></svg>'), /<animate> is not allowed/);
    refused(withItem('<math><mi title="{{ item.title }}">x</mi></math>'), /SVG or MathML attribute/);
    refused({ ...BUILTIN_THEME, 'partials/top': top.replace('{% seo_head %}', '{% seo_head %}<title>{% if item %}x{% endif %}</title>') }, /tags inside <title>/);
    refused(withItem('<textarea>{% if item %}</textarea>{% endif %}</textarea>'), /tags inside <textarea>|not context-neutral/);
    expect(messages(withItem('<svg viewBox="0 0 10 10"><text>{{ item.title }}</text></svg><textarea>{{ item.title }}</textarea>'))).toEqual([]);
  });

  it('partials: included in text only, bounded expansion', () => {
    refused({ ...withItem('<p title="{% include \'partials/x\' %}">x</p>'), 'partials/x': '{{ item.title }}' }, /include \/ render outside text/);
    refused({ ...withItem("<script>{% include 'partials/x' %}</script>"), 'partials/x': 'var a = 1;' }, /include \/ render outside text/);
    const chain: Record<string, string> = {};
    for (let i = 0; i < 6; i++) chain[`partials/p${i}`] = Array.from({ length: 20 }, () => `{% include 'partials/p${i + 1}' %}`).join('');
    chain['partials/p6'] = 'x';
    refused({ ...withItem("{% include 'partials/p0' %}"), ...chain }, /partial inclusions|expand to more than/);
  });

  it('filterNames ignores pipes in quotes', () => {
    expect(filterNames(" a | replace: '|', 'x' | upcase")).toEqual(['replace', 'upcase']);
    expect(filterNames('a')).toEqual([]);
  });
});

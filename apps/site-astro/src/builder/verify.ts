import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { PageDataPage, PageDataSnapshot } from '@heopress/contracts/page-data';

/**
 * Checks of a finished build before it may go live (HeoPress P11 tasks 3.3, 3.6; spec rendering/astro-engine "构建失败保留旧版本",
 * "赞助渲染一致"): every page and file of the snapshot is in the output; each page carries the system's head exactly once
 * and no other canonical or JSON-LD; an item page carries its body as the system made it; and — the Classic engine's slot
 * rules — when the site has sponsor disclosure on, a sponsored item's disclosure comes before its body, each sponsored
 * card carries exactly one disclosure and every link to a sponsored item is inside its card; with disclosure off, none.
 *
 * Run on every activation: a new build, a theme switch, enabling disclosure (a rebuild) and a rollback (the old output
 * against the current snapshot's policy). Any problem refuses the output; the live version stays.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

export interface VerifyIssue {
  path: string;
  message: string;
}

const isEl = (n: Node): n is Element => 'tagName' in n;
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const kids = (n: Node): Node[] => ('childNodes' in n ? (n.childNodes as Node[]) : []);
const textOf = (n: Node): string => ('value' in n && n.nodeName === '#text' ? (n as { value: string }).value : kids(n).map(textOf).join(''));
const hasClass = (el: Element, c: string) => (attr(el, 'class') ?? '').split(/\s+/).includes(c);

/** Where a link really goes (origin + path without trailing slash), or null. */
function destination(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** The output file of a page path (directory format). */
export function pageFile(outDir: string, path: string): string {
  const decoded = decodeURI(path).replace(/\/+$/, '');
  const file = resolve(outDir, `.${decoded}`, 'index.html');
  if (!file.startsWith(resolve(outDir) + sep)) throw new Error(`page outside the output: ${path}`);
  return file;
}

function count(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** The sponsor and slot rules of one rendered page (shared with the parity test). */
export function checkSponsorSlots(html: string, page: PageDataPage, origin: string): string[] {
  const problems: string[] = [];
  const doc = parse(html) as unknown as Node;
  const all: Array<{ el: Element; order: number; card: Element | null }> = [];
  let order = 0;
  const walk = (n: Node, card: Element | null) => {
    if (isEl(n)) {
      order++;
      const c = attr(n, 'data-heopress-card') !== undefined ? n : card;
      all.push({ el: n, order, card: c === n ? card : c });
      for (const k of kids(n)) walk(k, c);
      return;
    }
    for (const k of kids(n)) walk(k, card);
  };
  walk(doc, null);
  const disclosures = all.filter((f) => f.el.tagName === 'aside' && hasClass(f.el, 'heopress-disclosure'));
  const { vm } = page;
  if (!page.disclosureRequired) {
    if (disclosures.length) problems.push('a sponsor disclosure while the site has disclosure off');
  } else {
    const item = vm.item;
    if (vm.page.type === 'item' && item?.sponsor.sponsored) {
      const body = all.find((f) => f.el.tagName === 'div' && hasClass(f.el, 'heopress-body'));
      const own = disclosures.find((d) => !d.card && textOf(d.el) === page.disclosures[item.id]);
      if (!own) problems.push('sponsored item: its disclosure is missing');
      else if (body && own.order > body.order) problems.push('sponsored item: the disclosure must come before the body');
    }
    const cards = all.filter((f) => attr(f.el, 'data-heopress-card') !== undefined);
    for (const c of vm.list.filter((x) => x.sponsored)) {
      const mine = cards.filter((f) => attr(f.el, 'data-heopress-card') === c.id);
      for (const card of mine) {
        const inside = disclosures.filter((d) => d.card === card.el && textOf(d.el) === page.disclosures[c.id]);
        if (inside.length !== 1) problems.push(`sponsored card ${c.id}: exactly one disclosure is required inside it`);
      }
      const base = new URL(vm.page.path, origin).toString();
      const target = destination(c.url, base);
      for (const link of all.filter((f) => (f.el.tagName === 'a' || f.el.tagName === 'area') && attr(f.el, 'href') !== undefined)) {
        if (target && destination(attr(link.el, 'href')!, base) === target) {
          const card = link.card ?? (attr(link.el, 'data-heopress-card') !== undefined ? link.el : null);
          if (!card || attr(card, 'data-heopress-card') !== c.id) problems.push(`a link to sponsored item ${c.id} outside its card`);
        }
      }
    }
  }
  return problems;
}

function checkPage(html: string, page: PageDataPage, origin: string): string[] {
  const problems: string[] = [];
  if (count(html, page.headHtml) !== 1) problems.push('the system head is missing, altered or repeated');
  const canonicals = count(html, 'rel="canonical"');
  if (canonicals !== count(page.headHtml, 'rel="canonical"')) problems.push('a canonical outside the system head');
  if (count(html, 'application/ld+json') !== count(page.headHtml, 'application/ld+json')) problems.push('JSON-LD outside the system head');
  if (page.vm.page.type === 'item' && page.vm.item) {
    const body = `<div class="heopress-body">${page.bodies[page.vm.item.id] ?? ''}</div>`;
    if (count(html, body) !== 1) problems.push('the item body is missing, altered or repeated');
  }
  problems.push(...checkSponsorSlots(html, page, origin));
  return problems;
}

export async function verifyBuild(outDir: string, snapshot: PageDataSnapshot): Promise<VerifyIssue[]> {
  const issues: VerifyIssue[] = [];
  const read = (file: string) => readFile(file, 'utf8').catch(() => null);
  for (const page of snapshot.pages) {
    const html = await read(pageFile(outDir, page.path));
    if (html === null) {
      issues.push({ path: page.path, message: 'page missing from the output' });
      continue;
    }
    for (const message of checkPage(html, page, snapshot.origin)) issues.push({ path: page.path, message });
  }
  if (snapshot.notFound) {
    const html = await read(join(outDir, '404.html'));
    if (html === null) issues.push({ path: '/404.html', message: 'not-found page missing' });
    else for (const message of checkPage(html, snapshot.notFound, snapshot.origin)) issues.push({ path: '/404.html', message });
  }
  for (const file of snapshot.files) {
    const body = await read(resolve(outDir, `.${decodeURI(file.path)}`));
    if (body !== file.body) issues.push({ path: file.path, message: body === null ? 'file missing from the output' : 'file differs from the system output' });
  }
  return issues;
}

import { llmsEntry, pageTypeOfCollection } from '@heopress/seo-geo';
import { resolvePublicPathWith, type PublicReadPort } from '@heopress/public-site';
import { MARKDOWN_TYPE, markdownUrlOf, pageMarkdown } from './discovery';
import { markdownBodyOf, type DiscoveryAnswer } from './discovery-plan';
import type { SiteReads } from './read-port';
import { discoveryPageOf, type SiteInfo } from './view-model';

/**
 * A page's Markdown copy (HeoPress P07 task 4.2; spec geo/machine-readable-content "Markdown 副本"): at its own address
 * with `.md` in place of the trailing slash (`/2026/10/hello/` → `/2026/10/hello.md`), for an article or page that is
 * indexable and canonical to itself, while the site has copies on. It says its title, description, address and dates,
 * then its body; it is never indexed itself (`X-Robots-Tag: noindex`) and names the page as canonical (`Link`). A real
 * route ending in `.md` is answered as itself first (the caller tries this only when the path is no item).
 */

export async function markdownCopyAnswer(
  port: PublicReadPort,
  reads: SiteReads,
  site: SiteInfo,
  host: string,
  path: string,
): Promise<DiscoveryAnswer | null> {
  if (!site.seo?.discovery.markdownCopies || !path.endsWith('.md') || path.length <= 4) return null;
  const base = path.slice(0, -3);
  let itemId: string | null = null;
  for (const candidate of [`${base}/`, base]) {
    const r = await resolvePublicPathWith(port, { host, path: candidate, query: '' });
    if (r.kind === 'item') {
      itemId = r.itemId;
      break;
    }
  }
  if (!itemId) return null;
  const row = await reads.item(itemId);
  if (!row || pageTypeOfCollection(row.collection) !== 'item') return null;
  // Listable (indexable, canonical to itself), and this is its copy's own address on its own host.
  const entry = llmsEntry(discoveryPageOf(site, row));
  if (!entry) return null;
  const own = markdownUrlOf(entry.url);
  if (!own) return null;
  const at = new URL(own);
  if (at.host.toLowerCase() !== host.toLowerCase() || at.pathname !== path) return null;
  return {
    body: pageMarkdown({
      title: entry.title,
      description: entry.description,
      url: entry.url,
      published: row.publishedAt?.toISOString() ?? null,
      modified: row.contentModifiedAt?.toISOString() ?? null,
      body: markdownBodyOf(row, entry.url),
    }),
    contentType: MARKDOWN_TYPE,
    headers: { 'X-Robots-Tag': 'noindex', Link: `<${entry.url}>; rel="canonical"` },
  };
}

import { extractDocument, type ExtractedDocument } from '../extract';
import type { FetchedPage } from '../fetcher';
import type { CrawlResult } from './types';

/**
 * A crawl service's answer through the native extraction (HeoPress P08 task 3.2): hidden-content stripping,
 * Readability, the allow-list sanitiser and the quality check are the same code as for a native fetch. A service that
 * returns only Markdown has it turned into plain HTML first (escaped text; headings, paragraphs, lists, quotes, code
 * and http(s) links only), so nothing the service sends reaches storage unsanitised.
 */

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s: string): string {
  return escape(s)
    .replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => `<a href="${u}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Minimal Markdown → HTML for extraction (not a general renderer). */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
    para = [];
    list = [];
  };
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (code) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      flush();
      code = [];
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    const q = /^>\s?(.*)$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(6, Math.max(2, h[1]!.length));
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
    } else if (li) {
      if (para.length) flush();
      list.push(li[1]!);
    } else if (q) {
      flush();
      out.push(`<blockquote><p>${inline(q[1]!)}</p></blockquote>`);
    } else if (!line.trim()) flush();
    else {
      if (list.length) flush();
      para.push(line.trim());
    }
  }
  if (code) out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  flush();
  return out.join('\n');
}

function documentHtml(r: CrawlResult): string {
  if (r.html?.trim()) return r.html;
  const lang = r.language ? ` lang="${escape(r.language)}"` : '';
  return `<!doctype html><html${lang}><head><meta charset="utf-8"><title>${escape(r.title)}</title></head><body><article>${r.title ? `<h1>${escape(r.title)}</h1>` : ''}${markdownToHtml(r.markdown)}</article></body></html>`;
}

/** The page (for the snapshot) and the extracted document. Throws `IngestFetchError` like `extractDocument`. */
export function extractCrawlResult(r: CrawlResult): { page: FetchedPage; extracted: ExtractedDocument } {
  const html = documentHtml(r);
  const extracted = extractDocument(html, r.finalUrl);
  const publishedAt = extracted.publishedAt ?? (r.publishedAt && !Number.isNaN(Date.parse(r.publishedAt)) ? new Date(r.publishedAt) : null);
  const page: FetchedPage = {
    url: r.finalUrl,
    finalUrl: r.finalUrl,
    status: r.targetStatus ?? 200,
    contentType: 'text/html; charset=utf-8',
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    body: Buffer.from(html, 'utf-8'),
    durationMs: r.durationMs,
  };
  return {
    page,
    extracted: {
      ...extracted,
      title: extracted.title || r.title,
      author: extracted.author ?? (r.author ? r.author.slice(0, 300) : null),
      language: extracted.language ?? r.language ?? null,
      publishedAt,
      ruleVersion: `${extracted.ruleVersion}+${r.provider}`,
    },
  };
}

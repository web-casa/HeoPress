/**
 * The correction notice a report becomes (pure: no host, no I/O).
 *
 * One report produces one notice item of `heopress_corrections__notices`. The notice is a **draft**: the plugin never
 * publishes a reader's text by itself; a person edits and publishes it, and that publish is what makes the notice public
 * and writes the correction block into the article.
 *
 * Its slug is derived from the report id (`correction-<report id>`), so a second notice for the same report could not
 * take a second path even if the ledger were lost: the site's unique content path refuses it.
 *
 * Nothing of the reporter is copied into the notice — no name, no e-mail, no comment, no user agent, no address. What
 * the public record carries is the corrected page, the quoted passage and the correction itself.
 */

/** The report a notice is made of: ids and the three public fields, never the reporter. */
export interface ReportSource {
  reportId: string;
  pagePath: string;
  excerpt: string;
  correction: string;
}

/** The article a notice is attached to, as resolved when the report is accepted. */
export interface TargetArticle {
  id: string;
  title: string;
  locale: string;
}

/** The notice's path segment: one per report, derived from the report id. */
export function noticeSlug(reportId: string): string {
  return `correction-${reportId}`;
}

/** The notice's title: the article's title, or the page path when the article could not be resolved. */
export function noticeTitle(report: ReportSource, article: TargetArticle | null): string {
  const subject = article && article.title.trim() ? article.title.trim() : report.pagePath;
  return `Correction: ${subject}`.slice(0, 200);
}

/**
 * The data of the notice item. `report_id` and `article_id` are hidden fields (never public): the report id links back
 * to the moderation queue, the article id is how the plugin finds the page to correct even after its path changed.
 */
export function noticeDocument(report: ReportSource, article: TargetArticle | null, now: Date): Record<string, unknown> {
  return {
    title: noticeTitle(report, article),
    slug: noticeSlug(report.reportId),
    locale: article?.locale ?? '',
    page_path: report.pagePath,
    excerpt: report.excerpt,
    correction: report.correction,
    corrected_on: now.toISOString(),
    report_id: report.reportId,
    article_id: article?.id ?? '',
  };
}

/** The day a notice is about, `YYYY-MM-DD` (UTC), as the correction block prints it. */
export function correctionDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The last non-empty segment of a page path, percent-decoded: the article's slug or id, as the site's permalink ends. */
export function lastPathSegment(pagePath: string): string {
  const segments = pagePath.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return '';
  }
}

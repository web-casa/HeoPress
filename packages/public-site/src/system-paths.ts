/**
 * The top-level paths a public site keeps for itself (HeoPress P07 task 1.5): discovery files and site
 * root files are answered by the system, before any content path, so no content may take them. Shared by
 * the CMS (path validation) and the rendering service (routing); the database function
 * `heopress_is_system_path` (migration 0050) is its mirror for upgrade checks, kept equal by a test.
 *
 *   - discovery files: `robots.txt`, `sitemap*.xml`, `sitemap.txt`, `news-sitemap*.xml`, feeds
 *     (`feed`, `rss`, `atom`, with or without a suffix and `.xml`), `llms.txt`, `llms-full.txt`;
 *   - `.well-known/` (and `well-known`);
 *   - site root files and the IndexNow key file: any top-level name with one of the extensions below.
 */

const ROOT_FILE_EXTENSIONS = ['txt', 'xml', 'html', 'htm', 'json', 'webmanifest', 'ico'] as const;

const PATTERNS: readonly RegExp[] = [
  /^(feed|rss|atom)([-_.][a-z0-9-]+)*$/,
  /^\.?well-known$/,
  new RegExp(`^[^/]+\\.(${ROOT_FILE_EXTENSIONS.join('|')})$`),
];

/** Whether a first path segment (as stored: decoded, without slashes) is the system's. Case-insensitive. */
export function isSystemPathSegment(segment: string): boolean {
  const s = segment.toLowerCase();
  return PATTERNS.some((p) => p.test(s));
}

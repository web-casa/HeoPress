/**
 * robots.txt (HeoPress P08 task 2.2; spec ingest/crawling "礼貌抓取"), after RFC 9309.
 *
 * - Groups: one or more `user-agent` lines followed by rules. The group whose product token matches our agent token
 *   (case-insensitive substring of the token) wins; otherwise the `*` group; no group: everything allowed. Several
 *   matching groups are merged.
 * - Rules: `allow` / `disallow` with `*` (any run of characters) and a trailing `$` (end of URL). The longest matching
 *   pattern wins; on a tie `allow` wins. An empty `disallow` allows everything.
 * - Fetching (see `fetcher.ts`): 2xx → parse; 4xx → no restrictions; 5xx or unreachable → treat the host as fully
 *   disallowed for now (a retryable failure, not `access_denied`).
 * - Cache: per process, per origin; 24 h for a parsed file or a 4xx, 10 minutes for an unreachable one. A cache is
 *   only an optimisation: two worker processes may each fetch a host's robots.txt once per TTL.
 */

interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

export interface RobotsPolicy {
  /** True when `pathAndQuery` (e.g. `/a/b?x=1`) may be fetched by `agent`. */
  isAllowed(pathAndQuery: string): boolean;
}

const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true };
const DISALLOW_ALL: RobotsPolicy = { isAllowed: () => false };

function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/** Percent-encoding normalised so `/a%2fb` and `/a%2Fb` compare equal; unreserved characters decoded. */
function normalizePath(p: string): string {
  return p.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

/** Parse a robots.txt body for `agentToken` (e.g. `HeoPressBot`). */
export function parseRobots(body: string, agentToken: string): RobotsPolicy {
  const token = agentToken.toLowerCase();
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  // RFC 9309 asks crawlers to parse at least 500 KiB.
  for (const rawLine of body.slice(0, 512 * 1024).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && value === '') continue; // allows everything
      const pattern = normalizePath(value.startsWith('/') || value.startsWith('*') ? value : `/${value}`);
      current.rules.push({ allow: key === 'allow', pattern, regex: compile(pattern) });
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && (token.includes(a) || a.includes(token))));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  if (!rules.length) return ALLOW_ALL;
  return {
    isAllowed(pathAndQuery: string): boolean {
      const path = normalizePath(pathAndQuery || '/');
      if (path === '/robots.txt') return true;
      let best: Rule | null = null;
      for (const r of rules) {
        if (!r.regex.test(path)) continue;
        const len = r.pattern.replace(/\$$/, '').length;
        const bestLen = best ? best.pattern.replace(/\$$/, '').length : -1;
        if (len > bestLen || (len === bestLen && r.allow && !best!.allow)) best = r;
      }
      return best ? best.allow : true;
    },
  };
}

export type RobotsFetchResult =
  | { kind: 'ok'; body: string }
  | { kind: 'client_error' }
  | { kind: 'unavailable'; reason: string };

export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
export const ROBOTS_ERROR_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  policy: RobotsPolicy;
  unavailable?: string;
  expiresAt: number;
}

/** Per-process robots.txt cache keyed by origin. */
export class RobotsCache {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(private readonly maxEntries = 5000) {}

  /**
   * The policy for `origin`, fetched with `load` when missing or stale. `unavailable` is set when robots.txt could
   * not be read (5xx / network): the caller fails the fetch as retryable.
   */
  async policyFor(
    origin: string,
    agentToken: string,
    load: () => Promise<RobotsFetchResult>,
    now: number = Date.now(),
    /** Errors that must reach the caller instead of counting as "unavailable" (security refusals). */
    rethrow: (err: unknown) => boolean = () => false,
  ): Promise<{ policy: RobotsPolicy; unavailable?: string }> {
    const hit = this.entries.get(origin);
    if (hit && hit.expiresAt > now) return hit;
    let entry: CacheEntry;
    const res = await load().catch((err: unknown): RobotsFetchResult => {
      if (rethrow(err)) throw err;
      return { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    });
    if (res.kind === 'ok') entry = { policy: parseRobots(res.body, agentToken), expiresAt: now + ROBOTS_TTL_MS };
    else if (res.kind === 'client_error') entry = { policy: ALLOW_ALL, expiresAt: now + ROBOTS_TTL_MS };
    else entry = { policy: DISALLOW_ALL, unavailable: res.reason, expiresAt: now + ROBOTS_ERROR_TTL_MS };
    if (this.entries.size >= this.maxEntries) {
      const first = this.entries.keys().next().value;
      if (first !== undefined) this.entries.delete(first);
    }
    this.entries.set(origin, entry);
    return entry;
  }

  clear(): void {
    this.entries.clear();
  }
}

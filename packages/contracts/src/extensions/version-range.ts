/**
 * The HeoPress version range a plugin manifest requires (P12 task 1.5, spec extensions/permissions "插件清单").
 *
 * A small, dependency-free subset of semver ranges: space-separated comparators (`>=1.0.0 <2.0.0`), alternatives
 * joined by `||`, caret (`^1.2.0`), tilde (`~1.2.0`), x-ranges (`1.x`, `1.2.*`, `*`) and exact versions.
 * Pre-release tags compare below their release (`1.0.0-rc.4 < 1.0.0`) and are matched by a comparator of the same
 * major.minor.patch, so an `^1.0.0-rc.1` plugin installs on `1.0.0-rc.4`.
 */

interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(raw: string): Version | null {
  const m = VERSION.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

export function compareVersions(a: Version, b: Version): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

type Comparator = { op: '>=' | '<=' | '>' | '<' | '='; v: Version };

const v = (major: number, minor: number, patch: number, pre: string[] = []): Version => ({ major, minor, patch, pre });

function partial(raw: string): { parts: number[]; pre: string[] } | null {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(raw);
  if (!m) return null;
  const parts: number[] = [];
  for (const p of [m[1], m[2], m[3]]) {
    if (p === undefined || /^[xX*]$/.test(p)) break;
    parts.push(Number(p));
  }
  return { parts, pre: m[4] ? m[4].split('.') : [] };
}

function comparators(token: string): Comparator[] | null {
  if (token === '*' || token === 'x' || token === 'X' || token === '') return [];
  const op = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token)!;
  const p = partial(op[2]!);
  if (!p) return null;
  const [M, m, pt] = p.parts;
  const full = p.parts.length === 3 ? v(M!, m!, pt!, p.pre) : null;
  switch (op[1]) {
    case '^': {
      const lo = v(M ?? 0, m ?? 0, pt ?? 0, p.pre);
      const hi = M! > 0 || p.parts.length < 2 ? v(M! + 1, 0, 0) : m! > 0 || p.parts.length < 3 ? v(0, m! + 1, 0) : v(0, 0, pt! + 1);
      return [{ op: '>=', v: lo }, { op: '<', v: { ...hi, pre: ['0'] } }];
    }
    case '~': {
      const lo = v(M ?? 0, m ?? 0, pt ?? 0, p.pre);
      const hi = p.parts.length >= 2 ? v(M!, m! + 1, 0) : v(M! + 1, 0, 0);
      return [{ op: '>=', v: lo }, { op: '<', v: { ...hi, pre: ['0'] } }];
    }
    case '>':
    case '>=':
    case '<':
    case '<=':
      if (full) return [{ op: op[1], v: full }];
      if (op[1] === '>=' || op[1] === '<') return [{ op: op[1], v: v(M ?? 0, m ?? 0, 0) }];
      return null;
    default:
      if (full) return [{ op: '=', v: full }];
      if (p.parts.length === 0) return [];
      return [
        { op: '>=', v: v(M!, m ?? 0, 0) },
        { op: '<', v: { ...(p.parts.length === 1 ? v(M! + 1, 0, 0) : v(M!, m! + 1, 0)), pre: ['0'] } },
      ];
  }
}

function test(c: Comparator, version: Version): boolean {
  const r = compareVersions(version, c.v);
  switch (c.op) {
    case '>=': return r >= 0;
    case '<=': return r <= 0;
    case '>': return r > 0;
    case '<': return r < 0;
    default: return r === 0;
  }
}

/** Parse a range; null when it is not one this module understands (treated as invalid by the manifest schema). */
export function parseVersionRange(range: string): Comparator[][] | null {
  const sets: Comparator[][] = [];
  for (const alt of range.split('||')) {
    const set: Comparator[] = [];
    const tokens = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const cs = comparators(token);
      if (!cs) return null;
      set.push(...cs);
    }
    sets.push(set);
  }
  return sets.length > 0 ? sets : null;
}

export function isValidVersionRange(range: string): boolean {
  return parseVersionRange(range) !== null;
}

/** Whether `version` satisfies `range`; false for an unparseable version or range. */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const ver = parseVersion(version);
  const sets = parseVersionRange(range);
  if (!ver || !sets) return false;
  return sets.some((set) => set.every((c) => test(c, ver)));
}

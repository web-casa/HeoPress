/**
 * The redirect engine (HeoPress P05 tasks 1.6–1.8, 3.1–3.5; design B and
 * the redirect contract R33–R37). Pure: no database.
 *
 * Locations are `(host, path)` in the site's external path space: content
 * rules are mapped to external paths (language prefix, language host) by
 * the caller, and paths are kept bare — no trailing slash (the slash policy
 * is applied to the result, so it is a fixed point). A rule matches by its
 * original priority: exact before prefix, a longer prefix before a shorter
 * one, a prefix only at a segment boundary and keeping the rest of the path;
 * equal candidates go URL layer, then system rules (language root), then
 * content layer, then id.
 *
 * `followRules` applies rules until none matches (or a caller-supplied stop,
 * e.g. a live item, holds), remembering every state: a repeated state is a
 * loop; a step cap `(N + 1)(L + 1)` guards against bad data separately (R33,
 * R37) — a rule set `validateRules` accepted never reaches it.
 *
 * `validateRules` keeps the subset that provably terminates (R34–R36): a
 * conservative dependency graph links rule X to every rule Y that could match
 * X's target (shadowed ones included); acyclic components and components of
 * strictly shortening prefix rules only (R38) are accepted; any other cyclic
 * component is rejected — as a loop when a concrete path shows one, else as
 * needing a person — and the remaining rules are checked again until nothing
 * more is rejected.
 */

export interface Loc {
  host: string;
  /** Bare path: `/` or `/a/b` (no trailing slash). */
  path: string;
}

type RuleLayer = 'url' | 'system' | 'content';

export interface EngineRule {
  id: string;
  layer: RuleLayer;
  host: string;
  from: string;
  match: 'exact' | 'prefix';
  toHost: string;
  to: string;
}

const LAYER_ORDER: Record<RuleLayer, number> = { url: 0, system: 1, content: 2 };

export function segmentsOf(path: string): string[] {
  return path === '/' ? [] : path.slice(1).split('/');
}

export function pathOf(segments: string[]): string {
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/** Whether `a` is `b` or one of its ancestors (segment-wise). */
function isAncestorOrSelf(a: string, b: string): boolean {
  const as = segmentsOf(a);
  const bs = segmentsOf(b);
  return as.length <= bs.length && as.every((s, i) => s === bs[i]);
}

/** Every path a rule may start at for `path`: the path and its ancestors, root last. */
export function ancestorsOf(path: string): string[] {
  const segs = segmentsOf(path);
  return Array.from({ length: segs.length + 1 }, (_, i) => pathOf(segs.slice(0, segs.length - i)));
}

function matches(rule: EngineRule, loc: Loc): boolean {
  if (rule.host !== loc.host) return false;
  return rule.match === 'exact' ? rule.from === loc.path : isAncestorOrSelf(rule.from, loc.path);
}

/** The rule that applies at `loc` among `candidates`, by original priority (or null). */
export function pickRule(candidates: EngineRule[], loc: Loc): EngineRule | null {
  let best: EngineRule | null = null;
  for (const r of candidates) {
    if (!matches(r, loc)) continue;
    if (!best || compareRules(r, best) < 0) best = r;
  }
  return best;
}

function compareRules(a: EngineRule, b: EngineRule): number {
  if (a.match !== b.match) return a.match === 'exact' ? -1 : 1;
  if (a.match === 'prefix') {
    const d = segmentsOf(b.from).length - segmentsOf(a.from).length;
    if (d !== 0) return d;
  }
  if (a.layer !== b.layer) return LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function applyRule(rule: EngineRule, loc: Loc): Loc {
  if (rule.match === 'exact') return { host: rule.toHost, path: rule.to };
  const rest = segmentsOf(loc.path).slice(segmentsOf(rule.from).length);
  return { host: rule.toHost, path: pathOf([...segmentsOf(rule.to), ...rest]) };
}

/** R33's resource guard: `(rules + 1) × (max(request segments, longest target in segments) + 1)`. */
export function stepLimit(ruleCount: number, requestPath: string, maxTargetSegments: number): number {
  return (ruleCount + 1) * (Math.max(segmentsOf(requestPath).length, maxTargetSegments) + 1);
}

export type FollowResult =
  | { kind: 'end'; loc: Loc; steps: number; stopped: boolean }
  | { kind: 'loop'; loc: Loc; steps: number }
  | { kind: 'limit'; loc: Loc; steps: number };

/**
 * Apply rules from `start` until none matches or `stop(loc)` holds. `lookup` returns the candidate
 * rules for a location (all of them, or the ones the database finds for its path).
 */
export async function followRules(
  start: Loc,
  lookup: (loc: Loc) => EngineRule[] | Promise<EngineRule[]>,
  opts: { limit: number; stop?: (loc: Loc) => boolean | Promise<boolean> },
): Promise<FollowResult> {
  const seen = new Set<string>();
  let loc = start;
  for (let steps = 0; ; steps++) {
    const key = `${loc.host}\u0000${loc.path}`;
    if (seen.has(key)) return { kind: 'loop', loc, steps };
    seen.add(key);
    if (opts.stop && (await opts.stop(loc))) return { kind: 'end', loc, steps, stopped: true };
    const rule = pickRule(await lookup(loc), loc);
    if (!rule) return { kind: 'end', loc, steps, stopped: false };
    if (steps >= opts.limit) return { kind: 'limit', loc, steps };
    loc = applyRule(rule, loc);
  }
}

/** Whether rule `y` could match some location rule `x` leads to (R34, R36: shadowed rules included). */
function mayMatch(x: EngineRule, y: EngineRule): boolean {
  if (y.host !== x.toHost) return false;
  if (x.match === 'exact') return y.match === 'exact' ? y.from === x.to : isAncestorOrSelf(y.from, x.to);
  // A prefix target is the target itself or anything below it.
  return y.match === 'exact' ? isAncestorOrSelf(x.to, y.from) : isAncestorOrSelf(y.from, x.to) || isAncestorOrSelf(x.to, y.from);
}

/**
 * The edges of the dependency graph without comparing every pair: rules that could match a target
 * start at one of its ancestors (looked up by key) or, for a prefix target, below it (a range of the
 * sorted keys).
 */
/** The most dependency edges a check builds (memory and time are bounded; a larger rule set is refused). */
const MAX_EDGES = 2_000_000;

/** A rule set whose dependency graph is too dense to check within bounds (many prefix rules into one target). */
export class RuleSetTooComplexError extends Error {
  constructor() {
    super(`The redirect rules depend on each other too densely to check (more than ${MAX_EDGES} links): split or simplify them.`);
  }
}

function dependencyEdges(rules: EngineRule[]): number[][] {
  let total = 0;
  const keyOf = (host: string, path: string) => `${host}\u0000${path}`;
  const byKey = new Map<string, number[]>();
  rules.forEach((r, i) => {
    const k = keyOf(r.host, r.from);
    byKey.set(k, [...(byKey.get(k) ?? []), i]);
  });
  const sorted = [...byKey.keys()].sort();
  const lowerBound = (k: string) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < k) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return rules.map((x) => {
    const out = new Set<number>();
    for (const a of ancestorsOf(x.to)) for (const j of byKey.get(keyOf(x.toHost, a)) ?? []) if (mayMatch(x, rules[j]!)) out.add(j);
    if (x.match === 'prefix') {
      const start = keyOf(x.toHost, x.to === '/' ? '/' : `${x.to}/`);
      for (let i = lowerBound(start); i < sorted.length && sorted[i]!.startsWith(start); i++) {
        for (const j of byKey.get(sorted[i]!)!) if (mayMatch(x, rules[j]!)) out.add(j);
      }
    }
    total += out.size;
    if (total > MAX_EDGES) throw new RuleSetTooComplexError();
    return [...out];
  });
}

/** Strongly connected components (Tarjan), each with whether it has a cycle. */
function components(rules: EngineRule[], edges: number[][]): Array<{ members: number[]; cyclic: boolean }> {
  const index = new Array<number>(rules.length).fill(-1);
  const low = new Array<number>(rules.length).fill(0);
  const onStack = new Array<boolean>(rules.length).fill(false);
  const stack: number[] = [];
  const out: Array<{ members: number[]; cyclic: boolean }> = [];
  let next = 0;
  // Iterative, so a long chain of rules cannot overflow the call stack.
  for (let root = 0; root < rules.length; root++) {
    if (index[root] !== -1) continue;
    const work: Array<{ v: number; i: number }> = [{ v: root, i: 0 }];
    index[root] = low[root] = next++;
    stack.push(root);
    onStack[root] = true;
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const { v } = frame;
      if (frame.i < edges[v]!.length) {
        const w = edges[v]![frame.i++]!;
        if (index[w] === -1) {
          index[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = true;
          work.push({ v: w, i: 0 });
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, index[w]!);
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.v;
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === index[v]) {
        const members: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = false;
          members.push(w);
        } while (w !== v);
        out.push({ members, cyclic: members.length > 1 || edges[v]!.includes(v) });
      }
    }
  }
  return out;
}

/**
 * A prefix rule whose target has fewer segments than its source (`/blog → /`, `/en → /`): it keeps the
 * rest of the path, so every application makes the path strictly shorter (design R38).
 */
function strictlyShortens(rule: EngineRule): boolean {
  return rule.match === 'prefix' && segmentsOf(rule.to).length < segmentsOf(rule.from).length;
}

export interface RejectedRule {
  rule: EngineRule;
  /** `loop`: a concrete path loops; `manual`: no loop found, but termination cannot be shown. */
  reason: 'loop' | 'manual';
}

/** The subset of `rules` that provably terminates, and the rest with the reason (R34–R36). */
export async function validateRules(rules: EngineRule[]): Promise<{ accepted: EngineRule[]; rejected: RejectedRule[] }> {
  let current = rules;
  const rejected: RejectedRule[] = [];
  for (;;) {
    const edges = dependencyEdges(current);
    const out = new Set<number>();
    const witness = witnessSearch(current);
    for (const c of components(current, edges)) {
      if (!c.cyclic) continue;
      // Only strictly shortening prefix rules: no application in the component can come back to a state (R38).
      if (c.members.every((m) => strictlyShortens(current[m]!))) continue;
      const only = c.members.length === 1 ? current[c.members[0]!]! : null;
      // A prefix rule into its own subtree grows the path forever: no state repeats, nothing to search.
      const reason = only && grows(only) ? 'manual' : (await witness(c.members)) ? 'loop' : 'manual';
      for (const m of c.members) {
        out.add(m);
        rejected.push({ rule: current[m]!, reason });
      }
    }
    if (out.size === 0) return { accepted: current, rejected };
    current = current.filter((_, i) => !out.has(i));
  }
}

/** A prefix rule whose target is strictly below its source on the same host (`/a → /a/b`). */
function grows(rule: EngineRule): boolean {
  return rule.match === 'prefix' && rule.host === rule.toHost && rule.to !== rule.from && isAncestorOrSelf(rule.from, rule.to);
}

/**
 * Steps one component's loop search may spend, in all and per start. The search only decides how a
 * rejected component is reported (`loop` or `manual`) — it is rejected either way —, so cutting it short
 * is safe; a loop among k rules repeats a state within a few rounds of them.
 */
const WITNESS_BUDGET = 2_000;
const witnessStepsPerStart = (members: number) => 16 * (members + 1);

/**
 * The loop search over the current rule set: a concrete path from a component's rules — each rule's
 * source and target, a prefix rule's source with one more segment — resolved with the rules looked up
 * by key (not scanned), within a step budget.
 */
function witnessSearch(rules: EngineRule[]): (members: number[]) => Promise<boolean> {
  const byKey = new Map<string, EngineRule[]>();
  for (const r of rules) {
    const k = `${r.host}\u0000${r.from}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const lookup = (loc: Loc) => ancestorsOf(loc.path).flatMap((a) => byKey.get(`${loc.host}\u0000${a}`) ?? []);
  const maxTarget = Math.max(0, ...rules.map((r) => segmentsOf(r.to).length));
  return async (members) => {
    let budget = WITNESS_BUDGET;
    for (const m of members) {
      const r = rules[m]!;
      const starts: Loc[] = [{ host: r.host, path: r.from }, { host: r.toHost, path: r.to }];
      if (r.match === 'prefix') starts.push({ host: r.host, path: pathOf([...segmentsOf(r.from), '\u0000x']) });
      for (const start of starts) {
        if (budget <= 0) return false;
        const limit = Math.min(budget, witnessStepsPerStart(members.length), stepLimit(rules.length, start.path, maxTarget));
        const result = await followRules(start, lookup, { limit });
        if (result.kind === 'loop') return true;
        budget -= result.steps + 1;
      }
    }
    return false;
  };
}

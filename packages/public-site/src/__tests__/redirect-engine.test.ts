import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  followRules,
  pickRule,
  segmentsOf,
  stepLimit,
  validateRules,
  type EngineRule,
  type Loc,
} from '../redirect-engine';

/**
 * The redirect engine (HeoPress P05; spec content/site-network-model
 * "批量导入重定向"; design R33–R37): resolution by original priority until
 * nothing matches, loops and the step guard, and the rule subset that
 * provably terminates. The spec scenarios and the review counterexamples
 * are here; the property test checks that every accepted rule set resolves
 * every request without a loop, within the bound, to a fixed point.
 */

const H = 'example.com';
let n = 0;
const exact = (from: string, to: string, extra: Partial<EngineRule> = {}): EngineRule => ({ id: `r${n++}`, layer: 'url', host: H, toHost: H, from, to, match: 'exact', ...extra });
const prefix = (from: string, to: string, extra: Partial<EngineRule> = {}): EngineRule => ({ ...exact(from, to, extra), match: 'prefix' });
const at = (path: string): Loc => ({ host: H, path });
const maxTarget = (rules: EngineRule[]) => Math.max(0, ...rules.map((r) => segmentsOf(r.to).length));
const resolve = (rules: EngineRule[], path: string) => followRules(at(path), () => rules, { limit: stepLimit(rules.length, path, maxTarget(rules)) });
const verdict = async (rules: EngineRule[]) => {
  const v = await validateRules(rules);
  return { accepted: v.accepted.map((r) => r.id).sort(), rejected: v.rejected.map((r) => `${r.rule.id}:${r.reason}`).sort() };
};

describe('redirect resolution', () => {
  it('exact before prefix, the longest prefix first, at segment boundaries, keeping the rest', () => {
    const rules = [prefix('/a', '/p'), exact('/a/z', '/q'), prefix('/a/b', '/long')];
    expect(pickRule(rules, at('/a/z'))?.to).toBe('/q');
    expect(pickRule(rules, at('/a/b/c'))?.to).toBe('/long');
    expect(pickRule(rules, at('/a/y'))?.to).toBe('/p');
    expect(pickRule(rules, at('/ab'))).toBeNull();
    expect(pickRule([prefix('/', '/root')], at('/'))?.to).toBe('/root');
  });

  it('URL rules before system rules before content rules at equal priority; another host never matches', () => {
    const rules = [exact('/x', '/content', { layer: 'content', id: 'a' }), exact('/x', '/system', { layer: 'system', id: 'b' }), exact('/x', '/url', { layer: 'url', id: 'c' })];
    expect(pickRule(rules, at('/x'))?.to).toBe('/url');
    expect(pickRule(rules.slice(0, 2), at('/x'))?.to).toBe('/system');
    expect(pickRule(rules, { host: 'other.example.com', path: '/x' })).toBeNull();
  });

  it('spec "去掉旧站目录前缀": /blog → / and /foo → /bar take /blog/foo — and /blog/blog/foo — to /bar in one resolution', async () => {
    const rules = [prefix('/blog', '/'), exact('/foo', '/bar')];
    expect(await verdict(rules)).toEqual({ accepted: rules.map((r) => r.id).sort(), rejected: [] });
    expect(await resolve(rules, '/blog/foo')).toMatchObject({ kind: 'end', loc: at('/bar'), steps: 2 });
    expect(await resolve(rules, '/blog/blog/foo')).toMatchObject({ kind: 'end', loc: at('/bar'), steps: 3 });
  });

  it('spec "压平重定向链": /old → /mid and /mid → /new end at /new', async () => {
    const rules = [exact('/old', '/mid'), exact('/mid', '/new')];
    expect((await verdict(rules)).rejected).toEqual([]);
    expect(await resolve(rules, '/old')).toMatchObject({ kind: 'end', loc: at('/new') });
  });

  it('a repeated state is a loop; the step guard is reported apart', async () => {
    expect(await resolve([exact('/a', '/b'), exact('/b', '/a')], '/a')).toMatchObject({ kind: 'loop' });
    const growing = [prefix('/a', '/a/b')];
    expect(await followRules(at('/a'), () => growing, { limit: 5 })).toMatchObject({ kind: 'limit', steps: 5 });
  });

  it('a stop (a live item) ends resolution before any rule', async () => {
    const rules = [exact('/a', '/b'), exact('/b', '/c')];
    expect(await followRules(at('/a'), () => rules, { limit: 10, stop: (loc) => loc.path === '/b' })).toMatchObject({ kind: 'end', loc: at('/b'), stopped: true });
  });
});

describe('which rules may take effect (R34–R36)', () => {
  it('spec "预演发现循环": /a → /b and /b → /a are both rejected as a loop', async () => {
    const rules = [exact('/a', '/b'), exact('/b', '/a')];
    expect(await verdict(rules)).toEqual({ accepted: [], rejected: rules.map((r) => `${r.id}:loop`).sort() });
  });

  it('spec "前缀规则互相指向": prefix /a → /b and /b → /a are both rejected as a loop', async () => {
    const rules = [prefix('/a', '/b'), prefix('/b', '/a')];
    expect(await verdict(rules)).toEqual({ accepted: [], rejected: rules.map((r) => `${r.id}:loop`).sort() });
  });

  it('spec "剔除规则后重新校验": /a → /b, /b → /b (exact) and /b → /a (prefix) — none takes effect', async () => {
    const rules = [exact('/a', '/b'), exact('/b', '/b'), prefix('/b', '/a')];
    const v = await verdict(rules);
    expect(v.accepted).toEqual([]);
    expect(v.rejected).toContain(`${rules[1]!.id}:loop`);
    expect(v.rejected).toHaveLength(3);
  });

  it('review: /a/x/y ↔ /a/x is rejected and cannot be bypassed; /a → /b still applies', async () => {
    const rules = [exact('/a/x/y', '/a/x'), exact('/a/x', '/a/x/y'), prefix('/a', '/b')];
    const v = await validateRules(rules);
    expect(v.accepted.map((r) => r.id)).toEqual([rules[2]!.id]);
    expect(v.rejected.map((r) => r.reason)).toEqual(['loop', 'loop']);
    expect(await resolve(v.accepted, '/a/x/y')).toMatchObject({ kind: 'end', loc: at('/b/x/y') });
  });

  it('review: a long target fed into a shortening prefix self-loop terminates; R37: /a needs 10 shortenings and stays within the bound', async () => {
    const x5 = '/x/x/x/x/x';
    const rules = [exact('/a', `/b${x5}`), prefix('/b', `/c${x5}`), prefix('/c/x', '/c')];
    expect((await verdict(rules)).rejected).toEqual([]);
    const result = await resolve(rules, '/a');
    expect(result).toMatchObject({ kind: 'end', loc: at('/c'), steps: 12 });
    expect(result.steps).toBeLessThanOrEqual(stepLimit(rules.length, '/a', maxTarget(rules)));
  });

  it('R38: a component of strictly shortening prefix rules only is accepted (the language rule /en → / with /blog → /)', async () => {
    const rules = [prefix('/en', '/', { layer: 'system' }), prefix('/blog', '/'), exact('/foo', '/bar')];
    expect((await verdict(rules)).rejected).toEqual([]);
    expect(await resolve(rules, '/en/blog/en/foo')).toMatchObject({ kind: 'end', loc: at('/bar') });
    const pair = [prefix('/a/b', '/c'), prefix('/c/d', '/a')];
    expect((await verdict(pair)).rejected).toEqual([]);
  });

  it('R38 needs every member to shorten: one that does not makes the component unprovable', async () => {
    const rules = [prefix('/a/b', '/c/e'), prefix('/c', '/a/b')];
    expect((await verdict(rules)).accepted).toEqual([]);
  });

  it('a prefix rule that keeps growing is not provably terminating: manual, not applied', async () => {
    const rules = [prefix('/a', '/a/b'), exact('/z', '/y')];
    expect(await verdict(rules)).toEqual({ accepted: [rules[1]!.id], rejected: [`${rules[0]!.id}:manual`] });
  });

  it('rules across hosts (an alias host, a language host) link only where hosts meet', async () => {
    const zh = 'zh.example.com';
    const rules = [exact('/a', '/b', { toHost: zh }), exact('/b', '/a', { host: zh, toHost: zh })];
    // /a on H → /b on zh → /a on zh: no loop (the first rule lives on H).
    expect((await verdict(rules)).rejected).toEqual([]);
    expect(await resolve(rules, '/a')).toMatchObject({ kind: 'end', loc: { host: zh, path: '/a' } });
  });

  it('many rules: validation does not compare every pair (10,000 rules in well under a few seconds)', async () => {
    const rules = Array.from({ length: 10_000 }, (_, i) => exact(`/old/${i}`, `/new/${i}`));
    rules.push(prefix('/legacy', '/'));
    const started = Date.now();
    const v = await validateRules(rules);
    expect(v.rejected).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('validation cost of rules it must reject', () => {
  it('120 disjoint growing prefix rules (/pN → /pN/x) are rejected as manual quickly', async () => {
    const rules = Array.from({ length: 120 }, (_, i) => prefix(`/p${i}`, `/p${i}/x`));
    const started = Date.now();
    const v = await validateRules(rules);
    expect(v.rejected.map((r) => r.reason)).toEqual(Array(120).fill('manual'));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('cyclic components that do not loop stay bounded too (two-rule growing cycles)', async () => {
    const rules = Array.from({ length: 60 }, (_, i) => [prefix(`/a${i}`, `/b${i}/x`), prefix(`/b${i}`, `/a${i}/y`)]).flat();
    const started = Date.now();
    const v = await validateRules(rules);
    expect(v.accepted).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

/**
 * An independent hop-by-hop reference: one redirect per "request", rules picked by a separately
 * written priority (exact first, then the prefix with the most segments, then layer and id).
 */
function referenceHop(rules: EngineRule[], loc: Loc): Loc | null {
  const segs = (p: string) => p.split('/').filter(Boolean);
  const here = segs(loc.path);
  const hits = rules.filter((r) => {
    if (r.host !== loc.host) return false;
    const from = segs(r.from);
    if (r.match === 'exact') return from.join('/') === here.join('/');
    return from.length <= here.length && from.every((s, i) => here[i] === s);
  });
  if (hits.length === 0) return null;
  const order = { url: 0, system: 1, content: 2 } as const;
  hits.sort((a, b) =>
    a.match !== b.match ? (a.match === 'exact' ? -1 : 1) : segs(b.from).length - segs(a.from).length || order[a.layer] - order[b.layer] || a.id.localeCompare(b.id),
  );
  const r = hits[0]!;
  const rest = r.match === 'exact' ? [] : here.slice(segs(r.from).length);
  const out = [...segs(r.to), ...rest];
  return { host: r.toHost, path: out.length ? `/${out.join('/')}` : '/' };
}

describe('property: an accepted rule set always resolves, within the bound, to a fixed point', () => {
  const seg = fc.constantFrom('a', 'b', 'c');
  const path = fc.array(seg, { maxLength: 3 }).map((s) => (s.length ? `/${s.join('/')}` : '/'));
  const host = fc.constantFrom(H, 'zh.example.com');
  const rule = fc.record({ host, toHost: host, from: path, to: path, match: fc.constantFrom<'exact' | 'prefix'>('exact', 'prefix'), layer: fc.constantFrom<'url' | 'content'>('url', 'content') });

  it('no loop, no guard, and the end matches no rule', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(rule, { maxLength: 8 }), fc.array(fc.record({ host, path }), { minLength: 1, maxLength: 5 }), async (raw, requests) => {
        const rules = raw.map((r, i): EngineRule => ({ ...r, id: `p${i}` }));
        const { accepted } = await validateRules(rules);
        const limitFor = (p: string) => stepLimit(accepted.length, p, maxTarget(accepted));
        for (const start of requests) {
          const result = await followRules(start, () => accepted, { limit: limitFor(start.path) });
          expect(result.kind).toBe('end');
          // Fixed point: requesting the end again changes nothing (by the reference too).
          expect(pickRule(accepted, result.loc)).toBeNull();
          expect(referenceHop(accepted, result.loc)).toBeNull();
          // Following one redirect per request by the reference ends at the same place.
          let loc: Loc = start;
          for (let hops = 0; hops <= result.steps; hops++) {
            const next = referenceHop(accepted, loc);
            if (!next) break;
            loc = next;
          }
          expect(loc).toEqual(result.loc);
        }
      }),
      { numRuns: 300 },
    );
  });
});

/**
 * Permission rule DSL: the SQL compilation and the in-memory mirror, operator by operator (HeoPress P04 task 5,
 * P14 task 8.1).
 *
 * The DSL is evaluated twice and the two must agree: `compileWhere` keeps forbidden rows out of the query,
 * `evaluate` re-checks a written row. A divergence is a permission hole, so every operator is pinned on both sides —
 * including the shapes that must fail closed (unknown operator, unknown magic variable, `_in` without an array,
 * `_between` without two bounds).
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PolicyRule } from '@heopress/contracts';
import {
  UNKNOWN_MAGIC,
  applyFieldMask,
  compileWhere,
  evaluate,
  maskItemData,
  resolveMagic,
  type MagicContext,
} from '../permission-dsl';

const dialect = new PgDialect();

const ctx: MagicContext = {
  userId: 'usr_1',
  siteId: 'site_a',
  roleId: 'role_editor',
  ip: '203.0.113.5',
  headers: { 'x-source': 'studio' },
  now: new Date('2026-06-04T10:00:00.000Z'),
  user: { id: 'usr_1', email: 'editor@example.test', profile: { team: 'news' } },
  roles: ['role_editor'],
  policies: ['policy_editor'],
  apiKey: { id: 'key_1', name: 'Bot' },
};

/** The clause as SQL text and bind parameters; null when the DSL compiles nothing. */
function render(rule: PolicyRule | null | undefined, context: MagicContext = ctx): { sql: string; params: unknown[] } | null {
  const clause = compileWhere(rule, context);
  if (!clause) return null;
  return dialect.sqlToQuery(clause);
}

const sqlOf = (rule: PolicyRule, context: MagicContext = ctx): string => render(rule, context)?.sql ?? '';
const paramsOf = (rule: PolicyRule, context: MagicContext = ctx): unknown[] => render(rule, context)?.params ?? [];

describe('compileWhere shapes', () => {
  it('compiles nothing for a null or empty rule', () => {
    expect(compileWhere(null, ctx)).toBeUndefined();
    expect(compileWhere(undefined, ctx)).toBeUndefined();
    expect(compileWhere({} as PolicyRule, ctx)).toBeUndefined();
    expect(render({ _and: [] } as unknown as PolicyRule)).toBeNull();
    expect(render({ _or: [] } as unknown as PolicyRule)).toBeNull();
    expect(render({ _not: {} } as PolicyRule)).toBeNull();
    expect(render({ title: {} } as unknown as PolicyRule)).toBeNull();
  });

  it('joins _and with and, _or with or, and negates _not', () => {
    const and = render({ _and: [{ a: { _eq: 1 } }, { b: { _eq: 2 } }] } as unknown as PolicyRule)!;
    expect(and.sql).toBe(`"lumibase_items"."data"->>$1 = $2 and "lumibase_items"."data"->>$3 = $4`);
    expect(and.params).toEqual(['a', 1, 'b', 2]);
    const or = render({ _or: [{ a: { _eq: 1 } }, { b: { _eq: 2 } }] } as unknown as PolicyRule)!;
    expect(or.sql).toBe(`("lumibase_items"."data"->>$1 = $2 or "lumibase_items"."data"->>$3 = $4)`);
    expect(sqlOf({ _not: { a: { _eq: 1 } } } as unknown as PolicyRule)).toBe(`(not ("lumibase_items"."data"->>$1 = $2))`);
    // A combinator with one empty branch compiles only the branches that have a clause.
    expect(render({ _and: [{}, { a: { _eq: 1 } }] } as unknown as PolicyRule)!.sql).toBe(`"lumibase_items"."data"->>$1 = $2`);
    expect(render({ _or: [{}, { a: { _eq: 1 } }] } as unknown as PolicyRule)!.sql).toBe(`("lumibase_items"."data"->>$1 = $2)`);
  });

  it('maps the structural fields to columns and every other field to its jsonb key', () => {
    const structural: Array<[string, string]> = [
      ['id', '"lumibase_items"."id"'],
      ['status', '"lumibase_items"."status"'],
      ['sort', '"lumibase_items"."sort"'],
      ['user_created', '"lumibase_items"."user_created"'],
      ['user_updated', '"lumibase_items"."user_updated"'],
      ['created_at', '"lumibase_items"."created_at"'],
      ['updated_at', '"lumibase_items"."updated_at"'],
    ];
    for (const [field, column] of structural) {
      expect(sqlOf({ [field]: { _eq: 'x' } } as unknown as PolicyRule), field).toBe(`${column} = $1`);
    }
    expect(sqlOf({ title: { _eq: 'x' } } as PolicyRule)).toBe(`"lumibase_items"."data"->>$1 = $2`);
    expect(paramsOf({ title: { _eq: 'x' } } as PolicyRule)).toEqual(['title', 'x']);
  });

  it('compiles every known operator, binding its value', () => {
    const cases: Array<[Record<string, unknown>, string, unknown[] | null]> = [
      [{ _eq: 1 }, '= $2', [1]],
      [{ _neq: 1 }, '<> $2', [1]],
      [{ _in: [1, 2] }, '= any(', [1, 2]],
      [{ _nin: [1, 2] }, '<> all(', [1, 2]],
      [{ _gt: 1 }, '> $2', [1]],
      [{ _gte: 1 }, '>= $2', [1]],
      [{ _lt: 1 }, '< $2', [1]],
      [{ _lte: 1 }, '<= $2', [1]],
      [{ _contains: 'ab' }, 'ilike $2', ['%ab%']],
      [{ _starts_with: 'ab' }, 'ilike $2', ['ab%']],
      [{ _ends_with: 'ab' }, 'ilike $2', ['%ab']],
      [{ _icontains: 'AB' }, 'like $2', ['%ab%']],
      [{ _istarts_with: 'AB' }, 'like $2', ['ab%']],
      [{ _iends_with: 'AB' }, 'like $2', ['%ab']],
      [{ _between: [1, 3] }, 'between $2 and $3', [1, 3]],
      [{ _null: true }, 'is null', null],
      [{ _null: false }, 'is not null', null],
      [{ _nnull: true }, 'is not null', null],
      [{ _nnull: false }, 'is null', null],
      [{ _empty: true }, 'is null or', null],
      [{ _empty: false }, 'is not null and', null],
      [{ _nempty: true }, 'is not null and', null],
      [{ _nempty: false }, 'is null or', null],
      [{ _regex: '^a' }, '~ $2', ['^a']],
    ];
    for (const [op, fragment, params] of cases) {
      const rendered = render({ title: op } as unknown as PolicyRule)!;
      expect(rendered.sql, JSON.stringify(op)).toContain(fragment);
      if (params) expect(rendered.params, JSON.stringify(op)).toEqual(['title', ...params]);
    }
  });

  it('compiles a fail-closed `false` for malformed or unknown conditions', () => {
    const failClosed = [
      { title: { _bogus: 1 } },
      { title: { _in: 'not-an-array' } },
      { title: { _nin: 'not-an-array' } },
      { title: { _between: [1] } },
      { title: { _between: 'x' } },
      { title: { _eq: '$UNKNOWN_MAGIC' } },
      { title: { _in: ['$UNKNOWN_MAGIC'] } },
    ] as unknown as PolicyRule[];
    for (const rule of failClosed) {
      const rendered = render(rule)!;
      expect(rendered.sql, JSON.stringify(rule)).toBe('false');
    }
  });

  it('a nested fail-closed condition fails the whole rule, in any combinator', () => {
    for (const rule of [
      { _and: [{ a: { _eq: 1 } }, { b: { _bogus: 1 } }] },
      { _or: [{ a: { _eq: 1 } }, { b: { _bogus: 1 } }] },
      { _not: { b: { _bogus: 1 } } },
      { a: 5 },
      { a: { _eq: 1 } , b: 'not-an-object' },
    ] as unknown as PolicyRule[]) {
      expect(sqlOf(rule), JSON.stringify(rule)).toBe('false');
    }
  });
});

describe('evaluate mirrors the SQL', () => {
  const item = { id: 'item_1', status: 'published', title: 'Hello World', views: 10, tags: [], empty: '' };

  it('matches every operator', () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['title', { _eq: 'Hello World' }, true],
      ['title', { _eq: 'other' }, false],
      ['title', { _neq: 'other' }, true],
      ['title', { _in: ['Hello World', 'x'] }, true],
      ['title', { _in: ['x'] }, false],
      ['title', { _nin: ['x'] }, true],
      ['title', { _nin: ['Hello World'] }, false],
      ['views', { _gt: 5 }, true],
      ['views', { _gt: 50 }, false],
      ['views', { _gte: 10 }, true],
      ['views', { _lt: 50 }, true],
      ['views', { _lt: 1 }, false],
      ['views', { _lte: 10 }, true],
      ['title', { _contains: 'world' }, true],
      ['title', { _contains: 'zzz' }, false],
      ['title', { _starts_with: 'hello' }, true],
      ['title', { _starts_with: 'world' }, false],
      ['title', { _ends_with: 'WORLD' }, true],
      ['title', { _ends_with: 'hello' }, false],
      ['title', { _icontains: 'WORLD' }, true],
      ['title', { _istarts_with: 'HELLO' }, true],
      ['title', { _iends_with: 'world' }, true],
      ['views', { _between: [5, 15] }, true],
      ['views', { _between: [11, 15] }, false],
      ['title', { _regex: '^Hello' }, true],
      ['title', { _regex: '^nope' }, false],
      ['title', { _null: true }, false],
      ['title', { _null: false }, true],
      ['title', { _nnull: true }, true],
      ['title', { _nnull: false }, false],
      ['tags', { _empty: true }, true],
      ['tags', { _nempty: true }, false],
    ];
    for (const [field, op, expected] of cases) {
      expect(evaluate({ [field]: op } as unknown as PolicyRule, item, ctx), `${field} ${JSON.stringify(op)}`).toBe(expected);
    }
  });

  it('compares numbers as numbers and everything else as strings', () => {
    expect(evaluate({ views: { _gt: 9 } } as unknown as PolicyRule, item, ctx)).toBe(true);
    // A string bound compares as text: '10' sorts before '9'.
    expect(evaluate({ views: { _gt: '9' } } as PolicyRule, item, ctx)).toBe(false);
    expect(evaluate({ views: { _gte: '10' } } as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate({ status: { _lt: 'z' } } as unknown as PolicyRule, item, ctx)).toBe(true);
  });

  it('treats an empty value as null, undefined, "" or []', () => {
    for (const value of [null, undefined, '', []]) {
      expect(evaluate({ x: { _empty: true } } as unknown as PolicyRule, { x: value }, ctx), JSON.stringify(value)).toBe(true);
      expect(evaluate({ x: { _nempty: true } } as unknown as PolicyRule, { x: value }, ctx)).toBe(false);
    }
    expect(evaluate({ x: { _empty: true } } as unknown as PolicyRule, { x: 0 }, ctx)).toBe(false);
    expect(evaluate({ x: { _empty: true } } as unknown as PolicyRule, { x: ['a'] }, ctx)).toBe(false);
  });

  it('fails closed on malformed operators and values', () => {
    for (const rule of [
      { title: { _in: 'x' } },
      { title: { _nin: 'x' } },
      { title: { _between: [1] } },
      { title: { _between: 'x' } },
      { title: { _between: [1, 2] } },
      { title: { _bogus: 1 } },
      { title: { _eq: '$NOPE' } },
      { title: { _in: ['$NOPE'] } },
    ] as unknown as PolicyRule[]) {
      expect(evaluate(rule, item, ctx), JSON.stringify(rule)).toBe(false);
    }
    // `_between` on a non-numeric left side is false, not a coercion.
    expect(evaluate({ status: { _between: [1, 2] } } as unknown as PolicyRule, item, ctx)).toBe(false);
  });

  it('handles _and, _or and _not', () => {
    const rule = { _and: [{ status: { _eq: 'published' } }, { _or: [{ views: { _gt: 100 } }, { title: { _contains: 'world' } }] }] } as unknown as PolicyRule;
    expect(evaluate(rule, item, ctx)).toBe(true);
    expect(evaluate({ _and: [{ status: { _eq: 'draft' } }, { views: { _gt: 1 } }] } as unknown as PolicyRule, item, ctx)).toBe(false);
    expect(evaluate({ _or: [{ status: { _eq: 'draft' } }, { views: { _gt: 1 } }] } as unknown as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate({ _not: { status: { _eq: 'draft' } } } as unknown as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate(null, item, ctx)).toBe(true);
    expect(evaluate({} as PolicyRule, item, ctx)).toBe(true);
  });

  it('reads a structural field from the row and a content field from data first', () => {
    expect(evaluate({ id: { _eq: 'item_1' } } as unknown as PolicyRule, { ...item, data: { id: 'shadowed' } }, ctx)).toBe(true);
    expect(evaluate({ title: { _eq: 'From data' } } as unknown as PolicyRule, { ...item, data: { title: 'From data' } }, ctx)).toBe(true);
    expect(evaluate({ title: { _eq: 'Fallback' } } as unknown as PolicyRule, { title: 'Fallback' }, ctx)).toBe(true);
    expect(evaluate({ missing: { _eq: undefined } } as unknown as PolicyRule, {}, ctx)).toBe(true);
  });
});

describe('magic variables', () => {
  it('resolves the request context', () => {
    expect(resolveMagic('$CURRENT_USER', ctx)).toBe('usr_1');
    expect(resolveMagic('$CURRENT_SITE', ctx)).toBe('site_a');
    expect(resolveMagic('$CURRENT_ROLE', ctx)).toBe('role_editor');
    expect(resolveMagic('$IP', ctx)).toBe('203.0.113.5');
    expect(resolveMagic('$HEADERS.X-Source', ctx)).toBe('studio');
    expect(resolveMagic('$HEADERS.x-missing', ctx)).toBeNull();
    expect(resolveMagic('$CURRENT_API_KEY.id', ctx)).toBe('key_1');
    expect(resolveMagic(42, ctx)).toBe(42);
    expect(resolveMagic('plain', ctx)).toBe('plain');
  });

  it('answers null/empty when the context has no principal', () => {
    const empty: MagicContext = { userId: null, siteId: 'site_b', roleId: null, ip: null, headers: {} };
    expect(resolveMagic('$CURRENT_USER', empty)).toBeNull();
    expect(resolveMagic('$CURRENT_USER.email', empty)).toBe(UNKNOWN_MAGIC);
    expect(resolveMagic('$CURRENT_API_KEY', empty)).toBeNull();
    expect(resolveMagic('$CURRENT_API_KEY.id', empty)).toBe(UNKNOWN_MAGIC);
    expect(resolveMagic('$CURRENT_ROLES', empty)).toEqual([]);
    expect(resolveMagic('$CURRENT_POLICIES', empty)).toEqual([]);
    expect(resolveMagic('$CURRENT_ROLE', empty)).toBeNull();
    expect(resolveMagic('$IP', empty)).toBeNull();
  });

  it('$NOW defaults to the current time and shifts by every unit', () => {
    const now = new Date('2026-06-04T10:00:00.000Z');
    expect(resolveMagic('$NOW', { ...ctx, now })).toBe('2026-06-04T10:00:00.000Z');
    expect(resolveMagic('$NOW', { ...ctx, now: undefined })).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const shifted: Array<[string, string]> = [
      ['$NOW(+1 ms)', '2026-06-04T10:00:00.001Z'],
      ['$NOW(-2 milliseconds)', '2026-06-04T09:59:59.998Z'],
      ['$NOW(+30 s)', '2026-06-04T10:00:30.000Z'],
      ['$NOW(+2 minutes)', '2026-06-04T10:02:00.000Z'],
      ['$NOW(-1 hour)', '2026-06-04T09:00:00.000Z'],
      ['$NOW(+1 day)', '2026-06-05T10:00:00.000Z'],
      ['$NOW(+2 weeks)', '2026-06-18T10:00:00.000Z'],
      ['$NOW(+1 week)', '2026-06-11T10:00:00.000Z'],
    ];
    for (const [expression, expected] of shifted) {
      expect(resolveMagic(expression, { ...ctx, now }), expression).toBe(expected);
    }
  });

  it('an unparseable shift or an empty path is the unknown sentinel — never a silently unchanged rule', () => {
    for (const expression of ['$NOW(nonsense)', '$NOW(+1 fortnight)', '$NOW(1)', '$NOW()']) {
      expect(resolveMagic(expression, ctx), expression).toBe(UNKNOWN_MAGIC);
    }
    expect(resolveMagic('$CURRENT_USER.', ctx)).toBe(UNKNOWN_MAGIC);
    expect(resolveMagic('$CURRENT_USER.email.', ctx)).toBe(UNKNOWN_MAGIC);
    expect(resolveMagic('$CURRENT_USER.missing', ctx)).toBe(UNKNOWN_MAGIC);
    expect(resolveMagic('$CURRENT_USER.email.toLowerCase', ctx)).toBe(UNKNOWN_MAGIC);
  });
});

describe('field masks', () => {
  const all = ['title', 'body', 'secret'];

  it('an empty whitelist grants nothing', () => {
    expect(applyFieldMask(all, [])).toEqual([]);
  });

  it('`*` takes every field and exclusions remove from the result', () => {
    expect(applyFieldMask(all, ['*'])).toEqual(all);
    expect(applyFieldMask(all, ['*', '-secret'])).toEqual(['title', 'body']);
    expect(applyFieldMask(all, ['*', '-secret', '-nope'])).toEqual(['title', 'body']);
  });

  it('an explicit list is intersected with nothing and exclusions still apply', () => {
    expect(applyFieldMask(all, ['title', 'body'])).toEqual(['title', 'body']);
    expect(applyFieldMask(all, ['title', 'body', '-body'])).toEqual(['title']);
    expect(applyFieldMask(all, ['-secret'])).toEqual([]);
  });

  it('maskItemData keeps only allowed keys and leaves an item without data alone', () => {
    const item = { data: { title: 'a', body: 'b', other: 'c' } };
    expect(maskItemData(item, ['title']).data).toEqual({ title: 'a' });
    expect(maskItemData({ id: 'x' } as unknown as { id: string; data?: Record<string, unknown> }, ['title'])).toEqual({ id: 'x' });
    const noData: { id: string; data?: Record<string, unknown> } = { id: 'x' };
    expect(maskItemData(noData, ['title'])).toBe(noData);
    expect(maskItemData({ data: { title: 'a' } }, []).data).toEqual({});
  });
});

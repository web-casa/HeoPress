import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPublishAllowed, isPublishWrite } from '../publish-guard';

/**
 * The publish guard contract (HeoPress P04 task 2.1). Every publish path —
 * including ones later phases add (P09 auto-publish) — must refuse to publish
 * a held item; this is the contract they are held to, and the source scan
 * below fails when code writes `status: 'published'` to items outside the
 * paths known to go through the guard.
 */

describe('publish guard contract', () => {
  const held = { status: 'draft', hold: true };
  const free = { status: 'draft', hold: false };

  it('refuses to publish a held draft', () => {
    expect(() => assertPublishAllowed(held, { nextStatus: 'published', changesContent: false })).toThrow(
      expect.objectContaining({ code: 'ITEM_HELD', status: 409 }),
    );
  });

  it('refuses to change the live content of a held published item', () => {
    expect(() =>
      assertPublishAllowed({ status: 'published', hold: true }, { nextStatus: 'published', changesContent: true }),
    ).toThrow(expect.objectContaining({ code: 'ITEM_HELD' }));
  });

  it('lets a held item be edited as a draft, unpublished or archived', () => {
    expect(() => assertPublishAllowed(held, { nextStatus: 'draft', changesContent: true })).not.toThrow();
    expect(() =>
      assertPublishAllowed({ status: 'published', hold: true }, { nextStatus: 'draft', changesContent: false }),
    ).not.toThrow();
    expect(() => assertPublishAllowed(held, { nextStatus: 'archived', changesContent: false })).not.toThrow();
  });

  it('does not stand in the way without a hold', () => {
    expect(() => assertPublishAllowed(free, { nextStatus: 'published', changesContent: true })).not.toThrow();
  });

  it('classifies writes', () => {
    expect(isPublishWrite(free, { nextStatus: 'published', changesContent: false })).toBe(true);
    expect(isPublishWrite({ status: 'published', hold: false }, { nextStatus: 'published', changesContent: false })).toBe(false);
    expect(isPublishWrite({ status: 'published', hold: false }, { nextStatus: 'published', changesContent: true })).toBe(true);
    expect(isPublishWrite(free, { nextStatus: 'draft', changesContent: true })).toBe(false);
  });
});

/**
 * Files allowed to write `status: 'published'` to items directly, each with
 * how it honours the guard. Everything else publishes through
 * ItemService.patch, which calls assertPublishAllowed.
 */
const DIRECT_PUBLISH_WRITERS: Record<string, string> = {
  'services/scheduler-worker.ts': 'conditional UPDATE carries `hold = false`; held items are recorded as skipped',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'test-utils') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('no publish path bypasses the guard', () => {
  it('only known files write status published to items directly', () => {
    const root = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, 'utf8');
      // An UPDATE of the items table whose SET sets status to published.
      if (/\.update\(\s*items\s*\)[\s\S]{0,400}?status:\s*['"]published['"]/.test(text)) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        if (!DIRECT_PUBLISH_WRITERS[rel]) offenders.push(rel);
      }
    }
    expect(offenders, 'route these writes through ItemService.patch or assertPublishAllowed').toEqual([]);
  });

  it('the allowlisted scheduler keeps its hold condition', () => {
    const text = readFileSync(path.resolve(__dirname, '../scheduler-worker.ts'), 'utf8');
    expect(text).toMatch(/status:\s*'published'[\s\S]{0,800}eq\(items\.hold,\s*false\)/);
  });
});

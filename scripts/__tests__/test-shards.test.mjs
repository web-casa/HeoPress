import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TIMINGS_FILE, parseShard, planShards, timingsFromLog } from '../test-shards.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('--shard is <index>/<count> with 1 ≤ index ≤ count and at least two shards', () => {
  assert.deepEqual(parseShard('2/4'), { index: 2, count: 4 });
  assert.deepEqual(parseShard('4/4'), { index: 4, count: 4 });
  for (const bad of ['0/4', '5/4', '1/1', '1', 'a/b', '', undefined, '1/4/2', '-1/4']) assert.throws(() => parseShard(bad), /shard/, String(bad));
});

test('every file is in exactly one shard, whatever the order of the list', () => {
  const files = Array.from({ length: 50 }, (_, i) => `src/f${i}.test.ts`);
  const timings = { files: Object.fromEntries(files.map((f, i) => [f, (i * 7) % 13])), defaultSeconds: 1 };
  for (const count of [2, 3, 4, 7]) {
    const { shards } = planShards(files, timings, count);
    assert.equal(shards.length, count);
    const all = shards.flat();
    assert.equal(all.length, files.length);
    assert.deepEqual([...all].sort(), [...files].sort());
    const reversed = planShards([...files].reverse(), timings, count).shards;
    assert.deepEqual(reversed.map((s) => [...s].sort()), shards.map((s) => [...s].sort()), 'the same plan from any order');
  }
  assert.deepEqual(planShards(['a', 'a', 'b'], {}, 2).shards.flat().sort(), ['a', 'b']);
});

test('shards are balanced by duration, files not in the timings count defaultSeconds, preload counts', () => {
  const timings = { files: { 'a.test.ts': 100, 'b.test.ts': 60, 'c.test.ts': 50, 'd.test.ts': 40, 'e.test.ts': 10 }, defaultSeconds: 5 };
  const files = [...Object.keys(timings.files), 'new.test.ts'];
  const { shards, seconds } = planShards(files, timings, 2);
  // Longest first, each to the least loaded shard: a 100 | b 60, c → 110, d → 140, e → 120, new (5) → 125.
  assert.deepEqual(shards, [['a.test.ts', 'd.test.ts'], ['b.test.ts', 'c.test.ts', 'e.test.ts', 'new.test.ts']]);
  assert.deepEqual(seconds, [140, 125]);
  const withPreload = planShards(files, { ...timings, preload: { 1: 100 } }, 2);
  assert.ok(withPreload.seconds[0] - 100 < withPreload.seconds[1], 'shard 1 gets less of the suite');
  assert.ok(Math.max(...withPreload.seconds) - Math.min(...withPreload.seconds) <= 100);
});

test('per-file wall clock from a GitHub Actions log, only from the db:cms step of each job', () => {
  const line = (job, t, text) => `${job}\tUNKNOWN STEP\t2026-10-29T17:${t}Z ${text}`;
  const log = [
    line('shard 1', '14:00.0', '##[group][quality] db:runtime — Runtime adapter suites'),
    line('shard 1', '14:01.0', ' RUN  v5.0.3 /w/packages/runtime'),
    line('shard 1', '14:05.0', ' ✓ src/__tests__/outbound.test.ts (3 tests) 5ms'),
    line('shard 1', '14:06.0', '##[endgroup]'),
    line('shard 1', '15:00.0', '##[group][quality] db:cms — CMS suites, shard 1/2'),
    line('shard 1', '15:01.0', '\x1b[1m RUN \x1b[22m v5.0.3 /w/apps/cms'),
    line('shard 1', '15:11.5', ' \x1b[32m✓\x1b[39m src/__tests__/a.db.integration.test.ts (4 tests) 9000ms'),
    line('shard 2', '15:00.0', '##[group][quality] db:cms — CMS suites, shard 2/2'),
    line('shard 2', '15:02.0', ' RUN  v5.0.3 /w/apps/cms'),
    line('shard 2', '15:05.0', ' × src/x/__tests__/b.test.ts (1 test | 1 failed) 3ms'),
    line('shard 1', '15:13.0', ' ✓ src/c.test.ts (1 test) 1ms'),
    line('shard 1', '15:14.0', '##[endgroup]'),
    line('shard 1', '15:30.0', ' ✓ src/late.test.ts (1 test) 1ms'),
  ].join('\n');
  assert.deepEqual(timingsFromLog(log), { 'src/__tests__/a.db.integration.test.ts': 10.5, 'src/x/__tests__/b.test.ts': 3, 'src/c.test.ts': 1.5 });
});

test('the committed timings name CMS test files, and the plan of the real suite is balanced', () => {
  const timings = JSON.parse(fs.readFileSync(TIMINGS_FILE, 'utf8'));
  const cms = path.join(repoRoot, 'apps', 'cms');
  const listed = Object.keys(timings.files);
  assert.ok(listed.length > 100);
  for (const f of listed) assert.match(f, /^src\/.+\.(test|spec)\.ts$/);
  const present = listed.filter((f) => fs.existsSync(path.join(cms, f)));
  assert.ok(present.length / listed.length > 0.8, 'most timed files still exist (refresh test-shard-timings.json)');
  const { seconds } = planShards(present, timings, 4);
  assert.ok(Math.max(...seconds) - Math.min(...seconds) < 60, `estimated shards within a minute of each other: ${seconds.map(Math.round)}`);
});

// Tripwire for the repo-wide parity gate and its committed baseline.
//
// The gate's two failure modes are both silent in the wrong direction:
//
// - it can be too permissive (a new single-sided doc or a new problem code
//   slips through, and the baseline becomes a rubber stamp), or
// - it can be too stale (debt is paid down but the baseline keeps claiming it,
//   so the file stops describing the tree and nobody notices).
//
// So the tests drive the real CLI against a throwaway docs tree (DOCS_ROOT),
// not a mock: the enumeration, the `checkPair` reuse, the baseline default path,
// the exit codes and the messages are all the production ones. The pure
// `diffBaseline` cases cover the decisions a fixture cannot easily express
// (removed entries, partial drift), and the last test pins the serialization
// contract `--update` has to be idempotent against.
//
// Uses `node --test` to match the other guards in this directory: a check on
// docs tooling must not depend on a workspace install.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  diffBaseline,
  parseBaseline,
  serializeBaseline,
} from '../docs-i18n/parity-gate.mjs';

const GATE = fileURLToPath(new URL('../docs-i18n/parity-gate.mjs', import.meta.url));
const BASELINE = 'i18n-parity-baseline.json';

/**
 * A stamped pair. `zh-CN` is the source language (the repo default), so the
 * English side must carry `translatedFrom`/`sourceHash` or `checkPair` reports
 * a `front-matter` problem instead of the thing a test is about.
 */
const zhDoc = (name, { slug = name, inline = 'foo', heading = `# ${name}` } = {}) =>
  `---\nsourceLang: zh-CN\ncontentHash: hash-${slug}\n---\n\n${heading}\n\n` +
  `这是一段中文说明，用来让语言检测判定为中文，并使用 \`${inline}\`。\n`;

const enDoc = (name, { slug = name, inline = 'foo', heading = `# ${name}` } = {}) =>
  `---\nsourceLang: zh-CN\ntranslatedFrom: zh-CN\nsourceHash: hash-${slug}\n---\n\n${heading}\n\n` +
  `This is an English paragraph the detector reads as English, calling \`${inline}\`.\n`;

/** Write a docs tree; keys are `<locale>/<rel>` paths under docs/. */
function fixture(files, baseline = { version: 1, singleSided: { en: [], 'zh-CN': [] }, drifting: {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-gate-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, 'docs', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
  }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', BASELINE), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return root;
}

function gate(root, args = []) {
  const result = spawnSync(process.execPath, [GATE, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DOCS_ROOT: path.join(root, 'docs') },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const readBaseline = (root) =>
  JSON.parse(fs.readFileSync(path.join(root, 'docs', BASELINE), 'utf8'));

test('a single-sided doc that is not in the baseline fails', () => {
  const root = fixture({ 'zh-CN/agents/new.md': zhDoc('new') });
  try {
    const { status, stderr } = gate(root);
    assert.equal(status, 1, 'a new one-locale doc must fail the gate');
    assert.match(stderr, /New single-sided doc/);
    assert.match(stderr, /docs\/zh-CN\/agents\/new\.md/);
    assert.match(stderr, /docs\/en\/agents\/new\.md/, 'the message names the missing counterpart');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a single-sided doc recorded in the baseline passes', () => {
  const root = fixture(
    { 'zh-CN/agents/known.md': zhDoc('known') },
    { version: 1, singleSided: { en: [], 'zh-CN': ['agents/known.md'] }, drifting: {} },
  );
  try {
    const { status, stdout } = gate(root);
    assert.equal(status, 0);
    assert.match(stdout, /1 single-sided doc\(s\) frozen/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a baselined single-sided doc that gained a counterpart makes the baseline stale', () => {
  const root = fixture(
    {
      'zh-CN/publishing/pair.md': zhDoc('pair'),
      'en/publishing/pair.md': enDoc('pair'),
    },
    { version: 1, singleSided: { en: [], 'zh-CN': ['publishing/pair.md'] }, drifting: {} },
  );
  try {
    const { status, stderr } = gate(root);
    assert.equal(status, 1, 'a fixed entry must be recorded, not silently accepted');
    assert.match(stderr, /Stale single-sided/);
    assert.match(stderr, /no longer single-sided/);
    assert.match(stderr, /docs:i18n:gate:update/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('drift the baseline allows passes', () => {
  const root = fixture(
    {
      'zh-CN/guides/drift.md': zhDoc('drift', { inline: 'foo' }),
      'en/guides/drift.md': enDoc('drift', { inline: 'bar' }),
    },
    { version: 1, singleSided: { en: [], 'zh-CN': [] }, drifting: { 'guides/drift.md': ['inline-code'] } },
  );
  try {
    const { status, stdout } = gate(root);
    assert.equal(status, 0, stdout + '\n');
    assert.match(stdout, /1 drifting pair\(s\) within/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a problem code the baseline does not allow fails, and names the code', () => {
  const root = fixture(
    {
      // Two problems: an inline-code mismatch (allowed) and a heading-count
      // mismatch (not allowed). The gate must report only the second as new.
      'zh-CN/guides/drift.md': zhDoc('drift', { inline: 'foo' }),
      'en/guides/drift.md': `${enDoc('drift', { inline: 'bar' })}\n## An extra heading\n`,
    },
    { version: 1, singleSided: { en: [], 'zh-CN': [] }, drifting: { 'guides/drift.md': ['inline-code'] } },
  );
  try {
    const { status, stderr } = gate(root);
    assert.equal(status, 1);
    assert.match(stderr, /Drift not allowed/);
    assert.match(stderr, /new: \[headings\]/);
    assert.match(stderr, /allowed: \[inline-code\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a drifting pair with no baseline entry at all fails', () => {
  const root = fixture({
    'zh-CN/guides/new-drift.md': zhDoc('new-drift', { inline: 'foo' }),
    'en/guides/new-drift.md': enDoc('new-drift', { inline: 'bar' }),
  });
  try {
    const { status, stderr } = gate(root);
    assert.equal(status, 1);
    assert.match(stderr, /no baseline entry at all/);
    assert.match(stderr, /guides\/new-drift\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--update freezes the current tree, is idempotent, and the check then passes', () => {
  const root = fixture({
    'zh-CN/agents/known.md': zhDoc('known'),
    'zh-CN/guides/drift.md': zhDoc('drift', { inline: 'foo' }),
    'en/guides/drift.md': enDoc('drift', { inline: 'bar' }),
    'zh-CN/publishing/pair.md': zhDoc('pair'),
    'en/publishing/pair.md': enDoc('pair'),
  });
  try {
    const first = gate(root, ['--update']);
    assert.equal(first.status, 0, first.stderr);
    const baselinePath = path.join(root, 'docs', BASELINE);
    const firstBytes = fs.readFileSync(baselinePath);

    const second = gate(root, ['--update']);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(
      fs.readFileSync(baselinePath),
      firstBytes,
      '--update must be byte-identical on the same tree',
    );

    const baseline = readBaseline(root);
    assert.deepEqual(baseline.singleSided['zh-CN'], ['agents/known.md']);
    assert.deepEqual(baseline.singleSided.en, []);
    assert.deepEqual(baseline.drifting, { 'guides/drift.md': ['inline-code'] });
    assert.ok(firstBytes.toString('utf8').endsWith('\n'), 'the file ends with a newline');
    assert.equal(baseline.version, 1);

    const checked = gate(root);
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing or invalid baseline is a usage error, not a parity verdict', () => {
  const root = fixture({ 'zh-CN/agents/known.md': zhDoc('known') });
  try {
    fs.rmSync(path.join(root, 'docs', BASELINE));
    const missing = gate(root);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /docs:i18n:gate:update/);

    fs.writeFileSync(path.join(root, 'docs', BASELINE), '{"singleSided": {"en": []}}\n', 'utf8');
    const invalid = gate(root);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /singleSided\.zh-CN|missing `drifting`/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('diffBaseline marks debt that disappeared as stale, including partial drift', () => {
  const state = {
    pairs: ['guides/a.md', 'guides/b.md'],
    singleSided: { en: [], 'zh-CN': [] },
    drifting: { 'guides/a.md': ['inline-code'] },
  };
  const baseline = {
    singleSided: { en: ['features/x.md'], 'zh-CN': [] },
    drifting: { 'guides/a.md': ['inline-code', 'bulk'], 'guides/b.md': ['tables'] },
  };
  const diff = diffBaseline(state, baseline);
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.staleSingleSided, [
    { locale: 'en', rel: 'features/x.md', reason: 'removed' },
  ]);
  assert.deepEqual(diff.staleDrift, [
    { rel: 'guides/a.md', gone: ['bulk'] },
    { rel: 'guides/b.md', gone: ['tables'] },
  ]);
  assert.deepEqual(diff.unallowedDrift, []);
});

test('parseBaseline rejects a locale this repo does not have', () => {
  assert.throws(
    () =>
      parseBaseline(
        JSON.stringify({ singleSided: { en: [], 'zh-CN': [], vi: [] }, drifting: {} }),
      ),
    /unknown locale `singleSided\.vi`/,
  );
});

test('serializeBaseline sorts keys, dedupes nothing it should not, and keeps a trailing newline', () => {
  const text = serializeBaseline({
    pairs: ['b.md', 'a.md'],
    singleSided: { 'zh-CN': ['z.md', 'a.md'], en: ['m.md'] },
    drifting: { 'z.md': ['links', 'bulk'] },
  });
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.singleSided['zh-CN'], ['a.md', 'z.md']);
  assert.deepEqual(parsed.singleSided.en, ['m.md']);
  assert.deepEqual(Object.keys(parsed.drifting), ['z.md']);
  assert.deepEqual(parsed.drifting['z.md'], ['bulk', 'links']);
  assert.ok(text.endsWith('\n'));
  assert.equal(text, serializeBaseline(JSON.parse(JSON.stringify(parsed))), 'round-trips unchanged');
});

// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A small two-locale docs tree, so these cases do not depend on which pages the
// repository happens to have translated (P02 dropped the upstream vi tree).
// DOCS_ROOT is read when the tooling is imported, hence the dynamic import.
const docsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-parity-links-'));
for (const file of ['en/llms.txt', 'en/deployment/docker.md', 'en/getting-started.md', 'zh-CN/deployment/docker.md', 'zh-CN/getting-started.md']) {
  fs.mkdirSync(path.dirname(path.join(docsRoot, file)), { recursive: true });
  fs.writeFileSync(path.join(docsRoot, file), '# fixture\n');
}
process.env.DOCS_ROOT = docsRoot;
const { linkTargets } = await import('../docs-i18n/check-parity.mjs');
process.on('exit', () => fs.rmSync(docsRoot, { recursive: true, force: true }));

test('compares translated Markdown cross-links by file path', () => {
  const en = linkTargets(
    '[same page](#gaps) [other doc](../api/graphql-api-spec.md#abuse-guards)',
  );
  const vi = linkTargets(
    '[cùng trang](#khoảng-trống) [tài liệu khác](../api/graphql-api-spec.md#chống-lạm-dụng)',
  );

  assert.deepEqual(en, { files: ['../api/graphql-api-spec.md'], anchors: 1 });
  assert.deepEqual(vi, en);
});

test('keeps fragments on external URLs', () => {
  assert.deepEqual(linkTargets('[section](https://example.com/guide.md#one)'), {
    files: ['https://example.com/guide.md#one'],
    anchors: 0,
  });
});

// ─── Resolution across locales ───────────────────────────────────────────────
// Without `from`, two locales had to write the *same literal path* for the same
// target. That is wrong in both directions, and the second one is the dangerous
// one: `docs/zh-CN/README.md` linking `./llms.txt` matched `docs/en/README.md`
// linking `./llms.txt` perfectly, while the ZH side pointed at a
// `docs/zh-CN/llms.txt` that does not exist. Three such dead links were sitting on
// main — B67, plus the same shape in `agent-setup/index.md` and `mcp/index.md`.
// Meanwhile a legitimate pair (`../devpost…md` vs `../../en/devpost…md`) was
// reported as drift, the false positive recorded as B37(d).

test('a target that exists in both locales is compared locale-independently', () => {
  const en = linkTargets('[docker](./deployment/docker.md)', { rel: 'README.md', locale: 'en' });
  const vi = linkTargets('[docker](./deployment/docker.md)', { rel: 'README.md', locale: 'zh-CN' });
  assert.deepEqual(en.files, ['docs/*/deployment/docker.md']);
  assert.deepEqual(vi.files, en.files);
});

test('a target that exists in only one locale must agree on that one real file', () => {
  // docs/en/llms.txt exists; docs/zh-CN/llms.txt does not.
  const en = linkTargets('[index](./llms.txt)', { rel: 'README.md', locale: 'en' });
  const viFixed = linkTargets('[index](../en/llms.txt)', { rel: 'README.md', locale: 'zh-CN' });
  const viBroken = linkTargets('[index](./llms.txt)', { rel: 'README.md', locale: 'zh-CN' });

  assert.deepEqual(en.files, ['docs/en/llms.txt']);
  assert.deepEqual(viFixed.files, en.files, 'the corrected ZH link resolves to the same file');
  assert.deepEqual(
    viBroken.files,
    ['docs/zh-CN/llms.txt'],
    'the dead ZH link no longer hides behind an identical literal path',
  );
});

test('resolution walks up out of a subdirectory', () => {
  const vi = linkTargets('[index](../../en/llms.txt)', {
    rel: 'agent-setup/index.md',
    locale: 'zh-CN',
  });
  assert.deepEqual(vi.files, ['docs/en/llms.txt']);
});

test('a fragment survives resolution', () => {
  const vi = linkTargets('[tree](../getting-started.md#bạn-thật-sự-cần-cái-nào)', {
    rel: 'cli/index.md',
    locale: 'zh-CN',
  });
  // The fragment is stripped for .md links (translated headings differ), so the
  // comparison is on the resolved file alone.
  assert.deepEqual(vi.files, ['docs/*/getting-started.md']);
});

test('root-relative and external targets are left untouched', () => {
  const from = { rel: 'README.md', locale: 'en' };
  assert.deepEqual(linkTargets('[api](/api/v1/items)', from).files, ['/api/v1/items']);
  assert.deepEqual(linkTargets('[site](https://heopress.example)', from).files, [
    'https://heopress.example',
  ]);
});

test('a path escaping the docs tree compares literally, not as a locale path', () => {
  const en = linkTargets('[rules](../../CLAUDE.md)', { rel: 'README.md', locale: 'en' });
  assert.deepEqual(en.files, ['CLAUDE.md']);
});

test('omitting `from` keeps the old literal behaviour', () => {
  assert.deepEqual(linkTargets('[index](./llms.txt)').files, ['./llms.txt']);
});

test('a target dead in both locales is not reported as a locale mismatch', () => {
  // Parity is not a dead-link check. Before resolution both sides compared equal
  // as identical literals; resolving them to docs/en/x and docs/zh-CN/x would turn a
  // dead link into a misleading "link mismatch". Collapse instead.
  const en = linkTargets('[gone](./no-such-page.md)', { rel: 'README.md', locale: 'en' });
  const vi = linkTargets('[gone](./no-such-page.md)', { rel: 'README.md', locale: 'zh-CN' });
  assert.deepEqual(en.files, ['docs/*/no-such-page.md']);
  assert.deepEqual(vi.files, en.files);
});

test('an extensionless slug link resolves to its .md file in both locales', () => {
  const en = linkTargets('[docker](./deployment/docker)', { rel: 'README.md', locale: 'en' });
  const vi = linkTargets('[docker](./deployment/docker)', { rel: 'README.md', locale: 'zh-CN' });
  assert.deepEqual(en.files, ['docs/*/deployment/docker']);
  assert.deepEqual(vi.files, en.files);
});

test('the single-locale rule still holds after the dead-in-both change', () => {
  // docs/en/llms.txt exists, docs/zh-CN/llms.txt does not: present in SOME locales,
  // so the broken ZH side must still differ from the EN side (B67).
  const en = linkTargets('[index](./llms.txt)', { rel: 'README.md', locale: 'en' });
  const vi = linkTargets('[index](./llms.txt)', { rel: 'README.md', locale: 'zh-CN' });
  assert.notDeepEqual(vi.files, en.files);
});

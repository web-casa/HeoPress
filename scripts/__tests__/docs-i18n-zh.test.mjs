import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectLang } from '../docs-i18n/lang-detect.mjs';
import { contentHash, splitFrontMatter } from '../docs-i18n/frontmatter.mjs';

// HeoPress P02 task 6.1 / spec engineering/docs-integrity: docs are zh-CN
// (default, source language) and en. Every case runs on a throwaway DOCS_ROOT.

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs-i18n');

function docsTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-i18n-zh-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const run = (script, ...args) =>
    spawnSync(process.execPath, [path.join(scripts, script), ...args], {
      env: { ...process.env, DOCS_ROOT: root },
      encoding: 'utf8',
      cwd: root,
    });
  return { root, run, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** An English page stamped as the translation of `source` (what stamp-pair writes). */
const translated = (source) =>
  `---\nversion: 1\nsourceLang: zh-CN\ntranslatedFrom: zh-CN\nsourceHash: ${contentHash(splitFrontMatter(source).body)}\n---\n\n${EN}`;

const ZH = '# 变更推送\n\n本文介绍站点内容变更事件如何推送给外部系统，以及接收方如何校验 `X-HeoPress-Signature` 签名。\n';
const EN = '# Change feed\n\nThis page explains how site content changes reach external systems and how receivers verify the `X-HeoPress-Signature` header.\n';

test('the detector tells Chinese from English, including Chinese prose with English identifiers', () => {
  assert.equal(detectLang(ZH).lang, 'zh-CN');
  assert.equal(detectLang(EN).lang, 'en');
  assert.equal(detectLang('This guide covers the 站群 setup in detail for operators and developers alike.').lang, 'en');
  assert.equal(detectLang('```ts\nconst a = 1;\n```\n').lang, 'unknown');
});

test('check-parity lists docs that have no Chinese version yet, without failing', () => {
  const t = docsTree({ 'en/features/only-en.md': EN, 'zh-CN/features/pair.md': ZH, 'en/features/pair.md': translated(ZH) });
  try {
    const res = t.run('check-parity.mjs');
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /missing docs\/zh-CN\/ \(1\):\n\s+features\/only-en\.md/);
    const json = JSON.parse(t.run('check-parity.mjs', '--json').stdout);
    assert.deepEqual(json.missing, { 'zh-CN': ['features/only-en.md'], en: [] });
  } finally {
    t.done();
  }
});

test('an English translation is reported stale once its Chinese source changes', () => {
  const t = docsTree({ 'zh-CN/features/feed.md': ZH, 'en/features/feed.md': translated(ZH) });
  const action = () => {
    const res = t.run('sync.mjs');
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(t.root, '.i18n', 'last-report.json'), 'utf8'));
    return report.actions.find((a) => a.rel === 'features/feed.md');
  };
  try {
    assert.equal(action().type, 'up-to-date');
    fs.appendFileSync(path.join(t.root, 'zh-CN/features/feed.md'), '\n## 重试\n\n失败的投递会按指数退避重试。\n');
    assert.deepEqual(
      (({ type, reason, sourceLocale, targetLocale }) => ({ type, reason, sourceLocale, targetLocale }))(action()),
      { type: 'translate', reason: 'source changed since last sync', sourceLocale: 'zh-CN', targetLocale: 'en' },
    );
  } finally {
    t.done();
  }
});

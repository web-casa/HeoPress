import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStudioI18n } from '../check-studio-i18n.mjs';

function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'studio-i18n-'));
  for (const [rel, value] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

test('identical keys in both languages pass', () => {
  const root = tree({ 'zh-CN/shell.json': { a: '甲', b: { c: '丙' } }, 'en/shell.json': { a: 'A', b: { c: 'C' } } });
  assert.deepEqual(checkStudioI18n(root), []);
  rmSync(root, { recursive: true });
});

test('a key missing in one language fails, naming it', () => {
  const root = tree({ 'zh-CN/shell.json': { a: '甲', b: { c: '丙' } }, 'en/shell.json': { a: 'A' } });
  assert.deepEqual(checkStudioI18n(root), ['en/shell.json: missing key "b.c"']);
  rmSync(root, { recursive: true });
});

test('an extra key fails too', () => {
  const root = tree({ 'zh-CN/shell.json': { a: '甲' }, 'en/shell.json': { a: 'A', extra: 'X' } });
  assert.deepEqual(checkStudioI18n(root), ['zh-CN/shell.json: missing key "extra"']);
  rmSync(root, { recursive: true });
});

test('a namespace in one language only fails', () => {
  const root = tree({ 'zh-CN/shell.json': { a: '甲' }, 'en/shell.json': { a: 'A' }, 'en/audit.json': { x: 'X' } });
  assert.deepEqual(checkStudioI18n(root), ['zh-CN/audit.json: missing (the other language has it)']);
  rmSync(root, { recursive: true });
});

test('the real Studio tree is consistent', () => {
  assert.deepEqual(checkStudioI18n(path.resolve(import.meta.dirname, '../../apps/studio/src/i18n')), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import studioRules from '../eslint/studio-no-ui-literals.mjs';

const linter = new Linter({ configType: 'flat' });
const config = [{
  files: ['**/*.tsx'],
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
  plugins: { 'heopress-studio': studioRules },
  rules: { 'heopress-studio/no-ui-literals': 'error' },
}];
const lint = (code) => linter.verify(code, config, 'x.tsx').map((m) => m.message);

test('JSX text with words is flagged, in English and Chinese', () => {
  assert.equal(lint('const a = <p>Save changes</p>;').length, 1);
  assert.equal(lint('const a = <p>保存</p>;').length, 1);
});

test('text attributes with literals are flagged', () => {
  assert.equal(lint('const a = <input placeholder="Search" />;').length, 1);
  assert.equal(lint('const a = <button aria-label={"Close"} />;').length, 1);
  assert.equal(lint('const a = <img alt={`Logo ${x}`} />;').length, 1);
});

test('translated text, punctuation, numbers and non-text attributes pass', () => {
  assert.deepEqual(lint('const a = <p title={t("x")}>{t("save")} · 12 / {n}</p>;'), []);
  assert.deepEqual(lint('const a = <div className="flex gap-2" data-testid="rail" />;'), []);
});

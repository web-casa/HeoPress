#!/usr/bin/env node
// Studio interface strings (HeoPress P07a task 1.3, ADR-0019 §6): every
// namespace exists in both languages with exactly the same keys.
//
//   node scripts/check-studio-i18n.mjs            # check apps/studio/src/i18n
//   node scripts/check-studio-i18n.mjs <dir>      # check another tree (tests)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LANGUAGES = ['zh-CN', 'en'];

function flatten(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.push(prefix);
  }
  return out;
}

/** Problems found under `root` (`<root>/<lang>/<namespace>.json`), as human-readable lines. */
export function checkStudioI18n(root) {
  const problems = [];
  const namespaces = new Set();
  for (const lang of LANGUAGES) {
    const dir = path.join(root, lang);
    if (!existsSync(dir)) {
      problems.push(`${lang}: directory missing`);
      continue;
    }
    for (const file of readdirSync(dir)) if (file.endsWith('.json')) namespaces.add(file.slice(0, -5));
  }
  for (const ns of [...namespaces].sort()) {
    const keys = {};
    for (const lang of LANGUAGES) {
      const file = path.join(root, lang, `${ns}.json`);
      if (!existsSync(file)) {
        problems.push(`${lang}/${ns}.json: missing (the other language has it)`);
        continue;
      }
      try {
        keys[lang] = new Set(flatten(JSON.parse(readFileSync(file, 'utf8'))));
      } catch (error) {
        problems.push(`${lang}/${ns}.json: not valid JSON (${error.message})`);
      }
    }
    if (!keys['zh-CN'] || !keys.en) continue;
    for (const [lang, other] of [['zh-CN', 'en'], ['en', 'zh-CN']]) {
      for (const key of keys[lang]) if (!keys[other].has(key)) problems.push(`${other}/${ns}.json: missing key "${key}"`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/studio/src/i18n');
  const problems = checkStudioI18n(root);
  if (problems.length) {
    console.error(`[studio-i18n] ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ✖ ${p}`);
    process.exit(1);
  }
  console.log('[studio-i18n] ok');
}

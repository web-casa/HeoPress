import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXTENSION_POINTS } from '@heopress/contracts/extensions';
import { EXTENSION_MATRIX, MATRIX_CELLS, MATRIX_FILE, MATRIX_MARKER, renderMatrixTable } from './helpers/extension-matrix';

/**
 * The extension-point matrix stays true (HeoPress P12 task 9.1): every cell of every extension point names at least one
 * test, every named test exists in its file under that exact name, every `9.1 …` test of the matrix suite is in the
 * matrix, and a handoff that carries the matrix carries this table.
 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const sources = new Map<string, string>();
const source = (file: string) => {
  if (!sources.has(file)) sources.set(file, readFileSync(join(ROOT, file), 'utf8'));
  return sources.get(file)!;
};
/** Whether `name` is a test name in `text`, as a single- or double-quoted or template literal. */
const names = (text: string, name: string) =>
  [`'${name.replaceAll("'", "\\'")}'`, `"${name.replaceAll('"', '\\"')}"`, `\`${name}\``].some((lit) => text.includes(lit));

describe('extension-point matrix (P12 task 9.1)', () => {
  it('every extension point has a test in each of the five cells', () => {
    expect(Object.keys(EXTENSION_MATRIX).sort()).toEqual([...EXTENSION_POINTS].sort());
    for (const point of EXTENSION_POINTS) {
      for (const cell of MATRIX_CELLS) expect(EXTENSION_MATRIX[point][cell].length, `${point} × ${cell}`).toBeGreaterThan(0);
    }
  });

  it('every test the matrix names exists in its file under that name', () => {
    const missing: string[] = [];
    for (const point of EXTENSION_POINTS) {
      for (const cell of MATRIX_CELLS) {
        for (const ref of EXTENSION_MATRIX[point][cell]) {
          if (!existsSync(join(ROOT, ref.file)) || !names(source(ref.file), ref.test)) missing.push(`${point} × ${cell}: ${ref.file} › ${ref.test}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every 9.1 test of the matrix suite is in the matrix', () => {
    const cited = new Set(Object.values(EXTENSION_MATRIX).flatMap((cells) => Object.values(cells).flat().filter((r) => r.file === MATRIX_FILE).map((r) => r.test)));
    const declared = [...source(MATRIX_FILE).matchAll(/it\(\s*(['"])(9\.1 .+?)\1\s*,/g)].map((x) => x[2]!.replaceAll("\\'", "'"));
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((n) => !cited.has(n))).toEqual([]);
  });

  it('a handoff carrying the matrix shows this table', () => {
    const dir = join(ROOT, 'docs', 'handoffs');
    // The handoffs are private (not in the public mirror): nothing to compare there.
    const carrying = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && readFileSync(join(dir, f), 'utf8').includes(MATRIX_MARKER)) : [];
    for (const file of carrying) {
      const text = readFileSync(join(dir, file), 'utf8');
      const after = text.slice(text.indexOf(MATRIX_MARKER) + MATRIX_MARKER.length).trimStart();
      expect(after.startsWith(renderMatrixTable()), `${file}: the table after the marker is not the current matrix (renderMatrixTable)`).toBe(true);
    }
  });
});

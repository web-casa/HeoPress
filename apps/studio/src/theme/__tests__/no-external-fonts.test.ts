import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0019 §4: system font stacks only — no bundled or CDN fonts
 * (p07a task 1.4). Checks the sources always, and the build output when one
 * exists (CI builds the Studio before the browser scenarios).
 */
const studio = path.resolve(__dirname, '../../..');
const FORBIDDEN = [/fonts\.googleapis\.com/i, /fonts\.gstatic\.com/i, /use\.typekit\.net/i, /@font-face/i, /\.woff2?\b/i, /\.ttf\b/i, /\.otf\b/i];

function files(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : files(full, ext);
    return ext.test(name) ? [full] : [];
  });
}

function offenders(paths: string[]): string[] {
  return paths.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return FORBIDDEN.filter((re) => re.test(text)).map((re) => `${path.relative(studio, file)}: ${re.source}`);
  });
}

describe('no external or bundled fonts', () => {
  it('index.html and the stylesheets load no font', () => {
    expect(offenders([path.join(studio, 'index.html'), ...files(path.join(studio, 'src'), /\.css$/)])).toEqual([]);
  });

  it('the build output, when present, holds no font file or font request', () => {
    const dist = path.join(studio, 'dist');
    if (!existsSync(dist)) return;
    // The one exception: the bundled code editor's icon font (Monaco's `codicon`, MIT with monaco-editor; task 13.6),
    // loaded only with the editor chunk. It draws the editor's icons, never text.
    const codicon = (file: string) => /[\\/]codicon-[\w-]+\.ttf$/.test(file);
    expect(files(dist, /\.(woff2?|ttf|otf|eot)$/).filter((f) => !codicon(f))).toEqual([]);
    const css = files(path.join(dist, 'assets'), /\.css$/);
    expect(offenders([path.join(dist, 'index.html'), ...css.filter((f) => !readFileSync(f, 'utf8').includes('codicon'))])).toEqual([]);
    // The editor's stylesheet declares only that face, and the first screen's stylesheet none.
    for (const f of css.filter((f) => readFileSync(f, 'utf8').includes('codicon'))) {
      expect(readFileSync(f, 'utf8').match(/@font-face\s*\{[^}]*\}/g)?.every((face) => /codicon/.test(face)), path.relative(studio, f)).toBe(true);
      expect(readFileSync(path.join(dist, 'index.html'), 'utf8')).not.toContain(path.basename(f));
    }
  });

  it('body text uses the system stack with the Chinese system faces', () => {
    const css = readFileSync(path.join(studio, 'src/index.css'), 'utf8');
    expect(css).toMatch(/--font-sans:[^;]*PingFang SC[^;]*Microsoft YaHei[^;]*Noto Sans CJK SC/);
    expect(css).toMatch(/--font-mono: ui-monospace/);
  });
});

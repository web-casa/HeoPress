/**
 * Plugin API codemods (HeoPress P13 task 2.2; spec ops/upgrades "运行 codemod"): the deterministic changes of the
 * example plugin are converted and the result type-checks against the HeoPress Extension SDK; what cannot be converted
 * is reported and left exactly as it was.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatReport } from '../../commands/codemod';
import { CODEMODS, runCodemods } from '..';
import { applyEdits } from '../framework';

const FIXTURE = path.resolve(__dirname, '../__fixtures__/lumibase-plugin');
const SDK = path.resolve(__dirname, '../../../../extension-sdk/src/index.ts');

/** Copy the fixture plugin, dropping the `.fixture` suffix that keeps it out of the repository's own checks. */
function copyPlugin(to: string): void {
  cpSync(FIXTURE, to, { recursive: true });
  const strip = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) strip(full);
      else if (e.endsWith('.fixture')) renameSync(full, full.slice(0, -'.fixture'.length));
    }
  };
  strip(to);
}

/** Type errors of `file` compiled against the HeoPress Extension SDK. */
function typeErrors(file: string): string[] {
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    skipLibCheck: true,
    paths: { '@heopress/extension-sdk': [SDK] },
  });
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

let dir: string;
beforeEach(() => {
  dir = path.join(mkdtempSync(path.join(tmpdir(), 'heopress-codemod-')), 'plugin');
  copyPlugin(dir);
});
afterEach(() => {
  rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe('codemod lumibase-to-heopress', () => {
  it('converts the deterministic changes and the converted plugin type-checks against the HeoPress SDK', () => {
    const index = path.join(dir, 'src', 'index.ts');
    expect(typeErrors(index).join('\n')).toMatch(/Cannot find module '@lumibase\/extension-sdk'/);

    const report = runCodemods(dir, CODEMODS, { write: true });
    expect(report.renamed).toEqual([{ from: 'lumibase-extension.json', to: 'heopress-extension.json', codemod: 'lumibase-to-heopress' }]);
    expect(report.changed.map((c) => c.file)).toEqual(['heopress-extension.json', 'package.json', 'src/index.ts', 'src/legacy.ts']);

    const code = readFileSync(index, 'utf8');
    expect(code).not.toContain('@lumibase/');
    // Quote style, comments and formatting are kept: only the module names changed.
    expect(code).toContain(`import type { ExtensionManifest } from "@heopress/extension-sdk";`);
    expect(code).toBe(readFileSync(path.join(FIXTURE, 'src', 'index.ts.fixture'), 'utf8').replaceAll('@lumibase/extension-sdk', '@heopress/extension-sdk'));
    expect(typeErrors(index)).toEqual([]);

    expect(existsSync(path.join(dir, 'lumibase-extension.json'))).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'heopress-extension.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(manifest)).toEqual(['name', 'version', 'type', 'entry', 'capabilities', 'heopress']);
    expect(manifest.heopress).toBe('^0.26.0');
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    expect(pkg.dependencies).toEqual({ '@heopress/extension-sdk': '^1.0.0-0', '@lumibase/contracts': '0.26.0' });
    expect(pkg.devDependencies).toEqual({ '@heopress/sdk': '^1.0.0-0', typescript: '^5.6.2' });
  }, 60_000); // two TypeScript programs; slow on a loaded CI runner

  it('reports what it cannot convert and leaves that code as it was', () => {
    const report = runCodemods(dir, CODEMODS, { write: true });
    const legacy = readFileSync(path.join(dir, 'src', 'legacy.ts'), 'utf8');
    const before = readFileSync(path.join(FIXTURE, 'src', 'legacy.ts.fixture'), 'utf8');
    // Only the SDK import changed.
    expect(legacy).toBe(before.replace(`from '@lumibase/extension-sdk'`, `from '@heopress/extension-sdk'`));
    expect(legacy).toContain(`import { formatSafeError } from '@lumibase/contracts/utils';`);
    expect(legacy).toContain('process.env.LUMIBASE_ACME_KEY');
    expect(legacy).toContain('import(`@lumibase/${variant}`)');

    expect(report.manual.map((m) => `${m.file}:${m.line} ${m.message}`)).toEqual([
      'src/legacy.ts:3 imports @lumibase/contracts/utils, a LumiBase core package',
      'src/legacy.ts:5 reads the environment variable LUMIBASE_ACME_KEY',
      'src/legacy.ts:11 loads a LumiBase module whose name is built at run time',
      'heopress-extension.json:0 declares HeoPress ^0.26.0, which excludes 1.0.0: install and upgrade are refused',
      'package.json:0 dependencies has @lumibase/contracts, a LumiBase core package',
    ]);
    expect(report.manual.every((m) => m.steps.length > 0)).toBe(true);
    const text = formatReport(report);
    expect(text).toContain('5 manual step(s) — this code was left as it was:');
    expect(text).toContain('→ Plugins get no environment in HeoPress');
  });

  it('a dry run writes nothing; a second run finds nothing left to convert', () => {
    const dry = runCodemods(dir, CODEMODS);
    expect(dry.written).toBe(false);
    expect(dry.changed.length).toBeGreaterThan(0);
    expect(existsSync(path.join(dir, 'lumibase-extension.json'))).toBe(true);
    expect(readFileSync(path.join(dir, 'src', 'index.ts'), 'utf8')).toContain('@lumibase/extension-sdk');
    expect(formatReport(dry)).toContain('Dry run: add --write to apply');

    runCodemods(dir, CODEMODS, { write: true });
    const again = runCodemods(dir, CODEMODS, { write: true });
    expect(again.changed).toEqual([]);
    expect(again.renamed).toEqual([]);
  });

  it('does not overwrite an existing heopress-extension.json', () => {
    cpSync(path.join(dir, 'lumibase-extension.json'), path.join(dir, 'heopress-extension.json'));
    const report = runCodemods(dir, CODEMODS, { write: true });
    expect(report.renamed).toEqual([]);
    expect(report.manual[0]).toMatchObject({ file: 'lumibase-extension.json', message: expect.stringMatching(/already exists/) });
    expect(existsSync(path.join(dir, 'lumibase-extension.json'))).toBe(true);
  });

  it('applies non-overlapping edits by position and refuses overlapping ones', () => {
    expect(applyEdits('abcdef', [{ start: 4, end: 5, text: 'E' }, { start: 0, end: 1, text: 'A' }])).toBe('AbcdEf');
    expect(() => applyEdits('abcdef', [{ start: 0, end: 3, text: 'x' }, { start: 2, end: 4, text: 'y' }])).toThrow(/overlapping/);
  });
});

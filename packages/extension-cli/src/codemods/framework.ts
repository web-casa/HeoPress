/**
 * Codemods for plugin API breaking changes (HeoPress P13 task 2.2; spec ops/upgrades "插件 API 破坏性变更").
 *
 * A codemod makes only deterministic changes — ones with a single correct result — and reports everything else as a
 * manual step, leaving that code exactly as it was. It never deletes code. It works on a plugin's source tree:
 *
 * - `source`: each TypeScript / JavaScript file, through the TypeScript parser (no regular expressions on code), with
 *   edits applied by position so formatting and comments are kept;
 * - `manifest`: the plugin manifest (`heopress-extension.json`, after `renameFiles`);
 * - `packageJson`: the plugin's `package.json`;
 * - `renameFiles`: files whose name changed.
 *
 * `runCodemods` applies a list of codemods in order and returns one report; with `write: false` (the default of the
 * command) nothing is written and the report says what would change.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

interface ManualStep {
  codemod: string;
  /** Path relative to the plugin directory. */
  file: string;
  /** 1-based; 0 for a whole-file finding. */
  line: number;
  /** What could not be converted. */
  message: string;
  /** What the author has to do. */
  steps: string;
}

export type Finding = Omit<ManualStep, 'codemod' | 'file'>;

/** A text edit by offsets into the original text. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

interface SourceFileInput {
  /** Relative path. */
  file: string;
  text: string;
  sourceFile: ts.SourceFile;
}

export interface Codemod {
  /** Stable id, e.g. `lumibase-to-heopress`. */
  id: string;
  title: string;
  /** The API the plugin was written for, in words (shown by `--list`). */
  from: string;
  to: string;
  renameFiles?(relPath: string): string | null;
  source?(input: SourceFileInput): { edits: TextEdit[]; findings: Finding[] };
  manifest?(manifest: Record<string, unknown>): { manifest: Record<string, unknown>; findings: Finding[] };
  packageJson?(pkg: Record<string, unknown>): { pkg: Record<string, unknown>; findings: Finding[] };
}

export interface CodemodReport {
  /** Files changed (or that would change), relative paths after renames. */
  changed: Array<{ file: string; codemods: string[] }>;
  renamed: Array<{ from: string; to: string; codemod: string }>;
  manual: ManualStep[];
  written: boolean;
}

const SOURCE = /\.(c|m)?(t|j)sx?$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
const MANIFEST = 'heopress-extension.json';

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(root, full, out);
    } else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.(c|m)?tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.(c|m)?ts$/.test(file)) return ts.ScriptKind.TS;
  if (/\.(c|m)?jsx$/.test(file)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/** Apply non-overlapping edits (overlaps are an error of the codemod). */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const e of sorted) {
    if (e.start < at) throw new Error('overlapping codemod edits');
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}

export function runCodemods(dir: string, codemods: readonly Codemod[], options: { write?: boolean } = {}): CodemodReport {
  const write = options.write === true;
  const report: CodemodReport = { changed: [], renamed: [], manual: [], written: write };
  const contents = new Map<string, string>();
  const touched = new Map<string, Set<string>>();
  const mark = (file: string, codemod: string) => {
    const s = touched.get(file) ?? new Set<string>();
    s.add(codemod);
    touched.set(file, s);
  };
  for (const file of walk(dir)) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    contents.set(file, text);
  }

  for (const mod of codemods) {
    // 1. Renames.
    if (mod.renameFiles) {
      for (const file of [...contents.keys()]) {
        const to = mod.renameFiles(file);
        if (!to || to === file) continue;
        if (contents.has(to)) {
          report.manual.push({
            codemod: mod.id,
            file,
            line: 0,
            message: `${file} should be renamed to ${to}, which already exists`,
            steps: `Merge ${file} into ${to} by hand, then delete ${file}.`,
          });
          continue;
        }
        contents.set(to, contents.get(file)!);
        contents.delete(file);
        report.renamed.push({ from: file, to, codemod: mod.id });
        mark(to, mod.id);
      }
    }
    // 2. Sources.
    if (mod.source) {
      for (const [file, text] of contents) {
        if (!SOURCE.test(file) || file.endsWith('.d.ts.map')) continue;
        const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
        const { edits, findings } = mod.source({ file, text, sourceFile });
        for (const f of findings) report.manual.push({ codemod: mod.id, file, ...f });
        if (edits.length > 0) {
          const next = applyEdits(text, edits);
          if (next !== text) {
            contents.set(file, next);
            mark(file, mod.id);
          }
        }
      }
    }
    // 3. Manifest and package.json (re-serialised with two-space indentation).
    for (const [name, apply] of [
      [MANIFEST, mod.manifest ? (j: Record<string, unknown>) => { const r = mod.manifest!(j); return { json: r.manifest, findings: r.findings }; } : null],
      ['package.json', mod.packageJson ? (j: Record<string, unknown>) => { const r = mod.packageJson!(j); return { json: r.pkg, findings: r.findings }; } : null],
    ] as const) {
      if (!apply || !contents.has(name)) continue;
      let json: Record<string, unknown> | null;
      try {
        const v = JSON.parse(contents.get(name)!) as unknown;
        json = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      if (!json) {
        report.manual.push({ codemod: mod.id, file: name, line: 0, message: `${name} is not a JSON object`, steps: `Fix ${name}, then run the codemod again.` });
        continue;
      }
      const { json: next, findings } = apply(json);
      for (const f of findings) report.manual.push({ codemod: mod.id, file: name, ...f });
      const text = `${JSON.stringify(next, null, 2)}\n`;
      if (JSON.stringify(next) !== JSON.stringify(json)) {
        contents.set(name, text);
        mark(name, mod.id);
      }
    }
  }

  for (const [file, mods] of touched) report.changed.push({ file, codemods: [...mods] });
  report.changed.sort((a, b) => a.file.localeCompare(b.file));

  if (write) {
    for (const r of report.renamed) {
      const from = path.join(dir, r.from);
      if (existsSync(from)) renameSync(from, path.join(dir, r.to));
    }
    for (const { file } of report.changed) writeFileSync(path.join(dir, file), contents.get(file)!);
  }
  return report;
}

/** 1-based line of an offset. */
export function lineOf(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

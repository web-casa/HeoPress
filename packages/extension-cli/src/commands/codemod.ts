import path from 'node:path';
import { CODEMODS, runCodemods, type CodemodReport } from '../codemods';

/**
 * Migrate a plugin across plugin API breaking changes (HeoPress P13 task 2.2).
 *
 *   heopress-ext codemod --dir ./my-plugin            # dry run: what would change, what needs a person
 *   heopress-ext codemod --dir ./my-plugin --write    # apply the deterministic changes
 *   heopress-ext codemod --list                       # the codemods and the changes they cover
 *   heopress-ext codemod --dir ./my-plugin --only lumibase-to-heopress
 *
 * Exit code 0: nothing left to do by hand; 3: manual steps remain (listed; that code is left as it was).
 */
export function formatReport(report: CodemodReport): string {
  const lines: string[] = [];
  const verb = report.written ? 'changed' : 'would change';
  for (const r of report.renamed) lines.push(`${report.written ? 'renamed' : 'would rename'} ${r.from} → ${r.to}  [${r.codemod}]`);
  for (const c of report.changed) lines.push(`${verb} ${c.file}  [${c.codemods.join(', ')}]`);
  if (report.changed.length === 0 && report.renamed.length === 0) lines.push('nothing to convert');
  if (report.manual.length > 0) {
    lines.push('', `${report.manual.length} manual step(s) — this code was left as it was:`);
    for (const m of report.manual) {
      lines.push(`  ${m.file}${m.line > 0 ? `:${m.line}` : ''}  ${m.message}  [${m.codemod}]`, `      → ${m.steps}`);
    }
  }
  if (!report.written && (report.changed.length > 0 || report.renamed.length > 0)) lines.push('', 'Dry run: add --write to apply, then type-check and test the plugin.');
  return lines.join('\n');
}

export function codemod(args: Map<string, string | boolean>): number {
  if (args.get('list') === true) {
    for (const c of CODEMODS) process.stdout.write(`${c.id}\n  ${c.title}\n  from: ${c.from}\n  to:   ${c.to}\n`);
    return 0;
  }
  const dir = args.get('dir');
  if (typeof dir !== 'string') throw new Error('codemod requires --dir <plugin directory> (or --list)');
  const only = args.get('only');
  const selected = typeof only === 'string' ? CODEMODS.filter((c) => c.id === only) : CODEMODS;
  if (selected.length === 0) throw new Error(`unknown codemod ${String(only)} (see --list)`);
  const report = runCodemods(path.resolve(dir), selected, { write: args.get('write') === true });
  process.stdout.write(`${formatReport(report)}\n`);
  return report.manual.length > 0 ? 3 : 0;
}

import type { ThemePageType } from '@heopress/contracts/theme';
import { THEME_PAGE_TYPES } from '@heopress/contracts/theme';
import { BUILTIN_THEME } from './builtin.ts';
import { checkTheme, type ThemeIssue } from './check.ts';
import { createThemeEngine, renderTemplate, type ThemeAsset } from './engine.ts';
import { postprocess } from './postprocess.ts';
import { sampleHead, sampleSystemContent, sampleViewModels } from './samples.ts';

/**
 * The checks a theme version passes before it may be published (HeoPress P06 tasks 2.4, 2.7; design §5,
 * R6): the static checks, then every page template rendered with the sample page data — a sponsored item
 * and a sponsored card among it — through the same engine and post-processing as live pages, once with
 * explicit sponsor disclosure off and once on. `ok`: publishable while disclosure is off; `disclosureOk`:
 * also while it is on (the disclosure slots are where they must be).
 *
 * Raised whenever the checks change: versions checked by an older checker are checked again before
 * activation.
 */
export const THEME_CHECKS_VERSION = 4;

export interface ThemeCheckResult {
  validator: number;
  ok: boolean;
  disclosureOk: boolean;
  issues: ThemeIssue[];
}

export async function runThemeChecks(templates: Record<string, string>, assets: ThemeAsset[] = [], versionId = 'check'): Promise<ThemeCheckResult> {
  const issues = checkTheme(templates, assets);
  if (issues.length) return { validator: THEME_CHECKS_VERSION, ok: false, disclosureOk: false, issues };
  const failures = { off: [] as ThemeIssue[], on: [] as ThemeIssue[] };
  const engine = createThemeEngine(templates, { id: versionId, assets });
  const vms = sampleViewModels();
  for (const disclosure of [false, true]) {
    for (const type of THEME_PAGE_TYPES as readonly ThemePageType[]) {
      try {
        const out = await renderTemplate(engine, type, vms[type]);
        postprocess(out.html, out.slots, vms[type], sampleSystemContent(disclosure));
      } catch (err) {
        const message = String((err as Error).message ?? err).split('\n')[0]!.slice(0, 300);
        (disclosure ? failures.on : failures.off).push({ template: type, message: disclosure ? `with sponsor disclosure on: ${message}` : message });
      }
    }
  }
  const ok = failures.off.length === 0;
  return { validator: THEME_CHECKS_VERSION, ok, disclosureOk: ok && failures.on.length === 0, issues: [...failures.off, ...failures.on] };
}

/**
 * The public output of the built-in theme for every sample page, disclosure on (HeoPress P07 task 1.3): what
 * the output contract's digest is computed from (`apps/site-classic/output-contract.json`). A change of the
 * generated markup — the system head, bodies, disclosures — changes it.
 */
export async function sampleOutput(): Promise<string> {
  const engine = createThemeEngine(BUILTIN_THEME, { id: 'builtin', assets: [] });
  const vms = sampleViewModels();
  const out: string[] = [];
  for (const type of THEME_PAGE_TYPES as readonly ThemePageType[]) {
    const rendered = await renderTemplate(engine, type, vms[type]);
    out.push(`--- ${type}\n${postprocess(rendered.html, rendered.slots, vms[type], { ...sampleSystemContent(true), head: sampleHead(type) })}`);
  }
  return out.join('\n');
}

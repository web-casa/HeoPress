import { rm } from 'node:fs/promises';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { runAstroBuild, type BuildLimits, type BuildResult } from './runner';
import { verifyBuild, type VerifyIssue } from './verify';
import { buildDir } from './publish';
import { checkAstroTheme, parseThemeRef, stageTheme, type ThemeIssue } from './themes';

/**
 * The Astro engine's build of one site generation (HeoPress P11 tasks 3.1–3.6): check the theme, serve the pinned
 * snapshot on the loopback page data interface, run the isolated build into the generation's own new directory, and
 * verify the output. It never activates: the caller compares generations and switches (`activate`) — so a failure at
 * any step leaves the live version as it is.
 */

export { runAstroBuild, buildEnv, templateDir, type BuildLimits, type BuildRequest, type BuildResult } from './runner';
export { verifyBuild, checkSponsorSlots, pageFile, type VerifyIssue } from './verify';
export { activate, buildDir, discard, liveGeneration, prune, siteDir, StaleGenerationError } from './publish';
export { checkAstroTheme, officialThemeDir, parseThemeRef, stageTheme, type ThemeIssue, type ThemeRef } from './themes';

export interface SiteBuildOptions {
  root: string;
  generation: number;
  theme: string;
  snapshot: PageDataSnapshot;
  /** Serves the snapshot to the build (`@heopress/site-classic/page-data` `servePageData`). */
  serve: (snapshot: PageDataSnapshot) => Promise<{ url: string; token: string; close(): Promise<void> }>;
  operatorThemesDir?: string;
  approvedIntegrations?: string[];
  limits?: BuildLimits;
  user?: { uid: number; gid: number };
  registry?: string;
}

export type SiteBuildOutcome =
  | { ok: true; outDir: string; result: BuildResult }
  | { ok: false; stage: 'theme' | 'build' | 'verify'; error: string; themeIssues?: ThemeIssue[]; verifyIssues?: VerifyIssue[]; result?: BuildResult };

export async function buildSiteGeneration(opts: SiteBuildOptions): Promise<SiteBuildOutcome> {
  const outDir = buildDir(opts.root, opts.snapshot.siteId, opts.generation);
  let themeDir: string;
  try {
    themeDir = await stageTheme(parseThemeRef(opts.theme), { operatorThemesDir: opts.operatorThemesDir });
  } catch (err) {
    return { ok: false, stage: 'theme', error: (err as Error).message };
  }
  const themeIssues = await checkAstroTheme(themeDir, { approvedIntegrations: opts.approvedIntegrations });
  if (themeIssues.length) return { ok: false, stage: 'theme', error: `theme check failed: ${themeIssues.map((i) => `${i.file}: ${i.message}`).join('; ')}`, themeIssues };
  await rm(outDir, { recursive: true, force: true });
  const server = await opts.serve(opts.snapshot);
  let result: BuildResult;
  try {
    result = await runAstroBuild({
      pageData: { url: server.url, token: server.token },
      themeDir,
      outDir,
      integrations: opts.approvedIntegrations,
      limits: opts.limits,
      user: opts.user,
      registry: opts.registry,
    });
  } finally {
    await server.close();
  }
  if (!result.ok) {
    await rm(outDir, { recursive: true, force: true });
    return { ok: false, stage: 'build', error: result.timedOut ? 'build timed out' : `build failed (exit ${result.code ?? result.signal})`, result };
  }
  const verifyIssues = await verifyBuild(outDir, opts.snapshot);
  if (verifyIssues.length) {
    await rm(outDir, { recursive: true, force: true });
    return { ok: false, stage: 'verify', error: `output check failed: ${verifyIssues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join('; ')}`, verifyIssues, result };
  }
  return { ok: true, outDir, result };
}

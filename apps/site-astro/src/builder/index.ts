import { rm } from 'node:fs/promises';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { runAstroBuild, type BuildLimits, type BuildResult } from './runner';
import { verifyBuild, type VerifyIssue } from './verify';
import { buildDir } from './publish';
import { checkAstroTheme, parseThemeRef, stageTheme, themeBuildSteps, type ThemeIssue } from './themes';
import { runBuildSteps, type BuildStep, type BuildStepResult } from './steps';
import { checkExtensionSources, stageExtensions } from './extensions';

/**
 * The Astro engine's build of one site generation (HeoPress P11 tasks 3.1–3.6): check the theme, serve the pinned
 * snapshot on the loopback page data interface, run the isolated build into the generation's own new directory, and
 * verify the output. It never activates: the caller compares generations and switches (`activate`) — so a failure at
 * any step leaves the live version as it is.
 */

export { runAstroBuild, buildEnv, templateDir, type BuildLimits, type BuildRequest, type BuildResult } from './runner';
export { verifyBuild, checkSponsorSlots, pageFile, type VerifyIssue } from './verify';
export { activate, buildDir, discard, liveGeneration, prune, siteDir, StaleGenerationError } from './publish';
export { checkExtensionSources, stageExtensions, type ExtensionIssue } from './extensions';
export { checkAstroTheme, officialThemeDir, parseThemeRef, stageTheme, themeBuildSteps, type ThemeIssue, type ThemeRef } from './themes';
export { runBuildStep, runBuildSteps, stepAllowedHosts, stepEnv, stepGuardFile, type BuildStep, type BuildStepResult, type BuildStepRun } from './steps';

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
  /**
   * Build steps of the site's operator-trusted plugins (P12 task 4.3; the CMS decides which plugins may have them). They
   * run after the theme's own steps, under the same constraints.
   */
  pluginSteps?: BuildStep[];
}

export type SiteBuildOutcome =
  | { ok: true; outDir: string; result: BuildResult; steps?: BuildStepResult[] }
  | {
      ok: false;
      stage: 'theme' | 'build' | 'steps' | 'verify';
      error: string;
      themeIssues?: ThemeIssue[];
      verifyIssues?: VerifyIssue[];
      result?: BuildResult;
      steps?: BuildStepResult[];
    };

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
  // The site's plugins' templates and components (P12 tasks 2.3, 2.4): checked, then staged for the build.
  const extensionIssues = checkExtensionSources(opts.snapshot);
  if (extensionIssues.length) {
    return { ok: false, stage: 'theme', error: `plugin source check failed: ${extensionIssues.map((i) => `${i.key}: ${i.message}`).join('; ')}`, themeIssues: extensionIssues.map((i) => ({ file: i.key, message: i.message })) };
  }
  const extensionsDir = await stageExtensions(opts.snapshot);
  await rm(outDir, { recursive: true, force: true });
  const server = await opts.serve(opts.snapshot);
  let result: BuildResult;
  let steps: { ok: boolean; results: BuildStepResult[] } = { ok: true, results: [] };
  try {
    result = await runAstroBuild({
      pageData: { url: server.url, token: server.token },
      themeDir,
      extensionsDir,
      outDir,
      integrations: opts.approvedIntegrations,
      limits: opts.limits,
      user: opts.user,
      registry: opts.registry,
    });
    // Build steps (P12 task 4.3): the theme's, then the trusted plugins'; they read the page data while it is served.
    const all = [...(await themeBuildSteps(themeDir, opts.theme)), ...(opts.pluginSteps ?? [])];
    if (result.ok && all.length) {
      steps = await runBuildSteps(
        { outDir, pageData: { url: server.url, token: server.token }, registry: opts.registry, user: opts.user, cpuSeconds: opts.limits?.cpuSeconds, memoryMb: opts.limits?.memoryMb },
        all,
      );
    }
  } finally {
    await server.close();
  }
  if (!result.ok) {
    await rm(outDir, { recursive: true, force: true });
    return { ok: false, stage: 'build', error: result.timedOut ? 'build timed out' : `build failed (exit ${result.code ?? result.signal})`, result };
  }
  if (!steps.ok) {
    await rm(outDir, { recursive: true, force: true });
    const failed = steps.results[steps.results.length - 1]!;
    return { ok: false, stage: 'steps', error: `build step ${failed.owner === 'theme' ? 'theme' : failed.source}/${failed.step} failed: ${failed.reason ?? 'unknown'}`, result, steps: steps.results };
  }
  const verifyIssues = await verifyBuild(outDir, opts.snapshot);
  if (verifyIssues.length) {
    await rm(outDir, { recursive: true, force: true });
    return { ok: false, stage: 'verify', error: `output check failed: ${verifyIssues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join('; ')}`, verifyIssues, result, steps: steps.results };
  }
  return { ok: true, outDir, result, steps: steps.results };
}

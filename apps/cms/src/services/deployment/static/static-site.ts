import { and, eq } from 'drizzle-orm';
import { astroSites, deploymentTargets, siteRenderVersions, type Database } from '@heopress/database';
import { parseThemeRef } from '@heopress/site-astro';
import { runSiteTransaction } from '../../rls-transaction';
import { disableAstroSite, enableAstroSite } from '../../astro/astro-engine';
import { SUPPORT_MATRIX, type StaticPlatform } from './contract';
import { listStaticDeploys, requestStaticDeploy, rollbackCandidate, StaticDeployError } from './static-deployer';

/**
 * A site's static engine and deployment settings for the administration (HeoPress P11 task 4.3; the Studio/API switch
 * that turns the Astro engine on, left open by task 3.x): on/off, theme, deployment target (none: the operator's own
 * server), what is published / built / deployed, the support matrix and the deploy records.
 */

const STATIC_CAPABLE = new Set(['cloudflare-pages', 'vercel', 'netlify']);

export async function staticSiteView(db: Database, siteId: string) {
  const [site] = await db.select().from(astroSites).where(eq(astroSites.siteId, siteId));
  const { published, platform } = await runSiteTransaction(db, siteId, async (tx) => {
    const [v] = await tx.select({ version: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, siteId));
    let p: StaticPlatform = 'vps';
    if (site?.deployTargetId) {
      const [t] = await tx.select({ provider: deploymentTargets.provider }).from(deploymentTargets).where(and(eq(deploymentTargets.siteId, siteId), eq(deploymentTargets.id, site.deployTargetId)));
      if (t && STATIC_CAPABLE.has(t.provider)) p = t.provider as StaticPlatform;
    }
    return { published: v ? Number(v.version) : 0, platform: p };
  });
  const deploys = await listStaticDeploys(db, siteId);
  return {
    enabled: site?.enabled ?? false,
    theme: site?.theme ?? null,
    deployTargetId: site?.deployTargetId ?? null,
    platform,
    publishedRevision: published,
    activeGeneration: site?.activeGeneration ?? null,
    activeRevision: site?.activeRevision ?? null,
    deployedGeneration: site?.deployedGeneration ?? null,
    deployedRevision: site?.deployedRevision ?? null,
    rollbackCandidate: await rollbackCandidate(db, siteId),
    support: SUPPORT_MATRIX,
    deploys: deploys.map(({ marker: _m, siteId: _s, requestedBy: _r, startedAt: _st, ...d }) => d),
  };
}

export async function configureStaticSite(db: Database, siteId: string, input: { enabled: boolean; theme?: string; deployTargetId?: string | null }): Promise<void> {
  if (!input.enabled) {
    await disableAstroSite(db, siteId);
    return;
  }
  const [existing] = await db.select().from(astroSites).where(eq(astroSites.siteId, siteId));
  const theme = input.theme ?? existing?.theme ?? 'official:starter';
  try {
    parseThemeRef(theme);
  } catch (err) {
    throw new StaticDeployError('INVALID_THEME', (err as Error).message);
  }
  let targetId = input.deployTargetId === undefined ? (existing?.deployTargetId ?? null) : input.deployTargetId;
  if (targetId) {
    const [t] = await runSiteTransaction(db, siteId, (tx) =>
      tx.select({ provider: deploymentTargets.provider, status: deploymentTargets.status }).from(deploymentTargets).where(and(eq(deploymentTargets.siteId, siteId), eq(deploymentTargets.id, targetId!))),
    );
    if (!t) throw new StaticDeployError('TARGET_NOT_FOUND', 'Deployment target not found.');
    if (!STATIC_CAPABLE.has(t.provider)) throw new StaticDeployError('TARGET_UNSUPPORTED', `${t.provider} cannot host the static output.`);
  } else targetId = null;
  await enableAstroSite(db, siteId, theme);
  const moved = (existing?.deployTargetId ?? null) !== targetId;
  await db
    .update(astroSites)
    .set({ deployTargetId: targetId, ...(moved ? { deployedGeneration: null, deployedRevision: null } : {}), updatedAt: new Date() })
    .where(eq(astroSites.siteId, siteId));
  // A new target serves nothing yet: the live build is deployed to it.
  if (moved && existing?.activeGeneration != null) {
    await requestStaticDeploy(db, siteId, { kind: 'deploy', generation: existing.activeGeneration, revision: existing.activeRevision });
  }
}

// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Hono } from 'hono';
import type { BuildMetadata } from '@heopress/contracts';
import type { AppEnv, Bindings } from '../env';
import { processWriteGate } from '../services/maintenance/write-gate';

const UNKNOWN_METADATA_VALUE = 'unknown';

type ProcessLike = {
  env?: Record<string, string | undefined>;
};

function valueOrUnknown(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : UNKNOWN_METADATA_VALUE;
}

function getProcessEnv(): Record<string, string | undefined> {
  return ((globalThis as typeof globalThis & { process?: ProcessLike }).process?.env) ?? {};
}

/**
 * Metadata baked into the Node bundle at build time by
 * `scripts/with-build-metadata.mjs` (`--define`). The Worker gets the same
 * values as `wrangler --var` bindings, but the Docker image runs
 * `dist/serve.cjs` with whatever env the operator passes — which never
 * includes the version — so every published image answered
 * `version: "unknown"`, and the "determine your current version" step of the
 * upgrade runbook could not work. Runtime env still wins when set.
 */
declare const __HEOPRESS_BUILD_METADATA__: Record<string, string | undefined> | undefined;

function getBakedMetadata(): Record<string, string | undefined> {
  return typeof __HEOPRESS_BUILD_METADATA__ === 'object' && __HEOPRESS_BUILD_METADATA__
    ? __HEOPRESS_BUILD_METADATA__
    : {};
}

export function resolveBuildMetadata(
  env: Partial<Bindings> = {},
  processEnv: Record<string, string | undefined> = getProcessEnv(),
  baked: Record<string, string | undefined> = getBakedMetadata(),
): BuildMetadata {
  const pick = (key: keyof BuildMetadataEnv) =>
    valueOrUnknown(firstKnown(env[key], processEnv[key], baked[key]));
  return {
    version: pick('HEOPRESS_VERSION'),
    gitSha: pick('HEOPRESS_GIT_SHA'),
    buildTime: pick('HEOPRESS_BUILD_TIME'),
    releaseChannel: pick('HEOPRESS_RELEASE_CHANNEL'),
  };
}

type BuildMetadataEnv = Pick<
  Bindings,
  'HEOPRESS_VERSION' | 'HEOPRESS_GIT_SHA' | 'HEOPRESS_BUILD_TIME' | 'HEOPRESS_RELEASE_CHANNEL'
>;

/**
 * First value that is set and not the `unknown` placeholder. Deployments may
 * set `HEOPRESS_VERSION = "unknown"` as a default, so a plain `??`
 * would let that placeholder shadow a real baked value.
 */
function firstKnown(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && trimmed !== UNKNOWN_METADATA_VALUE) return trimmed;
  }
  return undefined;
}

export const systemRouter = new Hono<AppEnv>();

systemRouter.get('/version', (c) => {
  return c.json(resolveBuildMetadata(c.env), 200);
});

/**
 * Maintenance state (HeoPress P13 upgrade write freeze), public like `/version`: whether changes are paused and since
 * when, so Studio can say why a save is refused. Read from this process's write gate, not the database.
 */
systemRouter.get('/maintenance', (c) => {
  const state = processWriteGate()?.snapshot();
  return c.json({ data: { active: state?.active ?? false, reason: state?.active ? state.reason : null, since: state?.active ? state.startedAt : null } }, 200);
});

/**
 * Optional features that are off on a fresh install (P02 task 5.1; ADR-0004
 * "保留但默认关闭"; spec platform/feature-surface "默认关闭的功能").
 *
 * Each feature is switched on by one environment variable set to `true` (or
 * `1`) and takes effect on restart. While a feature is off its HTTP surface
 * answers 404, its scheduled work is not scheduled, its request-path work does
 * not run, and Studio hides its entry points (`GET /api/v1/features`).
 *
 * This is process-level configuration. The per-site Content OS rollout flags
 * (`services/feature-flags.ts`) are a separate, finer switch that still
 * applies once a feature is on.
 */
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';

export const FEATURE_ENV = {
  /** `ALL /api/v1/graphql`. */
  graphql: 'HEOPRESS_ENABLE_GRAPHQL',
  /** Multi-agent newsroom: role library and planner delegation (`/agent/roles`, `/agent/goals/:id/decompose|settle`). */
  agentNewsroom: 'HEOPRESS_ENABLE_AGENT_NEWSROOM',
  /** Content goals, drift detection and automatic repair (`/agent/intents`, the goal dispatch tick). */
  contentGoals: 'HEOPRESS_ENABLE_CONTENT_GOALS',
  /** External identity issuers (SSO): trusted-issuer JWTs and `/admin/auth/issuers`. */
  externalIssuers: 'HEOPRESS_ENABLE_EXTERNAL_ISSUERS',
  /** Login anomaly scoring (geo/time/device detectors and baseline updates). */
  loginAnomaly: 'HEOPRESS_ENABLE_LOGIN_ANOMALY',
  /** Prometheus metrics (`GET /metrics` and request metric collection). */
  metrics: 'HEOPRESS_ENABLE_METRICS',
  /**
   * Field-level encryption of content fields (`encrypted`, and the `pii|phi`
   * classifications that require it). Encryption of stored secrets (tokens,
   * keys, TOTP) is not affected.
   */
  fieldEncryption: 'HEOPRESS_ENABLE_FIELD_ENCRYPTION',
} as const;

export type Feature = keyof typeof FEATURE_ENV;
export type FeatureSet = Record<Feature, boolean>;

type EnvLike = Record<string, unknown> | undefined;

function truthy(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** `c.env` wins over `process.env`, matching how the rest of the app reads configuration. */
function lookup(name: string, env: EnvLike): unknown {
  const fromBindings = env?.[name];
  if (fromBindings !== undefined) return fromBindings;
  return typeof process !== 'undefined' ? process.env[name] : undefined;
}

export function isFeatureEnabled(feature: Feature, env?: EnvLike): boolean {
  return truthy(lookup(FEATURE_ENV[feature], env));
}

export function enabledFeatures(env?: EnvLike): FeatureSet {
  const out = {} as FeatureSet;
  for (const feature of Object.keys(FEATURE_ENV) as Feature[]) out[feature] = isFeatureEnabled(feature, env);
  return out;
}

/** Answers 404 (as if the route did not exist) while `feature` is off. */
export const requireFeature = (feature: Feature) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!isFeatureEnabled(feature, c.env as unknown as EnvLike)) {
      return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Not Found' }] }, 404);
    }
    await next();
  });

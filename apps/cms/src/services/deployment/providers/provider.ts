// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Deployment provider adapter contract (spec: deployment-integrations,
 * design §4). Each external hosting platform (Vercel, Netlify, …) implements
 * this interface; the DeploymentService talks only to the interface so adding
 * a provider is a single new adapter + a `registerProvider` call.
 *
 * All outbound HTTP from adapters MUST pass through the SSRF guard
 * (`validateOutboundUrl`) and use a timeout, identical to the Flow `http`
 * operation policy.
 */

/** HeoPress-normalized deployment status (design §3.3). */
export type DeploymentStatus = 'queued' | 'building' | 'ready' | 'error' | 'canceled';

export const TERMINAL_STATUSES: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>([
  'ready',
  'error',
  'canceled',
]);

/** Minimal view of a target the adapter needs (no secrets). */
export interface ProviderTarget {
  provider: string;
  projectId: string;
  defaultBranch?: string | null;
}

/** Normalized reference to a Provider deployment. */
export interface DeploymentRef {
  providerDeploymentId: string;
  status: DeploymentStatus;
  url?: string;
  branch?: string;
  commitSha?: string;
  commitMessage?: string;
  errorMessage?: string;
  completedAt?: Date;
}

export interface TriggerOptions {
  branch?: string;
  reason?: string;
}

export interface InboundRequest {
  headers: Record<string, string>;
  rawBody: string;
}

/** One file of a static deployment (HeoPress P11 task 4.1): its path in the output (`/a/b/index.html`) and bytes. */
export interface StaticFile {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

interface StaticDeployOptions {
  /** Written into the provider's deployment (message / title / meta) so a deployment whose confirmation was lost can be found. */
  marker: string;
}

export interface DeploymentProvider {
  readonly key: string;
  /** Read-only call to verify a token/project pair when creating a target. */
  verifyToken(token: string, target: ProviderTarget): Promise<{ ok: boolean; reason?: string }>;
  /** Trigger a build/deploy; returns a ref if the Provider assigns an id now. */
  trigger(token: string, target: ProviderTarget, opts: TriggerOptions): Promise<DeploymentRef>;
  /** Current status of a single deployment (for poller / refresh). */
  getStatus(token: string, target: ProviderTarget, providerDeploymentId: string): Promise<DeploymentRef>;
  /** Build log (for debug). */
  getLogs(token: string, target: ProviderTarget, providerDeploymentId: string): Promise<string>;
  /**
   * Verify an inbound status-webhook signature against `secret` (the per-site
   * configured webhook secret). Performs real HMAC/JWS verification over the
   * raw body via Web Crypto, so it is async. A missing/invalid signature or an
   * empty secret returns `false`.
   */
  verifyWebhook(req: InboundRequest, secret: string): Promise<boolean>;
  /** Parse an inbound status-webhook payload into a normalized ref. */
  parseWebhook(rawBody: string): DeploymentRef | null;
  /**
   * Upload a built static output as a new production deployment (HeoPress P11 tasks 4.1, 4.2): the provider does not
   * build. Resolves once the provider accepted the deployment (its status may still be in progress: poll `getStatus`).
   */
  deployStatic?(token: string, target: ProviderTarget, files: StaticFile[], opts: StaticDeployOptions): Promise<DeploymentRef>;
  /** The deployment carrying `marker`, if the provider has one (a lost confirmation is looked up before any retry). */
  findByMarker?(token: string, target: ProviderTarget, marker: string): Promise<DeploymentRef | null>;
}

const registry = new Map<string, DeploymentProvider>();

export function registerProvider(provider: DeploymentProvider): void {
  registry.set(provider.key, provider);
}

export function getProvider(key: string): DeploymentProvider | undefined {
  return registry.get(key);
}

export function listProviders(): string[] {
  return [...registry.keys()];
}

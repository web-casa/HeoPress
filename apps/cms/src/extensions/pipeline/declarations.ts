/**
 * What a site's plugins declare on the pipeline extension points (HeoPress P12 tasks 4.1–4.3; spec
 * extensions/pipeline-extensions), read from the installed rows without loading any plugin code: the source adapters
 * offered to the site's editors, the gate checks the quality gate must run, and the build steps of the static build.
 *
 * A plugin takes part only when it is installed on the site, enabled, its permissions are approved (not waiting for a
 * re-confirmation) and it holds the extension point's capability (`ext:source-adapters`, `ext:gate-checks`,
 * `ext:build-steps`). Build steps additionally need the operator's trust mark (`isOperatorTrusted`).
 */
import { and, asc, eq } from 'drizzle-orm';
import { extensions } from '@heopress/database';
import {
  allowsHost,
  declaresExtensionPoint,
  extensionNamespace,
  pipelineDeclarationsOf,
  pluginGateRule,
  sourceAdapterRef,
  parseSourceAdapterRef,
  type ExtensionBuildStep,
  type ExtensionPoint,
} from '@heopress/contracts/extensions';
import type { SiteTransaction } from '../../services/rls-transaction';

export type ExtensionRow = typeof extensions.$inferSelect;

const capsOf = (row: Pick<ExtensionRow, 'capabilities'>): string[] => (Array.isArray(row.capabilities) ? (row.capabilities as string[]) : []);

/** Whether an installed plugin takes part in an extension point now. */
export function participates(row: Pick<ExtensionRow, 'enabled' | 'permissionsStatus' | 'capabilities'>, point: ExtensionPoint): boolean {
  return row.enabled && row.permissionsStatus === 'approved' && declaresExtensionPoint(capsOf(row), point);
}

/** Whether the operator marked the plugin as trusted (the trust mark of P12 task 3.6, `lumibase_extensions.trusted`). */
export function isOperatorTrusted(row: Pick<ExtensionRow, 'trusted'>): boolean {
  return row.trusted === true;
}

/** The site's installed plugins taking part in `point`. */
export async function participatingRows(tx: SiteTransaction, siteId: string, point: ExtensionPoint): Promise<ExtensionRow[]> {
  const rows = await tx.select().from(extensions).where(and(eq(extensions.siteId, siteId), eq(extensions.enabled, true))).orderBy(asc(extensions.name));
  return rows.filter((r) => participates(r, point));
}

// ---------- source adapters (task 4.1) ----------

export interface DeclaredSourceAdapter {
  /** `<plugin name>#<adapter id>`: what a `plugin` source stores in `adapter`. */
  ref: string;
  plugin: string;
  adapterId: string;
  label: string;
  description: string | null;
  /** The hosts the plugin may reach (`http:fetch:<host>`): a source's address must be one of them. */
  hosts: string[];
}

export async function declaredSourceAdapters(tx: SiteTransaction, siteId: string): Promise<DeclaredSourceAdapter[]> {
  const out: DeclaredSourceAdapter[] = [];
  for (const row of await participatingRows(tx, siteId, 'source-adapters')) {
    const hosts = capsOf(row).filter((c) => c.startsWith('http:fetch:')).map((c) => c.slice('http:fetch:'.length));
    for (const a of pipelineDeclarationsOf(row.manifest).sourceAdapters ?? []) {
      out.push({ ref: sourceAdapterRef(row.name, a.id), plugin: row.name, adapterId: a.id, label: a.label, description: a.description ?? null, hosts });
    }
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

/** The adapter a source names, when its plugin offers it on the site now. */
export async function findSourceAdapter(tx: SiteTransaction, siteId: string, ref: string): Promise<DeclaredSourceAdapter | null> {
  if (!parseSourceAdapterRef(ref)) return null;
  return (await declaredSourceAdapters(tx, siteId)).find((a) => a.ref === ref) ?? null;
}

/** Whether the adapter's plugin may reach the host of `url` (its declared `http:fetch:<host>` capabilities). */
export function adapterReaches(adapter: DeclaredSourceAdapter, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowsHost(adapter.hosts.map((h) => `http:fetch:${h}`), host);
}

// ---------- gate checks (task 4.2) ----------

export interface DeclaredGateCheck {
  /** `ext:<namespace>:<check id>`: the rule its results carry. */
  rule: `ext:${string}`;
  plugin: string;
  checkId: string;
  label: string;
  /** Collections it looks at; null: all. */
  collections: string[] | null;
  timeoutMs: number;
}

const DEFAULT_CHECK_MS = 5000;

export async function declaredGateChecks(tx: SiteTransaction, siteId: string): Promise<DeclaredGateCheck[]> {
  const out: DeclaredGateCheck[] = [];
  for (const row of await participatingRows(tx, siteId, 'gate-checks')) {
    const ns = extensionNamespace(row.name);
    if (!ns) continue;
    for (const c of pipelineDeclarationsOf(row.manifest).gateChecks ?? []) {
      out.push({
        rule: pluginGateRule(ns, c.id),
        plugin: row.name,
        checkId: c.id,
        label: c.label,
        collections: c.collections?.length ? c.collections : null,
        timeoutMs: c.timeoutMs ?? DEFAULT_CHECK_MS,
      });
    }
  }
  return out.sort((a, b) => a.rule.localeCompare(b.rule));
}

// ---------- build steps (task 4.3) ----------

export interface PluginBuildStepPlan {
  /** Steps that run with the build: trusted plugins only. */
  run: Array<{ plugin: string; namespace: string; step: ExtensionBuildStep }>;
  /** Steps that do not, with why. */
  skipped: Array<{ plugin: string; step: string; reason: string }>;
}

/**
 * The plugin build steps of a site's next static build. A step declared by a plugin the operator did not mark as
 * trusted — a marketplace plugin included — is never run: it is skipped with its reason (spec "主题构建步骤").
 */
export async function pluginBuildSteps(tx: SiteTransaction, siteId: string): Promise<PluginBuildStepPlan> {
  const plan: PluginBuildStepPlan = { run: [], skipped: [] };
  for (const row of await participatingRows(tx, siteId, 'build-steps')) {
    const steps = pipelineDeclarationsOf(row.manifest).buildSteps ?? [];
    const ns = extensionNamespace(row.name);
    for (const step of steps) {
      if (!isOperatorTrusted(row)) {
        plan.skipped.push({
          plugin: row.name,
          step: step.id,
          reason: row.marketplaceSlug
            ? 'not trusted: a marketplace plugin\'s build steps run only once the operator marks it as trusted'
            : 'not trusted: build steps run only for plugins the operator marked as trusted',
        });
      } else if (!ns) {
        plan.skipped.push({ plugin: row.name, step: step.id, reason: 'the plugin name gives no namespace' });
      } else {
        plan.run.push({ plugin: row.name, namespace: ns, step });
      }
    }
  }
  return plan;
}

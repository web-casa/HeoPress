import { and, eq } from 'drizzle-orm';
import {
  IngestFetchChainSchema,
  IngestProviderUpdateSchema,
  type FetchChainStep,
  type IngestProviderResource,
} from '@heopress/contracts/schemas';
import { ingestProviderSettings, ingestProviderUsage, ingestSourceFetchChains, ingestSources, type Database } from '@heopress/database';
import type { KeyProvider } from '@heopress/runtime';
import { openSecret, sealSecret } from '../../crypto/secret-vault';
import { runSiteTransaction, type SiteTransaction } from '../../rls-transaction';
import { IngestSourceError } from '../source-service';
import { monthOf } from './budget';
import { CRAWL_PROVIDERS } from './registry';
import { isProviderId, PROVIDER_IDS, type ProviderConfig, type ProviderId } from './types';

/**
 * A site's crawl-service settings (HeoPress P08 tasks 3.3, 3.4, 3.6).
 *
 * - Credentials are sealed with the runtime KEK; the AAD names the site and the service, so the ciphertext opens only
 *   for that site and service — a key configured for site A is unusable for site B even if its row were copied.
 *   They are write-only: no API returns them.
 * - A service is usable for a site only when enabled, confirmed for sending target URLs (`consentAt`), configured
 *   (credential and required options), within the month's budget and not paused by the breaker.
 * - Every query is scoped to the site (row-level security as well).
 */

type Row = typeof ingestProviderSettings.$inferSelect;
type UsageRow = typeof ingestProviderUsage.$inferSelect;

const credentialAad = (siteId: string, provider: ProviderId) => `ingest-provider|${siteId}|${provider}`;

type UnavailableReason = NonNullable<IngestProviderResource['unavailableReason']>;

/** Why a service cannot be used for the site now (null: it can). */
function unavailableReason(provider: ProviderId, row: Row | undefined, usage: UsageRow | undefined, now: Date): UnavailableReason | null {
  const manifest = CRAWL_PROVIDERS[provider].manifest;
  if (!row?.enabled) return 'disabled';
  if (!row.consentAt) return 'no_consent';
  if (manifest.credential !== 'optional_token' && !row.credentialCiphertext) return 'no_credential';
  for (const opt of manifest.requiredOptions ?? []) if (!row.options?.[opt]) return 'missing_option';
  if (usage?.exhaustedAt) return 'budget_exhausted';
  if (row.pausedUntil && row.pausedUntil.getTime() > now.getTime()) return 'breaker_open';
  return null;
}

export interface ProviderState {
  provider: ProviderId;
  row: Row | undefined;
  usage: UsageRow | undefined;
  unavailable: UnavailableReason | null;
}

/** Every service's settings and this month's usage for the site. */
export async function loadProviderStates(tx: SiteTransaction, siteId: string, now: Date): Promise<ProviderState[]> {
  const rows = await tx.select().from(ingestProviderSettings).where(eq(ingestProviderSettings.siteId, siteId));
  const usage = await tx
    .select()
    .from(ingestProviderUsage)
    .where(and(eq(ingestProviderUsage.siteId, siteId), eq(ingestProviderUsage.month, monthOf(now))));
  return PROVIDER_IDS.map((provider) => {
    const row = rows.find((r) => r.provider === provider);
    const u = usage.find((r) => r.provider === provider);
    return { provider, row, usage: u, unavailable: unavailableReason(provider, row, u, now) };
  });
}

/** The site's default chain: native first, then the enabled services by position. */
function defaultChain(states: ProviderState[]): FetchChainStep[] {
  const enabled = states.filter((s) => s.row?.enabled).sort((a, b) => (a.row!.position - b.row!.position) || a.provider.localeCompare(b.provider));
  return ['native', ...enabled.map((s) => s.provider)];
}

/** The chain of a source: its own, else the site's default. */
export async function chainFor(tx: SiteTransaction, siteId: string, sourceId: string, states: ProviderState[]): Promise<FetchChainStep[]> {
  const [own] = await tx
    .select({ chain: ingestSourceFetchChains.chain })
    .from(ingestSourceFetchChains)
    .where(and(eq(ingestSourceFetchChains.siteId, siteId), eq(ingestSourceFetchChains.sourceId, sourceId)));
  if (own?.chain.length) return own.chain.filter((s): s is FetchChainStep => s === 'native' || isProviderId(s));
  return defaultChain(states);
}

/** The service's configuration with its credential opened for this site (null credential: none set). */
export async function providerConfig(keys: KeyProvider, siteId: string, provider: ProviderId, row: Row | undefined): Promise<ProviderConfig> {
  const options = row?.options ?? {};
  if (!row?.credentialCiphertext) return { credential: null, options };
  return { credential: await openSecret(keys, row.credentialCiphertext, credentialAad(siteId, provider)), options };
}

function toResource(s: ProviderState, now: Date): IngestProviderResource {
  const m = CRAWL_PROVIDERS[s.provider].manifest;
  return {
    provider: s.provider,
    enabled: s.row?.enabled ?? false,
    position: s.row?.position ?? 0,
    consentAt: s.row?.consentAt?.toISOString() ?? null,
    credentialSet: Boolean(s.row?.credentialCiphertext),
    credentialHint: s.row?.credentialHint ?? null,
    credentialKind: m.credential,
    hosts: [...m.hosts],
    endpoint: s.row?.options?.endpoint ?? null,
    accountId: s.row?.options?.accountId ?? null,
    monthlyBudgetUsd: s.row?.monthlyBudgetMicros == null ? null : s.row.monthlyBudgetMicros / 1e6,
    pausedUntil: s.row?.pausedUntil && s.row.pausedUntil.getTime() > now.getTime() ? s.row.pausedUntil.toISOString() : null,
    usage: {
      month: monthOf(now),
      requests: s.usage?.requests ?? 0,
      failures: s.usage?.failures ?? 0,
      costUsd: (s.usage?.costMicros ?? 0) / 1e6,
      exhausted: Boolean(s.usage?.exhaustedAt),
    },
    unavailableReason: s.unavailable,
  };
}

export class IngestProviderService {
  constructor(private readonly deps: { db: Database; siteId: string; keys: KeyProvider; userId: string | null; now?: () => Date }) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private tx<T>(fn: (tx: SiteTransaction) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, fn);
  }

  async list(): Promise<IngestProviderResource[]> {
    const now = this.now();
    return this.tx(async (tx) => (await loadProviderStates(tx, this.deps.siteId, now)).map((s) => toResource(s, now)));
  }

  async update(provider: string, body: unknown): Promise<IngestProviderResource> {
    if (!isProviderId(provider)) throw new IngestSourceError('NOT_FOUND', `Unknown crawl service "${provider}".`, 404);
    const parsed = IngestProviderUpdateSchema.safeParse(body);
    if (!parsed.success) throw new IngestSourceError('VALIDATION', 'Invalid crawl service settings.', 400, parsed.error.issues);
    const v = parsed.data;
    const { siteId } = this.deps;
    const now = this.now();
    const sealed = v.credential ? await sealSecret(this.deps.keys, v.credential, credentialAad(siteId, provider)) : null;
    return this.tx(async (tx) => {
      await tx.insert(ingestProviderSettings).values({ siteId, provider, updatedBy: this.deps.userId, updatedAt: now }).onConflictDoNothing();
      const where = and(eq(ingestProviderSettings.siteId, siteId), eq(ingestProviderSettings.provider, provider));
      const [row] = await tx.select().from(ingestProviderSettings).where(where).for('update');
      const options = { ...(row?.options ?? {}) };
      if (v.endpoint !== undefined) {
        if (v.endpoint) options.endpoint = v.endpoint;
        else delete options.endpoint;
      }
      if (v.accountId !== undefined) {
        if (v.accountId) options.accountId = v.accountId;
        else delete options.accountId;
      }
      const budget = v.monthlyBudgetUsd === undefined ? undefined : v.monthlyBudgetUsd === null ? null : Math.round(v.monthlyBudgetUsd * 1e6);
      await tx
        .update(ingestProviderSettings)
        .set({
          ...(v.enabled !== undefined ? { enabled: v.enabled } : {}),
          ...(v.position !== undefined ? { position: v.position } : {}),
          ...(v.consent !== undefined ? { consentAt: v.consent ? now : null, consentBy: v.consent ? this.deps.userId : null } : {}),
          ...(sealed ? { credentialCiphertext: sealed.ciphertext, credentialKeyId: sealed.keyId, credentialHint: v.credential!.slice(-4) } : {}),
          ...(v.credential === null ? { credentialCiphertext: null, credentialKeyId: null, credentialHint: null } : {}),
          ...(budget !== undefined ? { monthlyBudgetMicros: budget } : {}),
          // A change of endpoint or key is a fresh start for the breaker.
          ...(sealed || v.endpoint !== undefined ? { consecutiveFailures: 0, pausedUntil: null } : {}),
          options,
          updatedBy: this.deps.userId,
          updatedAt: now,
        })
        .where(where);
      // A higher (or no) ceiling turns the service back on for this month.
      if (budget !== undefined) {
        const key = and(eq(ingestProviderUsage.siteId, siteId), eq(ingestProviderUsage.provider, provider), eq(ingestProviderUsage.month, monthOf(now)));
        const [u] = await tx.select().from(ingestProviderUsage).where(key);
        if (u?.exhaustedAt && (budget === null || u.costMicros < budget)) await tx.update(ingestProviderUsage).set({ exhaustedAt: null, updatedAt: now }).where(key);
      }
      const state = (await loadProviderStates(tx, siteId, now)).find((s) => s.provider === provider)!;
      return toResource(state, now);
    });
  }

  async getChain(sourceId: string): Promise<{ chain: FetchChainStep[]; custom: boolean }> {
    const { siteId } = this.deps;
    return this.tx(async (tx) => {
      await this.assertSource(tx, sourceId);
      const [own] = await tx
        .select({ chain: ingestSourceFetchChains.chain })
        .from(ingestSourceFetchChains)
        .where(and(eq(ingestSourceFetchChains.siteId, siteId), eq(ingestSourceFetchChains.sourceId, sourceId)));
      return { chain: await chainFor(tx, siteId, sourceId, await loadProviderStates(tx, siteId, this.now())), custom: Boolean(own) };
    });
  }

  async setChain(sourceId: string, body: unknown): Promise<{ chain: FetchChainStep[]; custom: boolean }> {
    const parsed = IngestFetchChainSchema.safeParse(body);
    if (!parsed.success) throw new IngestSourceError('VALIDATION', 'Invalid fetch chain.', 400, parsed.error.issues);
    const { siteId } = this.deps;
    const now = this.now();
    await this.tx(async (tx) => {
      await this.assertSource(tx, sourceId);
      const where = and(eq(ingestSourceFetchChains.siteId, siteId), eq(ingestSourceFetchChains.sourceId, sourceId));
      if (parsed.data.chain === null) await tx.delete(ingestSourceFetchChains).where(where);
      else {
        await tx
          .insert(ingestSourceFetchChains)
          .values({ siteId, sourceId, chain: parsed.data.chain, updatedAt: now })
          .onConflictDoUpdate({ target: [ingestSourceFetchChains.siteId, ingestSourceFetchChains.sourceId], set: { chain: parsed.data.chain, updatedAt: now } });
      }
    });
    return this.getChain(sourceId);
  }

  private async assertSource(tx: SiteTransaction, sourceId: string): Promise<void> {
    const [s] = await tx.select({ id: ingestSources.id }).from(ingestSources).where(and(eq(ingestSources.siteId, this.deps.siteId), eq(ingestSources.id, sourceId)));
    if (!s) throw new IngestSourceError('NOT_FOUND', 'Source not found.', 404);
  }
}

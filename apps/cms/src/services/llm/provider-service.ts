import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  LLM_SECRET_MASK,
  LLM_TASK_REQUIREMENTS,
  type LlmCapabilities,
  type LlmPricing,
  type LlmProviderCreateInput,
  type LlmProviderResource,
  type LlmProviderUpdateInput,
  type LlmSettingsInput,
  type LlmTaskType,
} from '@heopress/contracts/schemas';
import { llmAttempts, llmProviders, llmRoutes, llmSiteSettings, type Database } from '@heopress/database';
import type { KeyProvider } from '@heopress/runtime';
import { nanoid } from 'nanoid';
import { openSecret, sealSecret } from '../crypto/secret-vault';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';

/**
 * A site's model providers, the failover list per task type, and its
 * currency and budget (HeoPress P04 tasks 7.1–7.2; design
 * "模型提供方实施方案"). Site administrators only (control-plane route).
 *
 * - The API key is sealed with the instance KEK (AAD bound to the provider)
 *   and never returned: the resource shows a mask.
 * - Prices are mandatory and in the site's currency; the currency cannot
 *   change once the site has ledger entries. Changing it takes the site's
 *   ledger lock, as reservations do.
 * - A list is checked when saved: every provider is the site's own,
 *   enabled, not deleted, in the site's currency and declares what the task
 *   type needs. A capability error is a configuration error, not a skip.
 * - Deleting a provider is soft: the ledger keeps referring to it and the
 *   lists keep naming it, so a list whose providers are all gone fails
 *   loudly instead of falling back to the instance's own credentials.
 */

export class LlmConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 422 | 503 = 400,
  ) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

export interface LlmProviderServiceDeps {
  db: Database;
  siteId: string;
  keys: KeyProvider;
  /** The instance currency (`LLM_PRICE_CURRENCY`), the default for a site without settings. */
  instanceCurrency: string;
}

export interface LlmSiteSettings {
  currency: string;
  monthlyBudgetMicros: number | null;
  budgetTimezone: string;
  /** HeoPress P09: daily model budget in the site's time zone (null: none). */
  dailyBudgetMicros: number | null;
  /** HeoPress P09: source documents admitted into processing per local day (null: no limit). */
  dailyProcessingLimit: number | null;
}

type ProviderRow = typeof llmProviders.$inferSelect;

const secretAad = (providerId: string) => `llm-provider:${providerId}`;

/**
 * The database's own clock, to the microsecond: a configuration's version (a
 * probe result is kept only for the version it probed) never depends on an
 * application server's clock or millisecond precision.
 */
const dbNow = () => sql`clock_timestamp()` as unknown as Date;

/** The site's ledger lock: reservations, settlement and currency changes take it first. */
async function lockSiteLedger(tx: SiteTransaction, siteId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`heopress-llm-ledger:${siteId}`}))`);
}

/** A secret cannot be sealed or opened without the instance key: say so, as an operator setting. */
async function withInstanceKey<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof Error && /no encryption key configured/i.test(err.message)) {
      throw new LlmConfigError(
        'ENCRYPTION_NOT_CONFIGURED',
        'Model provider keys need the instance encryption key (ENCRYPTION_KEY, or the version the key was sealed with): configure it and restart.',
        503,
      );
    }
    throw err;
  }
}

/** The stored prices; a missing one is never read as zero (the database refuses it anyway). */
function pricingOf(row: ProviderRow): LlmPricing {
  if (row.pricingKind === 'per_request') {
    if (row.requestPriceMicros === null) throw new Error(`Model provider ${row.id} has no request price.`);
    return { kind: 'per_request', requestMicros: row.requestPriceMicros };
  }
  if (row.inputPriceMicros === null || row.outputPriceMicros === null) throw new Error(`Model provider ${row.id} has no token prices.`);
  return { kind: 'per_1m_tokens', inputMicros: row.inputPriceMicros, outputMicros: row.outputPriceMicros };
}

function pricingColumns(p: LlmPricing) {
  return p.kind === 'per_request'
    ? { pricingKind: p.kind, requestPriceMicros: p.requestMicros, inputPriceMicros: null, outputPriceMicros: null }
    : { pricingKind: p.kind, inputPriceMicros: p.inputMicros, outputPriceMicros: p.outputMicros, requestPriceMicros: null };
}

/** Which of a task type's needs a provider's declared capabilities do not meet. */
function missingCapabilities(taskType: LlmTaskType, caps: LlmCapabilities): string[] {
  const need = LLM_TASK_REQUIREMENTS[taskType];
  return [...(need.tools && !caps.tools ? ['tools'] : []), ...(need.json && !caps.json ? ['json'] : [])];
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export class LlmProviderService {
  constructor(private readonly deps: LlmProviderServiceDeps) {}

  private get siteId(): string {
    return this.deps.siteId;
  }

  private tx<T>(fn: (tx: SiteTransaction) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.siteId, fn);
  }

  // ── settings ────────────────────────────────────────────────────────

  async settings(tx?: SiteTransaction): Promise<LlmSiteSettings> {
    const run = async (t: SiteTransaction) => {
      const [row] = await t.select().from(llmSiteSettings).where(eq(llmSiteSettings.siteId, this.siteId));
      return row
        ? {
            currency: row.currency,
            monthlyBudgetMicros: row.monthlyBudgetMicros ?? null,
            budgetTimezone: row.budgetTimezone,
            dailyBudgetMicros: row.dailyBudgetMicros ?? null,
            dailyProcessingLimit: row.dailyProcessingLimit ?? null,
          }
        : { currency: this.deps.instanceCurrency, monthlyBudgetMicros: null, budgetTimezone: 'UTC', dailyBudgetMicros: null, dailyProcessingLimit: null };
    };
    return tx ? run(tx) : this.tx(run);
  }

  async updateSettings(input: LlmSettingsInput): Promise<LlmSiteSettings> {
    if (!isValidTimeZone(input.budgetTimezone)) {
      throw new LlmConfigError('VALIDATION', 'Unknown time zone.', 400);
    }
    return this.tx(async (tx) => {
      await lockSiteLedger(tx, this.siteId);
      const current = await this.settings(tx);
      if (input.currency !== current.currency) {
        const [entry] = await tx.select({ id: llmAttempts.id }).from(llmAttempts).where(eq(llmAttempts.siteId, this.siteId)).limit(1);
        if (entry) {
          throw new LlmConfigError('CURRENCY_LOCKED', 'The currency cannot change once the site has model usage on record.', 409);
        }
        const [other] = await tx
          .select({ id: llmProviders.id })
          .from(llmProviders)
          .where(and(eq(llmProviders.siteId, this.siteId), isNull(llmProviders.deletedAt), sql`${llmProviders.currency} <> ${input.currency}`))
          .limit(1);
        if (other) {
          throw new LlmConfigError('PRICE_CURRENCY_MISMATCH', 'Providers of this site are priced in another currency: change their prices first.', 409);
        }
      }
      const values = {
        siteId: this.siteId,
        currency: input.currency,
        monthlyBudgetMicros: input.monthlyBudgetMicros,
        budgetTimezone: input.budgetTimezone,
        // Omitted: unchanged.
        dailyBudgetMicros: input.dailyBudgetMicros === undefined ? current.dailyBudgetMicros : input.dailyBudgetMicros,
        dailyProcessingLimit: input.dailyProcessingLimit === undefined ? current.dailyProcessingLimit : input.dailyProcessingLimit,
        updatedAt: dbNow(),
      };
      await tx.insert(llmSiteSettings).values(values).onConflictDoUpdate({ target: llmSiteSettings.siteId, set: values });
      return {
        currency: values.currency,
        monthlyBudgetMicros: values.monthlyBudgetMicros,
        budgetTimezone: values.budgetTimezone,
        dailyBudgetMicros: values.dailyBudgetMicros,
        dailyProcessingLimit: values.dailyProcessingLimit,
      };
    });
  }

  // ── providers ───────────────────────────────────────────────────────

  async list(): Promise<LlmProviderResource[]> {
    const rows = await this.tx((tx) =>
      tx
        .select()
        .from(llmProviders)
        .where(and(eq(llmProviders.siteId, this.siteId), isNull(llmProviders.deletedAt)))
        .orderBy(asc(llmProviders.name)),
    );
    return rows.map((r) => this.toResource(r));
  }

  async get(id: string): Promise<LlmProviderResource> {
    return this.toResource(await this.tx((tx) => this.row(tx, id)));
  }

  private async row(tx: SiteTransaction, id: string): Promise<ProviderRow> {
    const [row] = await tx
      .select()
      .from(llmProviders)
      .where(and(eq(llmProviders.siteId, this.siteId), eq(llmProviders.id, id), isNull(llmProviders.deletedAt)));
    if (!row) throw new LlmConfigError('NOT_FOUND', 'Model provider not found.', 404);
    return row;
  }

  async create(input: LlmProviderCreateInput): Promise<LlmProviderResource> {
    const id = nanoid();
    const secretCiphertext = input.apiKey ? (await withInstanceKey(() => sealSecret(this.deps.keys, input.apiKey!, secretAad(id)))).ciphertext : null;
    return this.tx(async (tx) => {
      // The same lock as a currency change: the currency read here stays true until commit.
      await lockSiteLedger(tx, this.siteId);
      const site = await this.settings(tx);
      if (input.currency !== site.currency) {
        throw new LlmConfigError('PRICE_CURRENCY_MISMATCH', `Prices must be in the site's currency (${site.currency}).`, 422);
      }
      try {
        const [row] = await tx
          .insert(llmProviders)
          .values({
            id,
            siteId: this.siteId,
            name: input.name,
            kind: input.kind,
            baseUrl: input.baseUrl,
            model: input.model,
            secretCiphertext,
            capabilities: input.capabilities,
            ...pricingColumns(input.pricing),
            currency: input.currency,
            ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
          })
          .returning();
        return this.toResource(row!);
      } catch (err) {
        throw uniqueName(err) ?? err;
      }
    });
  }

  async update(id: string, input: LlmProviderUpdateInput): Promise<LlmProviderResource> {
    const secret =
      input.apiKey === undefined
        ? undefined
        : input.apiKey === null
          ? null
          : (await withInstanceKey(() => sealSecret(this.deps.keys, input.apiKey!, secretAad(id)))).ciphertext;
    return this.tx(async (tx) => {
      await lockSiteLedger(tx, this.siteId);
      const current = await this.row(tx, id);
      if (input.currency !== undefined && input.currency !== (await this.settings(tx)).currency) {
        throw new LlmConfigError('PRICE_CURRENCY_MISMATCH', "Prices must be in the site's currency.", 422);
      }
      if (input.capabilities) {
        // Narrowing what it can do must not break a list that relies on it.
        const routes = await tx
          .select({ taskType: llmRoutes.taskType })
          .from(llmRoutes)
          .where(and(eq(llmRoutes.siteId, this.siteId), eq(llmRoutes.providerId, id)));
        for (const r of routes) {
          const missing = missingCapabilities(r.taskType as LlmTaskType, input.capabilities);
          if (missing.length) {
            throw new LlmConfigError(
              'CAPABILITY_UNSUPPORTED',
              `The ${r.taskType} list needs ${missing.join(' and ')}; remove the provider from it first.`,
              409,
            );
          }
        }
      }
      const next: Partial<ProviderRow> = { updatedAt: dbNow() };
      if (input.name !== undefined) next.name = input.name;
      if (input.baseUrl !== undefined) next.baseUrl = input.baseUrl;
      if (input.model !== undefined) next.model = input.model;
      if (input.capabilities !== undefined) next.capabilities = input.capabilities;
      if (input.pricing !== undefined) Object.assign(next, pricingColumns(input.pricing));
      if (input.currency !== undefined) next.currency = input.currency;
      if (input.timeoutMs !== undefined) next.timeoutMs = input.timeoutMs;
      if (input.disabled !== undefined) next.disabledAt = input.disabled ? (current.disabledAt ?? new Date()) : null;
      if (secret !== undefined) next.secretCiphertext = secret;
      // A new endpoint or model invalidates what a probe found.
      if (input.baseUrl !== undefined || input.model !== undefined || secret !== undefined) next.probe = null;
      try {
        const [row] = await tx
          .update(llmProviders)
          .set(next)
          .where(and(eq(llmProviders.siteId, this.siteId), eq(llmProviders.id, id)))
          .returning();
        return this.toResource(row!);
      } catch (err) {
        throw uniqueName(err) ?? err;
      }
    });
  }

  /** Soft delete: the ledger and the lists keep naming it; its key is dropped. */
  async remove(id: string): Promise<void> {
    await this.tx(async (tx) => {
      await this.row(tx, id);
      await tx
        .update(llmProviders)
        .set({ deletedAt: new Date(), secretCiphertext: null, updatedAt: dbNow() })
        .where(and(eq(llmProviders.siteId, this.siteId), eq(llmProviders.id, id)));
    });
  }

  /** The version of a provider's configuration a probe starts from (its last change, exactly). */
  async probeBasis(id: string): Promise<string> {
    return this.tx(async (tx) => {
      await this.row(tx, id);
      const [row] = await tx
        .select({ basis: sql<string>`${llmProviders.updatedAt}::text` })
        .from(llmProviders)
        .where(and(eq(llmProviders.siteId, this.siteId), eq(llmProviders.id, id)));
      return row!.basis;
    });
  }

  /**
   * Record what a probe found — only if the configuration did not change
   * meanwhile (a probe of the old endpoint, model or key says nothing about
   * the new one). Returns the provider and whether the result was kept.
   */
  async recordProbe(
    id: string,
    basis: string,
    verdicts: { tools: { ok: boolean; error?: string }; json: { ok: boolean; error?: string } },
  ): Promise<{ provider: LlmProviderResource; recorded: boolean }> {
    return this.tx(async (tx) => {
      const done = await tx
        .update(llmProviders)
        .set({ probe: { at: new Date().toISOString(), tools: verdicts.tools, json: verdicts.json } })
        .where(and(eq(llmProviders.siteId, this.siteId), eq(llmProviders.id, id), isNull(llmProviders.deletedAt), sql`${llmProviders.updatedAt}::text = ${basis}`))
        .returning({ id: llmProviders.id });
      return { provider: this.toResource(await this.row(tx, id)), recorded: done.length > 0 };
    });
  }

  /** The decrypted key of a provider (for the gateway; never leaves the server). */
  async apiKeyOf(row: ProviderRow): Promise<string | null> {
    if (!row.secretCiphertext) return null;
    return withInstanceKey(() => openSecret(this.deps.keys, row.secretCiphertext!, secretAad(row.id)));
  }

  // ── routes ──────────────────────────────────────────────────────────

  /** Every task type's list, in order (deleted or disabled providers included, marked). */
  async routes(): Promise<Array<{ taskType: string; providers: Array<{ id: string; name: string; available: boolean }> }>> {
    const rows = await this.tx((tx) =>
      tx
        .select({
          taskType: llmRoutes.taskType,
          position: llmRoutes.position,
          id: llmProviders.id,
          name: llmProviders.name,
          disabledAt: llmProviders.disabledAt,
          deletedAt: llmProviders.deletedAt,
        })
        .from(llmRoutes)
        .innerJoin(llmProviders, and(eq(llmProviders.siteId, llmRoutes.siteId), eq(llmProviders.id, llmRoutes.providerId)))
        .where(eq(llmRoutes.siteId, this.siteId))
        .orderBy(asc(llmRoutes.taskType), asc(llmRoutes.position)),
    );
    const out = new Map<string, Array<{ id: string; name: string; available: boolean }>>();
    for (const r of rows) {
      const list = out.get(r.taskType) ?? [];
      list.push({ id: r.id, name: r.name, available: !r.disabledAt && !r.deletedAt });
      out.set(r.taskType, list);
    }
    return [...out].map(([taskType, providers]) => ({ taskType, providers }));
  }

  async setRoute(taskType: LlmTaskType, providerIds: string[]): Promise<void> {
    await this.tx(async (tx) => {
      await lockSiteLedger(tx, this.siteId);
      const site = await this.settings(tx);
      for (const id of providerIds) {
        const [row] = await tx.select().from(llmProviders).where(and(eq(llmProviders.siteId, this.siteId), eq(llmProviders.id, id)));
        if (!row || row.deletedAt) throw new LlmConfigError('NOT_FOUND', `Model provider ${id} not found.`, 404);
        if (row.disabledAt) throw new LlmConfigError('PROVIDER_DISABLED', `${row.name} is disabled.`, 409);
        if (row.currency !== site.currency) {
          throw new LlmConfigError('PRICE_CURRENCY_MISMATCH', `${row.name} is priced in ${row.currency}, the site in ${site.currency}.`, 409);
        }
        const missing = missingCapabilities(taskType, row.capabilities as LlmCapabilities);
        if (missing.length) {
          throw new LlmConfigError('CAPABILITY_UNSUPPORTED', `${row.name} does not declare ${missing.join(' and ')}, which ${taskType} needs.`, 409);
        }
      }
      await tx.delete(llmRoutes).where(and(eq(llmRoutes.siteId, this.siteId), eq(llmRoutes.taskType, taskType)));
      if (providerIds.length) {
        await tx.insert(llmRoutes).values(providerIds.map((providerId, position) => ({ siteId: this.siteId, taskType, position, providerId })));
      }
    });
  }

  private toResource(row: ProviderRow): LlmProviderResource {
    return {
      id: row.id,
      name: row.name,
      kind: 'openai_compatible',
      baseUrl: row.baseUrl,
      model: row.model,
      apiKey: row.secretCiphertext ? LLM_SECRET_MASK : null,
      capabilities: row.capabilities as LlmCapabilities,
      probe: (row.probe as LlmProviderResource['probe']) ?? null,
      pricing: pricingOf(row),
      currency: row.currency,
      timeoutMs: row.timeoutMs,
      disabled: row.disabledAt !== null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function uniqueName(err: unknown): LlmConfigError | null {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '23505') {
      return new LlmConfigError('NAME_TAKEN', 'A model provider with this name already exists on this site.', 409);
    }
  }
  return null;
}

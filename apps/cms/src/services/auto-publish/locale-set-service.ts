import { and, eq, isNull } from 'drizzle-orm';
import type { UsageOperation } from '@heopress/contracts/schemas';
import { agentFreezes, contentProvenance, ingestSources, type Database } from '@heopress/database';
import { AuditLogger } from '../../modules/audit/logger';
import { assertUsageAllowed } from '../ingest/usage';
import type { ItemService } from '../item-service';
import { QualityGate } from '../quality-gate/quality-gate';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { lockContentSettingsShared } from '../site-network/content-routes';
import { AutoPublishError, isAiDerived, type GateCheck } from './auto-publish';
import { localeSetOf, type LocaleSetMember } from './locale-set';

/**
 * A person's publish and unpublish of a required language set (HeoPress P09 task 3.7):
 *
 *   - `publishSet` / `unpublishSet`: every bound member of the group on this site, in one transaction; when one member
 *     cannot be published (a missing language, the gate, a Hold, a source's licence, the kill switch) none is.
 *   - `publishSingle` / `unpublishSingle`: the explicit exception, one member alone, with a reason (audited with the
 *     exception mark). It goes through the caller's own item service, so it needs publish permission on the item's
 *     site; it bypasses only the set — never the gate, a Hold, the licence or the kill switch.
 *
 * Members on other sites of the group are not part of the set and are never written here.
 */

type Tx = SiteTransaction;

export interface LocaleSetServiceDeps {
  db: Database;
  siteId: string;
  userId: string | null;
  /** The caller's item service on `tx`, built with `localeSetWrite: true` (the caller's permissions apply). */
  itemsOn: (tx: Tx) => ItemService;
  gate?: GateCheck;
}

const builtInGate: GateCheck = (tx, siteId, itemId) => new QualityGate({ db: tx as unknown as Database, siteId }).currentIn(tx, itemId);

export class LocaleSetService {
  constructor(private readonly deps: LocaleSetServiceDeps) {}

  private get siteId() {
    return this.deps.siteId;
  }

  /** What stands in the way of publishing a member (besides the Hold and permissions, which the item write checks). */
  private async blockers(tx: Tx, itemId: string): Promise<string[]> {
    const out: string[] = [];
    const [freeze] = await tx.select({ id: agentFreezes.id }).from(agentFreezes).where(and(eq(agentFreezes.siteId, this.siteId), eq(agentFreezes.scope, 'site'), isNull(agentFreezes.liftedAt))).limit(1);
    if (freeze) out.push('kill_switch');
    if (await isAiDerived(tx, this.siteId, itemId)) {
      const gate = await (this.deps.gate ?? builtInGate)(tx, this.siteId, itemId);
      if (!gate.publishable) out.push('gate_not_passed');
    }
    const sources = await tx
      .select({ operation: contentProvenance.operation, source: ingestSources })
      .from(contentProvenance)
      .innerJoin(ingestSources, and(eq(ingestSources.siteId, contentProvenance.siteId), eq(ingestSources.id, contentProvenance.sourceId)))
      .where(and(eq(contentProvenance.siteId, this.siteId), eq(contentProvenance.itemId, itemId)));
    for (const s of sources) {
      if (s.source.licenceStatus === 'unknown' || !assertUsageAllowed(s.source, s.operation as UsageOperation).allowed) {
        out.push('licence');
        break;
      }
    }
    return out;
  }

  private async audit(tx: Tx, event: string, metadata: Record<string, unknown>) {
    await new AuditLogger({ db: tx as unknown as Database, siteId: this.siteId }).writeInTransaction(tx, { siteId: this.siteId, event, metadata: { ...metadata, by: this.deps.userId } });
  }

  private async setOf(tx: Tx, itemId: string) {
    const set = await localeSetOf(tx, this.siteId, itemId);
    if (!set) throw new AutoPublishError('NOT_IN_SET', "This item is not in the site's required language set.", 409);
    return set;
  }

  private async publishMembers(tx: Tx, members: LocaleSetMember[]): Promise<void> {
    const problems: Array<{ itemId: string; locale: string; blockers: string[] }> = [];
    for (const m of members) {
      if (m.status === 'published') continue;
      const blockers = await this.blockers(tx, m.itemId);
      if (m.hold) blockers.push('hold');
      if (blockers.length) problems.push({ itemId: m.itemId, locale: m.locale, blockers });
    }
    if (problems.length) {
      throw Object.assign(new AutoPublishError('SET_NOT_PUBLISHABLE', `Waiting for ${problems.map((p) => `${p.locale} (${p.blockers.join(', ')})`).join('; ')}: no language is published.`, 409), { problems });
    }
    const writer = this.deps.itemsOn(tx);
    for (const m of members) if (m.status !== 'published') await writer.patch(m.collection, m.itemId, { status: 'published', expectedVersion: m.version });
  }

  /** Publish every required language of the item's group on this site together, or none. */
  async publishSet(itemId: string): Promise<{ published: string[] }> {
    return runSiteTransaction(this.deps.db, this.siteId, async (tx) => {
      await lockContentSettingsShared(tx, this.siteId);
      const set = await this.setOf(tx, itemId);
      if (set.missing.length) throw new AutoPublishError('SET_NOT_PUBLISHABLE', `Waiting for ${set.missing.join(', ')}: no language is published.`, 409);
      await this.publishMembers(tx, set.members);
      const published = set.members.filter((m) => m.status !== 'published').map((m) => m.itemId);
      await this.audit(tx, 'locale_set_published', { groupId: set.groupId, items: published });
      return { published };
    }, { retry: false });
  }

  /** Unpublish every published required language of the item's group on this site together. */
  async unpublishSet(itemId: string): Promise<{ unpublished: string[] }> {
    return runSiteTransaction(this.deps.db, this.siteId, async (tx) => {
      await lockContentSettingsShared(tx, this.siteId);
      const set = await this.setOf(tx, itemId);
      const writer = this.deps.itemsOn(tx);
      const live = set.members.filter((m) => m.status === 'published');
      for (const m of live) await writer.patch(m.collection, m.itemId, { status: 'draft', expectedVersion: m.version });
      await this.audit(tx, 'locale_set_unpublished', { groupId: set.groupId, items: live.map((m) => m.itemId) });
      return { unpublished: live.map((m) => m.itemId) };
    }, { retry: false });
  }

  /** The exception: one language alone, with a reason. */
  async single(itemId: string, action: 'publish' | 'unpublish', reason: string): Promise<{ itemId: string }> {
    if (!this.deps.userId) throw new AutoPublishError('FORBIDDEN', 'Only a signed-in person can make a single-language exception.', 403);
    if (!reason?.trim()) throw new AutoPublishError('VALIDATION', 'A single-language exception needs a reason.', 422);
    return runSiteTransaction(this.deps.db, this.siteId, async (tx) => {
      await lockContentSettingsShared(tx, this.siteId);
      const set = await this.setOf(tx, itemId);
      const m = set.members.find((x) => x.itemId === itemId);
      if (!m) throw new AutoPublishError('NOT_IN_SET', 'This item is not the bound member of its language.', 409);
      if (action === 'publish') await this.publishMembers(tx, [m]);
      else if (m.status === 'published') await this.deps.itemsOn(tx).patch(m.collection, m.itemId, { status: 'draft', expectedVersion: m.version });
      await this.audit(tx, `locale_set_single_${action}`, { groupId: set.groupId, itemId, locale: m.locale, exception: true, reason: reason.trim() });
      return { itemId };
    }, { retry: false });
  }
}

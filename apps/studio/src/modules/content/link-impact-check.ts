import type { SiteLinkImpactResource } from '@heopress/sdk';

/**
 * What to do before a change that may break links to a published page (HeoPress P07 task 5.5): go on (nothing links to it,
 * or it is not public — the server says `NOT_PUBLIC`), or ask — with the pages that may be affected, or with `null` when
 * they could not be checked (Codex review of task 5.5: a failure, any other 404 included, is not "no impact").
 */
export type ImpactDecision = { kind: 'proceed' } | { kind: 'ask'; impact: SiteLinkImpactResource | null };

export async function checkImpact(load: () => Promise<SiteLinkImpactResource>): Promise<ImpactDecision> {
  try {
    const impact = await load();
    return impact.links.length === 0 ? { kind: 'proceed' } : { kind: 'ask', impact };
  } catch (err) {
    const code = (err as { status?: number; body?: { errors?: Array<{ code?: string }> } }).body?.errors?.[0]?.code;
    if ((err as { status?: number }).status === 404 && code === 'NOT_PUBLIC') return { kind: 'proceed' };
    return { kind: 'ask', impact: null };
  }
}

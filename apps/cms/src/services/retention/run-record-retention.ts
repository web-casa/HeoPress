import { asc, sql } from 'drizzle-orm';
import { llmCalls, sites, type Database } from '@heopress/database';
import { runSiteTransaction } from '../rls-transaction';
import { DAY_MS } from './policy';

/**
 * AI run record bodies past their retention period (HeoPress P13 task 5.1; spec ops/data-retention "运行记录过期").
 *
 * Every model call goes through the gateway's ledger (`lumibase_llm_calls`); a completed call keeps the winning
 * response — the full output — in `result`. Prompts are not stored (only their digest). Past the period the output is
 * replaced by a marker that keeps what the run record needs: provider, model and token usage. Cost stays on the
 * attempts (`lumibase_llm_attempts`), the gate's conclusion on the gate result and the production's run steps
 * (`lumibase_ai_production_steps`: step, model, prompt and policy versions, tokens, cost, outcome) — none of which hold
 * the body. A call still `open` is never touched; a replay of a redacted call is refused (`CALL_RESULT_EXPIRED`).
 */

const BATCH = 500;

export async function redactExpiredRunRecords(deps: { db: Database; aiRunBodyDays: number; now?: () => Date }): Promise<{ redacted: number; failedSites: number }> {
  const now = deps.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - deps.aiRunBodyDays * DAY_MS).toISOString();
  let redacted = 0;
  let failedSites = 0;
  const all = await deps.db.select({ id: sites.id }).from(sites).orderBy(asc(sites.id));
  for (const { id: siteId } of all) {
    try {
      for (;;) {
        const n = await runSiteTransaction(deps.db, siteId, async (tx) => {
          const rows = (await tx.execute(sql`
            WITH due AS (
              SELECT c.id FROM ${llmCalls} c
              WHERE c.site_id = ${siteId} AND c.status = 'completed' AND c.created_at < ${cutoff}::timestamptz
                AND NOT (c.result ? 'redacted')
              ORDER BY c.created_at
              LIMIT ${BATCH}
            )
            UPDATE ${llmCalls} c
            SET result = jsonb_strip_nulls(jsonb_build_object(
                  'redacted', true,
                  'redactedAt', ${now.toISOString()}::text,
                  'provider', c.result -> 'provider',
                  'model', c.result -> 'model',
                  'usage', c.result -> 'response' -> 'usage'))
            FROM due WHERE c.id = due.id AND c.site_id = ${siteId}
            RETURNING 1`)) as unknown as unknown[];
          return rows.length;
        });
        redacted += n;
        if (n < BATCH) break;
      }
    } catch (err) {
      failedSites += 1;
      console.error('[data-retention] run records of a site failed', { siteId, error: err instanceof Error ? err.name : 'error' });
    }
  }
  return { redacted, failedSites };
}

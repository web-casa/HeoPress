import type { Database } from '@heopress/database';
import { aiConversations, aiMessages, flowRuns } from '@heopress/database';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AiChatRunJob } from './flow-run-service';

const MAX_CONTEXT_MESSAGES = 20;

type HistoryMessage = { role: string; content: string };

/** The message ids a run's first delivery stored (ids, not content: the run is readable by flow admins). */
function snapshotOf(input: unknown): string[] | null {
  const ids = (input as { historyIds?: unknown } | null)?.historyIds;
  return Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? (ids as string[]) : null;
}

/**
 * The model input of a chat run, frozen by its first delivery (HeoPress P04 7.4): the
 * run's call key replays the paid answer only for the same request, so a redelivery
 * reuses the stored message set instead of reading a conversation that moved on (later
 * turns, this run's own reply, a message committed late). The first read takes the
 * latest messages created up to the run (compared in SQL, at full precision); only the
 * job's own site's conversation is read.
 */
export async function chatRunHistory(db: Database, job: Pick<AiChatRunJob, 'runId' | 'siteId' | 'conversationId'>): Promise<HistoryMessage[]> {
  const ofRun = and(eq(flowRuns.id, job.runId), eq(flowRuns.siteId, job.siteId));
  const messages = (where: SQL) =>
    db
      .select({ id: aiMessages.id, role: aiMessages.role, content: aiMessages.content })
      .from(aiMessages)
      .innerJoin(aiConversations, and(eq(aiConversations.id, aiMessages.conversationId), eq(aiConversations.siteId, job.siteId)))
      .where(and(eq(aiMessages.conversationId, job.conversationId), where));
  const inOrder = async (ids: string[]) => {
    if (ids.length === 0) return [];
    const byId = new Map((await messages(inArray(aiMessages.id, ids))).map((m) => [m.id, m]));
    // A deleted conversation (or message) ends the run: a partial history is another request.
    if (ids.some((id) => !byId.has(id))) throw new Error(`AI chat run ${job.runId}: its conversation history was deleted`);
    return ids.map((id) => ({ role: byId.get(id)!.role, content: byId.get(id)!.content }));
  };

  const [run] = await db.select({ input: flowRuns.input }).from(flowRuns).where(ofRun);
  if (!run) throw new Error(`AI chat run ${job.runId} not found`);
  const frozen = snapshotOf(run.input);
  if (frozen) return inOrder(frozen);

  const latest = await messages(sql`${aiMessages.createdAt} <= (SELECT ${flowRuns.createdAt} FROM ${flowRuns} WHERE ${ofRun})`)
    .orderBy(desc(aiMessages.createdAt), desc(aiMessages.id))
    .limit(MAX_CONTEXT_MESSAGES);
  const ids = latest.reverse().map((m) => m.id);

  // Only the first delivery stores its set; a concurrent one adopts it.
  await db
    .update(flowRuns)
    .set({ input: sql`${flowRuns.input} || jsonb_build_object('historyIds', ${JSON.stringify(ids)}::jsonb)` })
    .where(and(ofRun, sql`NOT (${flowRuns.input} ? 'historyIds')`));
  const [stored] = await db.select({ input: flowRuns.input }).from(flowRuns).where(ofRun);
  return inOrder(snapshotOf(stored?.input) ?? ids);
}

import { systemEvents, type Database } from '@heopress/database';
import type { ScheduledJobReport, ScheduledJobResult } from '@heopress/runtime/node';

/**
 * Instance events (HeoPress P07a tasks 11.1, 11.2, 11.4; spec ops/event-log): what belongs to no site — scheduled-job
 * runs, accounts enabled or disabled. Written by the application role (insert only); read back only by the bootstrap
 * administrator's event stream, under `app.platform_reader`.
 */
type SystemEventLevel = 'info' | 'warn' | 'error';

export interface SystemEventInput {
  level: SystemEventLevel;
  source: 'scheduler' | 'accounts' | 'agents' | 'events';
  event: string;
  message: string;
  actor?: string | null;
  data?: Record<string, unknown>;
}

export async function recordSystemEvent(db: Pick<Database, 'insert'>, input: SystemEventInput): Promise<void> {
  await db.insert(systemEvents).values({ level: input.level, source: input.source, event: input.event, message: input.message, actor: input.actor ?? null, data: input.data ?? {} });
}

const LEVEL: Record<ScheduledJobResult['status'], SystemEventLevel> = { succeeded: 'info', incomplete: 'warn', skipped: 'warn', failed: 'error' };

/** The scheduler's report: one system event per run this worker executed or skipped. */
export function scheduledJobReporter(db: Database): ScheduledJobReport {
  return async (key, result) => {
    await recordSystemEvent(db, {
      level: LEVEL[result.status],
      source: 'scheduler',
      event: `scheduled_job_${result.status}`,
      message: result.reason ? `${key}: ${result.status} — ${result.reason}` : `${key}: ${result.status}`,
      data: {
        job: key,
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.sites ? { sites: result.sites } : {}),
        startedAt: result.startedAt.toISOString(),
        durationMs: result.finishedAt.getTime() - result.startedAt.getTime(),
      },
    });
  };
}

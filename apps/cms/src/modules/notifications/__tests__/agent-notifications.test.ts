// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, expect, it, vi } from 'vitest';
import { emitAgentNotification, type EmitNotificationDeps } from '../agent-notifications';

/**
 * Broadcaster unit tests. P02 removed both upstream transports (SiteRoom DO and
 * Web Push); until P10 adds a Node in-app channel, emitting must stay a no-op
 * that never touches the database or throws.
 */

function fakeDb(rows: unknown[] = []) {
  // Minimal chainable stub matching the `select().from().where()` shape used by
  // the broadcaster's subscription lookup.
  const builder = {
    from: () => builder,
    where: () => Promise.resolve(rows),
  };
  return {
    select: vi.fn(() => builder),
    delete: vi.fn(() => ({ where: () => Promise.resolve() })),
  } as unknown as EmitNotificationDeps['db'];
}

describe('emitAgentNotification', () => {
  it('is a no-op that never touches the database (no transport until P10)', async () => {
    const db = fakeDb();
    await emitAgentNotification(
      { db, siteId: 'site_1' },
      { kind: 'approval', severity: 'info', title: 't', body: 'b', entityId: 'a1' },
    );
    expect((db as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });

});

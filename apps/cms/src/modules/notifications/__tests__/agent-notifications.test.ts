// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, expect, it, vi } from 'vitest';
import type { RealtimeProvider } from '@heopress/runtime';
import { emitAgentNotification, STUDIO_AGENT_CHANNEL, type EmitNotificationDeps } from '../agent-notifications';

/**
 * Broadcaster unit tests (HeoPress P10 task 5.6): one studio-plane frame addressed to the site's agent channel, and
 * never a rejection — a database or realtime failure is logged and swallowed. The channel queue and the two-site
 * delivery are covered by notification-channels.db.integration.test.ts.
 */

const brokenDb = { transaction: vi.fn(() => Promise.reject(new Error('db down'))) } as unknown as EmitNotificationDeps['db'];

describe('emitAgentNotification', () => {
  it('publishes one agent frame to the site channel', async () => {
    const publish = vi.fn(async () => {});
    const realtime: RealtimeProvider = { publish, isAvailable: () => true };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await emitAgentNotification(
      { db: brokenDb, siteId: 'site_1', realtime },
      { kind: 'approval', severity: 'info', title: 't', body: 'b', entityId: 'a1' },
    );
    warn.mockRestore();
    expect(publish).toHaveBeenCalledTimes(1);
    const [siteId, event] = publish.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(siteId).toBe('site_1');
    expect(event).toMatchObject({
      type: 'notification',
      plane: 'studio',
      target: { channel: STUDIO_AGENT_CHANNEL },
      payload: { source: 'agent', notification: { kind: 'approval', title: 't', entityId: 'a1' } },
    });
  });

  it('never rejects when realtime and the database fail', async () => {
    const realtime: RealtimeProvider = { publish: () => Promise.reject(new Error('hub down')), isAvailable: () => true };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      emitAgentNotification({ db: brokenDb, siteId: 'site_1', realtime }, { kind: 'incident', severity: 'critical', title: 't', body: 'b', entityId: 'i1' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a test notification goes to Studio only, never to IM channels', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transaction = vi.fn();
    await emitAgentNotification({ db: { transaction } as unknown as EmitNotificationDeps['db'], siteId: 'site_1' }, { kind: 'test', severity: 'info', title: 't', body: 'b', entityId: 'x' });
    expect(transaction).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, it, expect, vi } from 'vitest';
import {
  DockerRealtimeProvider,
  InProcessRealtimeHub,
} from '../adapters/docker/realtime';
import type { RealtimeEventLike } from '../interfaces/realtime';

const studioEvent: RealtimeEventLike = {
  type: 'event',
  plane: 'studio',
  collection: 'posts',
  action: 'update',
  itemId: '1',
  payload: {},
};

const audienceEvent: RealtimeEventLike = {
  type: 'notification',
  plane: 'public',
  target: { subjectId: 'citizen-42' },
  payload: { subject: 'hi' },
};

describe('Docker in-process hub', () => {
  it('delivers published events to subscribers of the same site only', async () => {
    const hub = new InProcessRealtimeHub();
    const provider = new DockerRealtimeProvider(hub);
    const site1 = vi.fn();
    const site2 = vi.fn();
    hub.subscribe('site-1', site1);
    hub.subscribe('site-2', site2);

    await provider.publish('site-1', studioEvent);
    expect(site1).toHaveBeenCalledWith(studioEvent);
    expect(site2).not.toHaveBeenCalled();
  });

  it('unsubscribe stops delivery', async () => {
    const hub = new InProcessRealtimeHub();
    const provider = new DockerRealtimeProvider(hub);
    const handler = vi.fn();
    const off = hub.subscribe('site-1', handler);
    off();
    await provider.publish('site-1', studioEvent);
    expect(handler).not.toHaveBeenCalled();
  });

  it('is always available', () => {
    expect(new DockerRealtimeProvider(new InProcessRealtimeHub()).isAvailable()).toBe(true);
  });
});

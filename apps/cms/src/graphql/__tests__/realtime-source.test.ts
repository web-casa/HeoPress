import { describe, expect, it } from 'vitest';
import { createSiteEventSource } from '../realtime-source';

/**
 * The upstream source bridged the Cloudflare SiteRoom Durable Object, removed
 * in HeoPress P02. On Node a subscription completes without events until the
 * realtime hub is bridged.
 */
describe('createSiteEventSource (Node)', () => {
  it('completes immediately without events', async () => {
    const events: unknown[] = [];
    for await (const event of createSiteEventSource('site-1', 'user-1', 'posts')) events.push(event);
    expect(events).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { parseRealtimeFrame } from '../realtime-frames';

const note = { id: 'n1', kind: 'veto', severity: 'warning', title: 'Veto window open', body: '', deepLink: '/mission-control/inbox?entry=veto:v1', entityId: 'v1', ts: '2026-10-27T08:00:00.000Z' };

describe('parseRealtimeFrame (P10 task 5.6)', () => {
  it('reads the unified agent frame and the older shape', () => {
    expect(parseRealtimeFrame(JSON.stringify({ type: 'notification', payload: { source: 'agent', notification: note } }))).toEqual({ kind: 'agent', notification: note });
    expect(parseRealtimeFrame(JSON.stringify({ type: 'notification', notification: note }))).toEqual({ kind: 'agent', notification: note });
  });
  it('reads item events and pings', () => {
    expect(parseRealtimeFrame(JSON.stringify({ type: 'event', collection: 'articles', action: 'update', itemId: 'i1' }))?.kind).toBe('item');
    expect(parseRealtimeFrame('{"type":"ping"}')).toEqual({ kind: 'ping' });
  });
  it('ignores malformed frames and non-relative links', () => {
    expect(parseRealtimeFrame('not json')).toBeNull();
    expect(parseRealtimeFrame(JSON.stringify({ type: 'notification', payload: { source: 'inbox', id: 'x' } }))).toBeNull();
    expect(parseRealtimeFrame(JSON.stringify({ type: 'notification', payload: { source: 'agent', notification: { ...note, kind: 'nope' } } }))).toBeNull();
    const off = parseRealtimeFrame(JSON.stringify({ type: 'notification', payload: { source: 'agent', notification: { ...note, deepLink: '//evil.example.com/x' } } }));
    expect(off).toEqual({ kind: 'agent', notification: { ...note, deepLink: undefined } });
  });
});

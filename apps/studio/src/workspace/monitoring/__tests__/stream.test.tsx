// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const events = vi.fn();
vi.mock('../../api', () => ({ studioApi: { events: (q: string) => events(q) } }));

const { useEventStream } = await import('../stream');

const filter = { levels: [], sources: [], q: '' };

describe('event stream: a failed first load (p07a task 11.7)', () => {
  it('is a failure, not an empty stream, and a retry loads the events', async () => {
    events.mockRejectedValueOnce(new Error('http 429'));
    const { result } = renderHook(() => useEventStream(filter, 60_000));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failed).toBe(true);
    expect(result.current.events).toEqual([]);

    events.mockResolvedValueOnce({ data: [{ id: 'e1', at: '2026-10-24T10:00:00Z', source: 'run', level: 'info', event: 'site_job_run', message: '', data: {} }], meta: {} });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.events.map((e) => e.id)).toEqual(['e1']));
    expect(result.current.failed).toBe(false);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/** The AI traffic page (HeoPress P07 task 6.2): totals, the day chart, by crawler, the most read and the landing pages. */
const site = { aiTraffic: vi.fn() };
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ site }) }));

import { AiTrafficPage } from '../ai-traffic-page';

const data = {
  from: '2026-09-23',
  to: '2026-10-22',
  totals: { crawler: 5, referral: 2 },
  byDay: [{ day: '2026-10-22', training: 3, search: 1, userFetch: 1, referral: 2 }],
  byAgent: [
    { kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'training', hits: 3 },
    { kind: 'referral', agent: 'chatgpt', operator: 'OpenAI', purpose: null, hits: 2 },
  ],
  topCrawled: [{ path: '/llms.txt', resource: 'llms', hits: 3 }],
  topLanding: [{ path: '/guide/', hits: 2, sources: ['chatgpt'] }],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AiTrafficPage', () => {
  it('shows the figures; the period asks again', async () => {
    site.aiTraffic.mockResolvedValue({ data });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AiTrafficPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('/llms.txt')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'AI reads and referred visits per day' })).toBeTruthy();
    expect(screen.getByText('gptbot')).toBeTruthy();
    expect(screen.getByText('Referred visits')).toBeTruthy();
    expect(screen.getByText('/guide/')).toBeTruthy();
    expect(screen.getByText('chatgpt · 2')).toBeTruthy();
    expect(site.aiTraffic).toHaveBeenCalledWith(30);
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '7' } });
    await vi.waitFor(() => expect(site.aiTraffic).toHaveBeenLastCalledWith(7));
  });
});

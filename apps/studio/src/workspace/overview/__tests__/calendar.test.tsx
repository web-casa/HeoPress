// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/** The overview's week (HeoPress P07a task 4.4; spec studio/overview "定时发布"). */

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname: '/overview' } }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: vi.fn() }), getActiveToken: () => '' }));

const { WeekCalendar } = await import('../overview-page');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

describe('week calendar', () => {
  it('an article scheduled for Saturday 18:00 is on Saturday, marked scheduled, its full title and time on hover', () => {
    const days = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 19 + i));
    const at = new Date(2026, 9, 24, 18, 0).toISOString();
    render(<WeekCalendar days={days} loading={false} items={[{ itemId: 'i1', collection: 'articles', title: 'A long title for the weekend piece', kind: 'scheduled', at }]} />);
    const link = screen.getByRole('link', { name: /A long title for the weekend piece/ });
    expect(link.textContent).toContain(`${i18n.t('overview:week.scheduled')}: `);
    const title = link.getAttribute('title')!;
    expect(title.startsWith('A long title for the weekend piece · ')).toBe(true);
    expect(title).toMatch(/6:00|18:00/);
    // In Saturday's column.
    const saturday = link.closest('div.min-h-24')!;
    expect(saturday.firstElementChild?.textContent).toMatch(/Sat/);
  });
});

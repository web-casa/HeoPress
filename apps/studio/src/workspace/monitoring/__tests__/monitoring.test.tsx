// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import type { StreamEvent } from '../../api';
import { mergeEvents, queryOf } from '../stream';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname: '/monitoring', search: {} } }),
}));

const { cardState, CARD_FILTERS, EarliestBySource, EventDetail, StatusCards } = await import('../monitoring-page');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

const ev = (id: string, at: string, extra: Partial<StreamEvent> = {}): StreamEvent => ({ id, at, source: 'run', level: 'info', event: 'site_job_run', message: 'site-audit: succeeded', data: {}, ...extra });

describe('stream merging (p07a task 11.7)', () => {
  it('drops what it already has and keeps newest first', () => {
    const merged = mergeEvents([ev('a', '2026-10-24T10:00:00Z')], [ev('a', '2026-10-24T10:00:00Z'), ev('b', '2026-10-24T10:01:00Z'), ev('c', '2026-10-24T09:59:00Z')]);
    expect(merged.map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });

  it('builds the query from levels, sources and words', () => {
    expect(queryOf({ levels: ['warn', 'error'], sources: ['run'], q: ' site-audit|link-scan ' }, { limit: '50' })).toBe('?level=warn%2Cerror&source=run&q=site-audit%7Clink-scan&limit=50');
  });
});

describe('status cards (p07a task 11.7)', () => {
  it('nothing readable is unknown, never OK', () => {
    expect(cardState(null)).toBe('unknown');
    expect(cardState('unknown')).toBe('unknown');
    expect(cardState('done')).toBe('ok');
    expect(cardState('truncated')).toBe('warn');
    expect(cardState('failed')).toBe('bad');
  });

  it('a site administrator sees the site group only; a card toggles its source filter', () => {
    const onToggle = vi.fn();
    render(
      <StatusCards
        loading={false}
        active={null}
        onToggle={onToggle}
        status={{ site: { reachability: { status: 'unknown', checkedAt: null }, audit: { status: 'failed', checkedAt: '2026-10-24T10:00:00Z' }, linkScan: { status: 'done', checkedAt: '2026-10-24T10:00:00Z' } } }}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Instance' })).toBeNull();
    const audit = screen.getByRole('button', { name: /Site audit and link scan/ });
    expect(audit.textContent).toContain('Failing');
    expect(screen.getByRole('button', { name: /Reachability/ }).textContent).toContain('Unknown');
    fireEvent.click(audit);
    expect(onToggle).toHaveBeenCalledWith('audit');
    expect(CARD_FILTERS.audit).toEqual({ sources: ['run'], q: 'site-audit|link-scan' });
  });

  it('a health check that timed out shows unknown with the check time', () => {
    render(
      <StatusCards
        loading={false}
        active={null}
        onToggle={() => undefined}
        status={{
          site: { reachability: { status: 'unknown', checkedAt: null }, audit: { status: 'unknown', checkedAt: null }, linkScan: { status: 'unknown', checkedAt: null } },
          instance: { checkedAt: '2026-10-24T10:00:00Z', services: { database: 'unknown', queue: 'healthy' }, failedJobs24h: null },
        }}
      />,
    );
    const db = screen.getByRole('button', { name: /Database/ });
    expect(db.textContent).toContain('Unknown');
    expect(db.textContent).toContain('Checked');
    expect(screen.getByRole('button', { name: /Queue/ }).textContent).toContain('OK');
  });
});

describe('event detail', () => {
  it('shows every field to copy and the related action', () => {
    render(<EventDetail adminBase="" event={ev('x', '2026-10-24T10:00:00Z', { subject: { type: 'item', id: 'i1', collection: 'articles' } })} />);
    expect(screen.getByText(/"id": "x"/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the item' })).toHaveAttribute('href', '/content/articles/i1');
    expect(screen.getByRole('link', { name: 'Open the audit' })).toHaveAttribute('href', '/audit');
  });
});

describe('retention (spec ops/event-log "超出保留期")', () => {
  it('names where each source\'s record begins, oldest first', () => {
    render(<EarliestBySource bySource={{ content: '2026-10-04T00:00:00Z', run: '2026-09-04T00:00:00Z' }} />);
    const items = screen.getByRole('list', { name: 'Events kept, by source, from' }).querySelectorAll('li');
    expect([...items].map((li) => li.textContent?.split(':')[0])).toEqual(['Runs', 'Content']);
  });
});

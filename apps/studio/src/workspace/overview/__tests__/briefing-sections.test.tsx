// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import type { BriefingSection, SiteSummary } from '../../api';
import type { Scope } from '../model';

/**
 * The briefing's plugin sections (v1.1; spec studio/briefing "插件分节"): the sections the plugins of the current site
 * contribute, rendered as their own group below the three core cards — with their titles, counts, plugin names and
 * site-relative links — and the three ways of having nothing: no section at all, a section whose count is zero, and a
 * section the host left out (simply absent from the answer, with no placeholder here).
 */

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname: '/overview' } }),
}));
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: vi.fn() }), getActiveToken: () => '' }));

const { Briefing } = await import('../briefing');
type BriefingModel = import('../model').Briefing;

const emptyModel = (): BriefingModel => ({
  attention: [],
  recent: { days: 7, published: { count: 0, examples: [] }, updated: { count: 0, examples: [] } },
  health: { status: 'ok', sites: 1, failing: 0, attention: 0, unreadable: 0, signals: [] },
  reviewsUnreadable: 0,
  currentSiteOnly: false,
});

/** One plugin contributing more things than it may link: ten links, a count of twelve. */
const staleSection: BriefingSection = {
  plugin: 'stale-drafts',
  pluginName: 'Stale drafts helper',
  id: 'stale-drafts',
  title: 'Stale drafts',
  description: 'Drafts untouched for two weeks',
  count: 12,
  items: Array.from({ length: 10 }, (_, i) => ({ label: `Stale draft ${i + 1}`, href: `/content/articles/stale-${i + 1}` })),
};

/** A second plugin, with a single item: the singular count and a link of its own. */
const reviewSection: BriefingSection = {
  plugin: 'review-queue',
  pluginName: 'Review queue',
  id: 'waiting',
  title: 'Waiting for review',
  description: null,
  count: 1,
  items: [{ label: 'A story waiting', href: '/content/articles/waiting-1' }],
};

function renderBriefing({ model = emptyModel(), sections = [staleSection, reviewSection] as BriefingSection[], scope = { kind: 'current' } as Scope } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Briefing model={model} scope={scope} sites={[] as SiteSummary[]} loading={false} nextAudit={null} sections={sections} onGo={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

afterEach(() => cleanup());

describe('briefing plugin sections', () => {
  it('renders the plugin sections with their titles, counts, plugin names and links', () => {
    renderBriefing();

    // The group says where its contents come from, and each section names the plugin that contributed it.
    expect(screen.getByRole('heading', { name: 'From extensions' })).toBeTruthy();
    expect(screen.getByText('Sections the plugins enabled on this site contribute.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Stale drafts' })).toBeTruthy();
    expect(screen.getByText('From Stale drafts helper')).toBeTruthy();
    expect(screen.getByText('Drafts untouched for two weeks')).toBeTruthy();
    expect(screen.getByText('12 items')).toBeTruthy();

    // The second section's singular count.
    expect(screen.getByRole('heading', { name: 'Waiting for review' })).toBeTruthy();
    expect(screen.getByText('1 item')).toBeTruthy();

    // Every link is the plugin's site-relative href, navigated client-side (the router's Link, never a reload).
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(11);
    expect(screen.getByRole('link', { name: 'Stale draft 1' }).getAttribute('href')).toBe('/content/articles/stale-1');
    expect(screen.getByRole('link', { name: 'Stale draft 10' }).getAttribute('href')).toBe('/content/articles/stale-10');
    expect(screen.getByRole('link', { name: 'A story waiting' }).getAttribute('href')).toBe('/content/articles/waiting-1');

    // Ten links for twelve things is said out loud rather than hidden.
    expect(screen.getByText('Showing the first 10 of 12')).toBeTruthy();
  });

  it('renders no group at all when no plugin contributes a section', () => {
    renderBriefing({ sections: [] });
    expect(screen.queryByRole('heading', { name: 'From extensions' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'From extensions' })).toBeNull();
    expect(screen.queryByText(/From extensions/)).toBeNull();
    // The three core sections are still there: an empty plugin list changes nothing else.
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeTruthy();
  });

  it('keeps a section whose count is zero, without a link list', () => {
    renderBriefing({
      sections: [{ plugin: 'stale-drafts', pluginName: 'Stale drafts helper', id: 'stale-drafts', title: 'Nothing stale', description: null, count: 0, items: [] }],
    });
    expect(screen.getByRole('heading', { name: 'Nothing stale' })).toBeTruthy();
    expect(screen.getByText('0 items')).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  it('shows no plugin section in another scope', () => {
    renderBriefing({ scope: { kind: 'all' } });
    expect(screen.queryByRole('heading', { name: 'From extensions' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Stale drafts' })).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HeoPressError, type SiteLinkImpactResource } from '@heopress/sdk';

/** The change-impact dialog (HeoPress P07 task 5.5): the linking pages, a redirect, updated links, then go on or not. */
const site = { impactRedirect: vi.fn(), updateImpactLinks: vi.fn() };
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ site }) }));

import { LinkImpactDialog } from '../link-impact-dialog';

const impact: SiteLinkImpactResource = {
  target: { itemId: 'b', collection: 'articles', locale: 'en', path: '/b', url: 'https://example.com/b/' },
  links: [
    { depth: 1, source: { kind: 'item', itemId: 'a', collection: 'articles', title: 'Page A', url: null }, field: 'body', position: 0, href: '/b/', anchorText: 'see B' },
    { depth: 1, source: { kind: 'navigation', linkId: 'n', label: 'Footer' }, field: null, position: 0, href: 'https://example.com/b/', anchorText: '' },
    { depth: 2, source: { kind: 'item', itemId: 'd', collection: 'articles', title: 'Page D', url: null }, field: 'body', position: 0, href: '/a/', anchorText: '', via: 'a' },
  ],
  pages: 3,
  truncated: false,
  limits: { depth: 2, limit: 100 },
};

function renderDialog(props: Partial<Parameters<typeof LinkImpactDialog>[0]> = {}) {
  const onProceed = vi.fn();
  const onCancel = vi.fn();
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <LinkImpactDialog itemId="b" change="delete" impact={impact} canRedirect onProceed={onProceed} onCancel={onCancel} {...props} />
    </QueryClientProvider>,
  );
  return { onProceed, onCancel };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LinkImpactDialog', () => {
  it('lists the pages that may be affected; updates the direct ones\' links to another address; then deletes', async () => {
    site.updateImpactLinks.mockResolvedValue({ data: { updated: [{ itemId: 'a', links: 1 }], skipped: [] } });
    const { onProceed } = renderDialog();
    expect(screen.getByRole('dialog', { name: 'Pages that may be affected' })).toBeTruthy();
    expect(screen.getByText('Page A')).toBeTruthy();
    expect(screen.getByText('Navigation: Footer')).toBeTruthy();
    expect(screen.getByText(/links to a linking page/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Another page's address"), { target: { value: 'https://example.com/c/' } });
    fireEvent.click(screen.getByText('Update links'));
    await vi.waitFor(() => expect(site.updateImpactLinks).toHaveBeenCalledWith('b', 'https://example.com/c/', ['a']));
    expect(await screen.findByText('Links updated in 1 page(s).')).toBeTruthy();
    fireEvent.click(screen.getByText('Delete anyway'));
    expect(onProceed).toHaveBeenCalled();
  });

  it('a redirect: added, or refused with the reason; cancelling does nothing', async () => {
    site.impactRedirect.mockRejectedValueOnce(new HeoPressError(409, { errors: [{ code: 'REDIRECT_CONFLICT', message: 'This redirect would make the site\'s redirects loop.' }] }));
    site.impactRedirect.mockResolvedValueOnce({ data: { id: 'r', fromPath: '/b', toPath: '/c', toLocale: 'en' } });
    const { onProceed, onCancel } = renderDialog({ change: 'unpublish' });
    fireEvent.change(screen.getByLabelText("Another page's address"), { target: { value: 'https://example.com/c/' } });
    fireEvent.click(screen.getByText('Create redirect'));
    expect(await screen.findByText("This redirect would make the site's redirects loop.")).toBeTruthy();
    fireEvent.click(screen.getByText('Create redirect'));
    expect(await screen.findByText(/Redirect added: \/b → \/c/)).toBeTruthy();
    expect(screen.getByText('Save anyway')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
    expect(onProceed).not.toHaveBeenCalled();
  });

  it('Codex review of task 5.5: a move offers no redirect (the system adds one); others than administrators get none; a failed check is not "nothing links here"', () => {
    renderDialog({ change: 'move' });
    expect(screen.queryByText('Create redirect')).toBeNull();
    expect(screen.getByText(/A redirect from the old address to the new one is added when you save/)).toBeTruthy();
    cleanup();
    renderDialog({ canRedirect: false });
    expect(screen.queryByText('Create redirect')).toBeNull();
    expect(screen.getByText('Update links')).toBeTruthy();
    cleanup();
    const { onProceed } = renderDialog({ impact: null });
    expect(screen.getByRole('alert').textContent).toContain('could not be checked');
    expect(screen.queryByText('Update links')).toBeNull();
    fireEvent.click(screen.getByText('Delete anyway'));
    expect(onProceed).toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { EditorialProfileContent, EditorialProfileVersion } from '@heopress/sdk';

/**
 * Editorial profile page (HeoPress P05 task 2.3): a version saved is the one shown, at once — not only once the list has
 * been read again. Before, while that read was still on its way, the page fell back to the version in effect, so a
 * click on it did not load it: the form kept the text just saved (the Studio scenario failed on a slow runner).
 */

const editorialProfile = { versions: vi.fn(), create: vi.fn(), publish: vi.fn() };

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ editorialProfile }),
}));

import { EditorialProfilePage } from '../editorial-profile-page';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const content = (tone: string): EditorialProfileContent => ({
  audience: 'Operators',
  tone,
  glossary: [],
  citationPolicy: '',
  structureRules: [],
  qualityRules: [],
  publishRules: [],
  forbiddenTopics: [],
});
const version = (n: number, status: EditorialProfileVersion['status'], tone: string): EditorialProfileVersion => ({
  version: n,
  status,
  content: content(tone),
  createdBy: null,
  createdAt: '2026-10-29T00:00:00.000Z',
  publishedBy: null,
  publishedAt: null,
});

const tone = () => screen.getByLabelText(/^Tone/) as HTMLTextAreaElement;

describe('EditorialProfilePage', () => {
  it('a saved version is shown at once; clicking the version in effect then loads it, even before the list is read again', async () => {
    const v1 = version(1, 'published', 'Plain and direct');
    // The first read answers; the read after the save never does (a slow server).
    editorialProfile.versions.mockResolvedValueOnce({ data: [v1] }).mockReturnValue(new Promise(() => undefined));
    editorialProfile.create.mockImplementation(async (c: EditorialProfileContent) => ({ data: { ...version(2, 'draft', ''), content: c } }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    // What the form holds in the first committed frame that names the version in effect (a mutation observer runs right
    // after that commit, before any effect a later task would run). The form used to be filled by such an effect: that
    // frame had it empty, and the plain read below then failed whenever the effect had not run yet (a loaded CI runner).
    let firstFrame: string | undefined;
    const observer = new MutationObserver(() => {
      if (firstFrame === undefined && document.body.textContent?.includes('Version 1 is in effect.')) firstFrame = tone().value;
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    render(
      <QueryClientProvider client={client}>
        <EditorialProfilePage />
      </QueryClientProvider>,
    );

    await screen.findByText('Version 1 is in effect.', { exact: false });
    observer.disconnect();
    expect(firstFrame).toBe('Plain and direct');
    expect(tone().value).toBe('Plain and direct');
    fireEvent.change(tone(), { target: { value: 'Warm and practical' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await screen.findByText('Saved as version 2 (a draft).');
    expect(editorialProfile.create).toHaveBeenCalledWith(expect.objectContaining({ tone: 'Warm and practical' }));

    // Version 2 is listed and shown, though the list has not been read again.
    const v2Item = screen.getByRole('listitem', { name: 'Version 2' });
    expect(v2Item.className).toContain('border-brand');
    expect(screen.getByRole('listitem', { name: 'Version 1' }).className).not.toContain('border-brand');

    fireEvent.click(within(screen.getByRole('listitem', { name: 'Version 1' })).getByRole('button', { name: /Version 1/ }));
    expect(tone().value).toBe('Plain and direct');
    fireEvent.click(within(v2Item).getByRole('button', { name: /Version 2/ }));
    expect(tone().value).toBe('Warm and practical');
  });
});

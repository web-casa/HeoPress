// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GlossaryEntry } from '@heopress/sdk';

/**
 * Site glossary screen (HeoPress v1.4, spec `ai/site-glossary`): the operator lists a language pair's terms, adds and
 * edits one with an explicit rule and its help text, and deletes one. The rule is the whole point of the screen — the
 * payload a save sends is what the translation gates later enforce.
 */

const glossary = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ glossary }),
}));

import { GlossaryPage } from '../glossary-page';

const ENTRIES: GlossaryEntry[] = [
  {
    id: 'gl_1',
    siteId: 'site_1',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    term: 'HeoPress',
    translation: '禾普',
    rule: 'prefer',
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'gl_2',
    siteId: 'site_1',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    term: 'CMS',
    translation: 'CMS',
    rule: 'do-not-translate',
    note: 'keep',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GlossaryPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  glossary.list.mockResolvedValue({ data: ENTRIES, meta: { total: ENTRIES.length, limit: 50, offset: 0 } });
  glossary.create.mockResolvedValue({ data: ENTRIES[0] });
  glossary.update.mockResolvedValue({ data: ENTRIES[0] });
  glossary.delete.mockResolvedValue({ data: { id: 'gl_2' } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

describe('GlossaryPage', () => {
  it('lists a language pair and refetches when the pair filter changes', async () => {
    renderPage();
    expect(await screen.findByText('HeoPress')).toBeInTheDocument();
    expect(glossary.list).toHaveBeenCalledWith({ from: undefined, to: undefined, limit: 50, offset: 0 });

    fireEvent.change(screen.getByLabelText('Filter source language'), { target: { value: 'en' } });
    fireEvent.change(screen.getByLabelText('Filter target language'), { target: { value: 'zh-CN' } });
    await waitFor(() => {
      expect(glossary.list).toHaveBeenLastCalledWith({ from: 'en', to: 'zh-CN', limit: 50, offset: 0 });
    });
  });

  it('creates a term with the chosen rule and shows that rule’s help text', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add term' }));

    expect(await screen.findByText('When the term appears in the source, the translation must use this rendering.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Term in the source language'), { target: { value: 'Cloud' } });
    fireEvent.change(screen.getByLabelText('Required rendering in the target language'), { target: { value: '云端' } });
    fireEvent.change(screen.getByLabelText('Term rule'), { target: { value: 'forbidden' } });
    expect(screen.getByText('This wording must never appear in the target text, whatever the source says.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save term' }));
    await waitFor(() => {
      expect(glossary.create).toHaveBeenCalledWith({
        sourceLang: 'en',
        targetLang: 'zh-CN',
        term: 'Cloud',
        translation: '云端',
        rule: 'forbidden',
        note: null,
      });
    });
  });

  it('keeps the source spelling for a do-not-translate term', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add term' }));

    fireEvent.change(screen.getByLabelText('Term in the source language'), { target: { value: 'API' } });
    fireEvent.change(screen.getByLabelText('Term rule'), { target: { value: 'do-not-translate' } });
    expect(screen.getByLabelText('Required rendering in the target language')).toHaveValue('API');

    fireEvent.click(screen.getByRole('button', { name: 'Save term' }));
    await waitFor(() => {
      expect(glossary.create).toHaveBeenCalledWith(expect.objectContaining({ term: 'API', translation: 'API', rule: 'do-not-translate' }));
    });
  });

  it('edits an entry and deletes one', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit term HeoPress' }));

    const translation = screen.getByLabelText('Required rendering in the target language');
    expect(translation).toHaveValue('禾普');
    fireEvent.change(translation, { target: { value: '禾普科技' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save term' }));
    await waitFor(() => {
      expect(glossary.update).toHaveBeenCalledWith('gl_1', expect.objectContaining({ term: 'HeoPress', translation: '禾普科技', rule: 'prefer' }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete term CMS' }));
    await waitFor(() => {
      expect(glossary.delete).toHaveBeenCalledWith('gl_2');
    });
  });
});

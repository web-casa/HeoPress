// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HeoPressError } from '@heopress/sdk';

/** The root files page (HeoPress P07 task 3.8): the list, adding one, the refusal of a name the system makes. */
const site = { rootFiles: vi.fn(), rootFile: vi.fn(), putRootFile: vi.fn(), deleteRootFile: vi.fn() };
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ site }) }));

import { RootFilesPage } from '../root-files-page';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RootFilesPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RootFilesPage', () => {
  it('lists the files and saves a new one', async () => {
    site.rootFiles.mockResolvedValue({ data: [{ filename: 'ads.txt', contentType: 'text/plain; charset=utf-8', size: 12, sha256: 'x', updatedAt: '2026-10-22T00:00:00Z' }] });
    site.putRootFile.mockResolvedValue({ data: { filename: 'google1.html' } });
    renderPage();
    expect(await screen.findByText('/ads.txt')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'google1.html' } });
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'verify' } });
    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(site.putRootFile).toHaveBeenCalledWith('google1.html', 'verify'));
  });

  it('shows why a name is refused', async () => {
    site.rootFiles.mockResolvedValue({ data: [] });
    site.putRootFile.mockRejectedValue(new HeoPressError(409, { errors: [{ code: 'SYSTEM_FILE', message: 'robots.txt is made by the system; it cannot be replaced.' }] }));
    renderPage();
    expect(await screen.findByText('No root files yet.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'robots.txt' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('robots.txt is made by the system; it cannot be replaced.')).toBeTruthy();
  });
});

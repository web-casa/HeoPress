// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import type { PluginSecretResource } from '@heopress/sdk';

const listSecrets = vi.fn<(id: string) => Promise<{ data: PluginSecretResource[] }>>();
const setSecret = vi.fn<(id: string, name: string, value: string) => Promise<{ data: PluginSecretResource }>>();
const deleteSecret = vi.fn<(id: string, name: string) => Promise<{ data: null }>>();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ extensions: { listSecrets, setSecret, deleteSecret } }),
}));

import { PluginSecrets } from '../plugin-secrets';

const SECRET_VALUE = 'sk-test-DO-NOT-LEAK-123';
const PLUGIN = 'acme-deepl';

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const configured = (name: string): PluginSecretResource => ({ name, configured: true, declared: true });
const missing = (name: string): PluginSecretResource => ({ name, configured: false, declared: true });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

describe('plugin secrets panel (v1.2, spec extensions/plugin-secrets)', () => {
  it('lists declared names with their configured state and never a value', async () => {
    listSecrets.mockResolvedValue({ data: [missing('deepl_api_key')] });
    renderWithClient(<PluginSecrets pluginId={PLUGIN} declaredNames={['deepl_api_key']} />);

    expect(await screen.findByText('deepl_api_key')).toBeInTheDocument();
    expect(screen.getByTestId('secret-state-deepl_api_key')).toHaveTextContent('Not configured');
    expect(screen.queryByDisplayValue(SECRET_VALUE)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET_VALUE);
  });

  it('sets a value through the API, clears the field and shows the configured state', async () => {
    listSecrets
      .mockResolvedValueOnce({ data: [missing('deepl_api_key')] })
      .mockResolvedValue({ data: [configured('deepl_api_key')] });
    setSecret.mockResolvedValue({ data: configured('deepl_api_key') });
    renderWithClient(<PluginSecrets pluginId={PLUGIN} declaredNames={['deepl_api_key']} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Set' }));
    const input = screen.getByLabelText('Value for deepl_api_key');
    fireEvent.change(input, { target: { value: SECRET_VALUE } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setSecret).toHaveBeenCalledWith(PLUGIN, 'deepl_api_key', SECRET_VALUE));
    // The field is gone once the write succeeds, so the value cannot linger in the DOM.
    await waitFor(() => expect(screen.queryByLabelText('Value for deepl_api_key')).not.toBeInTheDocument());
    expect(await screen.findByTestId('secret-state-deepl_api_key')).toHaveTextContent('Configured');
    expect(document.body.textContent).not.toContain(SECRET_VALUE);
  });

  it('deletes a configured secret after confirmation', async () => {
    listSecrets
      .mockResolvedValueOnce({ data: [configured('deepl_api_key')] })
      .mockResolvedValue({ data: [missing('deepl_api_key')] });
    deleteSecret.mockResolvedValue({ data: null });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithClient(<PluginSecrets pluginId={PLUGIN} declaredNames={['deepl_api_key']} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete secret' }));

    await waitFor(() => expect(deleteSecret).toHaveBeenCalledWith(PLUGIN, 'deepl_api_key'));
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('secret-state-deepl_api_key')).toHaveTextContent('Not configured'));
  });
});

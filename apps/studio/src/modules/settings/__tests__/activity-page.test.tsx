// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

/**
 * Light render test for the tabbed Activity settings page (task 12.4).
 *
 * Confirms the tab switcher exposes both the "Activity" and "Security
 * audit" tabs and toggles the active panel. The bulk of the audit
 * coverage lives in `security-audit-tab.test.tsx`; here we only verify
 * the host page wires the two tabs together.
 *
 * `@/lib/api` is mocked so the page renders without a real API client,
 * the Studio's English strings are loaded, and `fetch` is stubbed for the
 * audit tab's query.
 *
 * **Validates: Requirements 15.4**
 */

// Mock the API client so the Activity tab's `client.activity.list` is a
// resolved no-op (this test isn't about the activity table's data).
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    activity: { list: vi.fn().mockResolvedValue({ data: [] }) },
  }),
}));


import { ActivityPage } from '../activity-page';

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ data: { items: [], nextCursor: null } }),
    } as unknown as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});


beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

describe('ActivityPage — tab switcher', () => {
  it('renders both tabs', () => {
    renderWithClient(<ActivityPage />);
    expect(screen.getByRole('tab', { name: /activity/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /security audit/i })).toBeInTheDocument();
  });

  it('defaults to the Activity tab selected', () => {
    renderWithClient(<ActivityPage />);
    expect(screen.getByRole('tab', { name: /activity/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /security audit/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('switches to the Security audit tab on click', () => {
    renderWithClient(<ActivityPage />);
    fireEvent.click(screen.getByRole('tab', { name: /security audit/i }));

    expect(screen.getByRole('tab', { name: /security audit/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The security tab's Search button only exists when its panel is active.
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument();
  });
});

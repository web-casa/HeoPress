// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

/**
 * Deployments settings page — render test plus route/nav wiring tripwires.
 *
 * The page shipped complete (backend at `/api/v1/deployments`, SDK surface,
 * docs) but was never reachable: no route in `router.tsx`, no entry in the
 * settings sidebar. It sat as dead code that every unit test and `tsc` run
 * happily ignored. The wiring blocks below are source-level on purpose —
 * booting the real router needs the whole app, while a source scan catches
 * the actual failure mode: a page component that nothing links to.
 *
 * The second tripwire generalises the class: EVERY `*-page.tsx` under
 * `modules/settings/` must be referenced by `router.tsx`, so the next
 * orphaned settings page fails CI instead of shipping invisible.
 */

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    deployments: {
      list: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'dep_1',
            targetId: 'tgt_1',
            status: 'ready',
            branch: 'main',
            commitSha: 'abc1234def',
            url: 'https://example.vercel.app',
          },
        ],
      }),
      targets: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'tgt_1',
              provider: 'vercel',
              name: 'Marketing site',
              projectId: 'prj_123',
              defaultBranch: 'main',
              status: 'active',
            },
          ],
        }),
      },
    },
  }),
}));

import { DeploymentsPage } from '../deployments-page';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(cleanup);

describe('DeploymentsPage', () => {
  it('renders targets and recent deployments from the API', async () => {
    renderWithClient(<DeploymentsPage />);

    expect(screen.getByRole('heading', { name: 'Deployments' })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Marketing site/ })).toBeInTheDocument();
    });
    expect(screen.getByText('(vercel)')).toBeInTheDocument();
    // Target row action + the deployment's status badge and short sha.
    expect(screen.getByRole('button', { name: /deploy now/i })).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText(/abc1234/)).toBeInTheDocument();
  });
});

const settingsDir = resolve(__dirname, '..');
// HeoPress P07a: settings pages are routed by the workspace route table (Settings › Advanced and the module homes).
const routerSource = readFileSync(resolve(settingsDir, '../../workspace/routes.tsx'), 'utf8');
// The SEO / GEO sections (P07a task 8.2) route some settings pages through their own module.
const routedSource = routerSource + readFileSync(resolve(settingsDir, '../../workspace/seo/seo-pages.tsx'), 'utf8');

describe('settings route/nav wiring', () => {
  it('registers Deployments under Settings › Advanced (one table, both the plain and admin-path trees)', () => {
    expect(routerSource).toMatch(/import\('@\/modules\/settings\/deployments-page'\)/);
    expect(routerSource).toContain("['deployments', DeploymentsPage]");
    // The panel lists every Advanced page from the same table.
    expect(routerSource).toMatch(/ADVANCED_NAV = \[[^\]]*\.\.\.ADVANCED_PAGES\.map/);
  });

  it('routes every settings page component (no orphaned pages)', () => {
    const pages = readdirSync(settingsDir).filter((f) => f.endsWith('-page.tsx'));
    expect(pages.length).toBeGreaterThan(10);
    for (const page of pages) {
      const module = page.replace(/\.tsx$/, '');
      expect(routedSource, `${page} is not referenced by workspace/routes.tsx or the SEO sections`).toContain(`@/modules/settings/${module}`);
    }
  });
});

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import type { BackupOverview, SiteExportEntry } from '../../api';

/** Logs & monitoring › Backups (HeoPress P13 tasks 1.1–1.3): the catalogue, drill results with failed objects, exports. */

const overview: BackupOverview = {
  configured: true,
  target: 'local:/var/lib/heopress/backups',
  method: 'basebackup',
  encrypted: true,
  schedule: { enabled: true, full: '0 30 2 * * *', incremental: '0 15 * * * *', drill: '0 0 4 * * 0' },
  retention: { daily: 14, weekly: 8 },
  backups: [
    { id: '20261029T021500Z-i-0000aaaa', kind: 'incremental', method: 'basebackup', status: 'succeeded', trigger: 'schedule', parentId: '20261029T023000Z-f-0000bbbb', baseId: '20261029T023000Z-f-0000bbbb', sizeBytes: 3 * 1024 * 1024, objectCount: 40, mediaObjects: 12, mediaNew: 2, encrypted: true, error: null, createdAt: '2026-10-29T02:15:00Z', finishedAt: '2026-10-29T02:16:00Z' },
    { id: '20261028T023000Z-f-0000cccc', kind: 'full', method: 'basebackup', status: 'failed', trigger: 'schedule', parentId: null, baseId: null, sizeBytes: null, objectCount: null, mediaObjects: null, mediaNew: null, encrypted: true, error: 'TOOL_MISSING: pg_basebackup was not found', createdAt: '2026-10-28T02:30:00Z', finishedAt: null },
  ],
  drills: [
    {
      id: 'd1',
      backupId: '20261029T021500Z-i-0000aaaa',
      status: 'failed',
      trigger: 'schedule',
      createdAt: '2026-10-29T04:00:00Z',
      finishedAt: '2026-10-29T04:03:00Z',
      report: { checks: [{ name: 'media', status: 'failed' }, { name: 'database', status: 'passed' }], failures: [{ check: 'media', object: 'default/sites/a/media/x.png', message: 'does not match its recorded SHA-256' }] },
    },
  ],
};
const exportsList: SiteExportEntry[] = [{ id: 'e1', status: 'succeeded', location: '/srv/heopress/exports/site_a/e1', items: 12, media: 3, error: null, createdAt: '2026-10-29T05:00:00Z', finishedAt: '2026-10-29T05:01:00Z', report: { dropped: [{ what: 'media', detail: 'svg' }] } }];

vi.mock('../../api', () => ({
  backupsApi: {
    overview: vi.fn(async () => overview),
    siteExports: vi.fn(async () => exportsList),
    backupNow: vi.fn(),
    drillNow: vi.fn(),
    exportSite: vi.fn(),
  },
}));

const { BackupsPage } = await import('../backups-page');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

describe('Backups page', () => {
  it('shows the chain, a failed backup with its reason, the failed drill object and the site exports', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BackupsPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('20261029T021500Z-i-0000aaaa', { selector: 'td code' })).toBeTruthy();
    expect(screen.getByText('after 20261029T023000Z-f-0000bbbb')).toBeTruthy();
    expect(screen.getByText('TOOL_MISSING: pg_basebackup was not found')).toBeTruthy();
    expect(screen.getByText('default/sites/a/media/x.png')).toBeTruthy();
    expect(screen.getByText('14 daily, 8 weekly, whole chains kept')).toBeTruthy();
    expect(await screen.findByText('12 items, 3 media files')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

const entry = (over: Record<string, unknown>) => ({
  id: 'c1',
  itemId: 'i1',
  collection: 'articles',
  title: 'Harbour season',
  status: 'review',
  reason: 'gate_not_passed',
  notBefore: null,
  createdAt: '2026-10-26T10:00:00Z',
  detail: { failures: [{ reason: 'gate_not_passed' }] },
  gate: {
    state: 'needs_review',
    publishable: false,
    staleReasons: [],
    result: { id: 'r1', itemVersion: 2, status: 'needs_review', score: 64, checks: [{ rule: 'source_rights', status: 'needs_review', score: 50, mandatory: true, evidence: { sources: [] }, suggestions: ['Record the source licence.'] }] },
  },
  ...over,
});
const api = vi.hoisted(() => ({
  reviewQueue: vi.fn(),
  decide: vi.fn(),
}));
vi.mock('../api', async (orig) => ({ ...(await orig<typeof import('../api')>()), aiApi: api }));
vi.mock('../../api', () => ({ siteKey: (...p: unknown[]) => ['s', ...p] }));

const { ReviewQueuePage, actionsFor } = await import('../review-queue-page');
const { parseSse } = await import('../api');
const { intOrNull } = await import('../pipeline-settings-page');
const { parsePolicy } = await import('../workbench-page');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('AI review queue (P09 task 2.3)', () => {
  it('shows the score, a check with its suggestion, and each entry result of a batch', async () => {
    api.reviewQueue.mockResolvedValue([entry({}), entry({ id: 'c2', itemId: 'i2', title: 'Ferry figures', gate: { state: 'passed', publishable: true, staleReasons: [], result: { id: 'r2', itemVersion: 1, status: 'passed', score: 100, checks: [] } } })]);
    api.decide.mockResolvedValue([
      { id: 'c1', ok: true, status: 'review_queue', reason: 'licence_unknown' },
      { id: 'c2', ok: false, error: { code: 'NOT_REVIEWABLE', message: 'nothing to approve' } },
    ]);
    wrap(<ReviewQueuePage />);
    expect(await screen.findByText('Score 64')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]!);
    expect(screen.getByText('Record the source licence.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('alert').textContent).toContain('Write a reason first.');
    expect(api.decide).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reason (recorded with each decision)'), { target: { value: 'Checked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('approve', ['c1', 'c2'], 'Checked'));
    const results = await screen.findAllByTestId('ai-review-result');
    expect(results[0]!.textContent).toContain('Done');
    expect(results[1]!.textContent).toContain('NOT_REVIEWABLE');
  });

  it('offers the actions that fit an entry', () => {
    expect(actionsFor(entry({}) as never)).toEqual(['approve', 'reject', 'dismiss']);
    expect(actionsFor(entry({ status: 'veto_window' }) as never)).toEqual(['veto']);
  });
});

describe('workbench and settings helpers (P09 tasks 4.1, 4.x)', () => {
  it('parses an event stream, keeping an incomplete event for later', () => {
    const { events, rest } = parseSse('event: stage\ndata: {"type":"stage","stage":"model"}\n\nevent: output\ndata: {"type":"out');
    expect(events).toEqual([{ type: 'stage', stage: 'model' }]);
    expect(rest).toContain('"type":"out');
  });
  it('checks the editorial policy and number fields', () => {
    expect(parsePolicy('{"glossary": []}')).toEqual({ ok: true, value: { glossary: [] } });
    expect(parsePolicy('[1]').ok).toBe(false);
    expect(intOrNull('')).toBeNull();
    expect(intOrNull('12')).toBe(12);
    expect(intOrNull('1.5')).toBeUndefined();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HeoPressError } from '@heopress/sdk';

/**
 * Bulk raw edit with a partial failure (P02 task 8.5): every write finishes,
 * the failure is reported with a count, and the list is refreshed anyway
 * because the rows that did save changed.
 */

vi.mock('@/lib/code-editor', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="json" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const detail = vi.fn();
const patch = vi.fn();
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ items: () => ({ detail, patch }) }) }));

import { BulkRawEditor } from '../bulk-raw-editor';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BulkRawEditor', () => {
  it('reports a partial failure, waits for every write and refreshes the list', async () => {
    detail.mockImplementation(async (id: string) => ({ data: { id, data: { title: `old ${id}` } } }));
    let lateWriteDone = false;
    patch.mockImplementation(async (id: string) => {
      if (id === 'a') throw new Error('conflict');
      await new Promise((r) => setTimeout(r, 30));
      lateWriteDone = true;
      return { data: { id } };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const onSaved = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <BulkRawEditor collection="posts" ids={['a', 'b']} onClose={() => {}} onSaved={onSaved} />
      </QueryClientProvider>,
    );

    const editor = (await screen.findByLabelText('json')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain('old a'));
    fireEvent.change(editor, {
      target: { value: JSON.stringify([{ id: 'a', data: { title: 'new a' } }, { id: 'b', data: { title: 'new b' } }]) },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await screen.findByText(/1 of 2 item\(s\) were not saved/);
    expect(lateWriteDone).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['items', 'posts'] });
  });

  it('saves each row on the version it was loaded at, and names rows someone else changed (P04)', async () => {
    detail.mockImplementation(async (id: string) => ({ data: { id, version: id === 'a' ? 4 : 9, data: { title: `old ${id}` } } }));
    patch.mockImplementation(async (id: string) => {
      if (id === 'a') {
        throw new HeoPressError(409, {
          errors: [{ code: 'VERSION_CONFLICT', message: 'changed', meta: { currentVersion: 5, changedFields: ['title'] } }],
        });
      }
      return { data: { id } };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <BulkRawEditor collection="posts" ids={['a', 'b']} onClose={() => {}} onSaved={() => {}} />
      </QueryClientProvider>,
    );
    const editor = (await screen.findByLabelText('json')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain('old a'));
    // The version is not part of the editable JSON.
    expect(editor.value).not.toContain('version');
    fireEvent.change(editor, {
      target: { value: JSON.stringify([{ id: 'a', data: { title: 'new a' } }, { id: 'b', data: { title: 'new b' } }]) },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await screen.findByText(/1 changed since you opened them/);
    expect(patch).toHaveBeenCalledWith('a', { data: { title: 'new a' }, expectedVersion: 4 });
    expect(patch).toHaveBeenCalledWith('b', { data: { title: 'new b' }, expectedVersion: 9 });
  });

  it('a background refetch does not move the versions a save is based on (Codex P04-1, #3)', async () => {
    let version = 4;
    detail.mockImplementation(async (id: string) => ({ data: { id, version, data: { title: `old ${id}` } } }));
    patch.mockResolvedValue({ data: {} });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <BulkRawEditor collection="posts" ids={['a']} onClose={() => {}} onSaved={() => {}} />
      </QueryClientProvider>,
    );
    const editor = (await screen.findByLabelText('json')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain('old a'));
    // Someone else saves; a background refetch sees version 5.
    version = 5;
    await queryClient.refetchQueries();
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
    fireEvent.change(editor, { target: { value: JSON.stringify([{ id: 'a', data: { title: 'mine' } }]) } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('a', { data: { title: 'mine' }, expectedVersion: 4 }));
  });
});

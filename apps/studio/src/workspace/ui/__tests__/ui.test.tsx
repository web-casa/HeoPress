// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import { EmptyState } from '../empty-state';
import { FieldError } from '../field-error';
import { formatRelative, RelativeTime } from '../relative-time';
import { SkeletonRows } from '../skeleton';
import { showUndo, ToastRegion, UNDO_WINDOW_MS, useToasts } from '../undo-toast';

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

afterEach(() => {
  vi.useRealTimers();
  useToasts.setState({ toasts: [] });
});

describe('workspace state components (p07a task 2.8)', () => {
  it('the undo toast stays at least 8 seconds and undoes', () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    render(<ToastRegion />);
    void act(() => {
      showUndo('Issue ignored', undo);
    });
    expect(UNDO_WINDOW_MS).toBeGreaterThanOrEqual(8000);
    void act(() => vi.advanceTimersByTime(7900));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Issue ignored')).toBeNull();
  });

  it('the toast leaves by itself after the window', () => {
    vi.useFakeTimers();
    render(<ToastRegion />);
    void act(() => {
      showUndo('Moved to trash', () => undefined);
    });
    void act(() => vi.advanceTimersByTime(UNDO_WINDOW_MS + 1));
    expect(screen.queryByText('Moved to trash')).toBeNull();
  });

  it('relative time shows the exact time on hover', () => {
    const now = new Date('2026-10-24T12:00:00Z');
    render(<RelativeTime value="2026-10-24T09:00:00Z" now={now} />);
    const time = screen.getByText('3 hours ago');
    expect(time.getAttribute('title')).toMatch(/2026/);
    expect(time.getAttribute('dateTime')).toBe('2026-10-24T09:00:00.000Z');
  });

  it('formats relative time in Chinese too', () => {
    expect(formatRelative(new Date('2026-10-23T12:00:00Z'), new Date('2026-10-24T12:00:00Z'), 'zh-CN')).toBe('昨天');
  });

  it('empty state, field error and skeleton announce themselves', () => {
    render(
      <>
        <EmptyState title="No issues" body="The last audit found nothing." />
        <FieldError id="e1">Too short</FieldError>
        <SkeletonRows rows={2} />
      </>,
    );
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.getByRole('alert').textContent).toBe('Too short');
    expect(screen.getByLabelText('Loading…')).toBeTruthy();
  });
});

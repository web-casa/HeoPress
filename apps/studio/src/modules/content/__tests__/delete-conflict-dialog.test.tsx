// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DeleteConflictDialog } from '../delete-conflict-dialog';

/**
 * A delete refused with 409 VERSION_CONFLICT (HeoPress P14 task 6.4; spec content/write-concurrency "基于版本的条件删除"):
 * the editor learns the item changed since it was opened and nothing was deleted, and can reload it or stay.
 */

beforeAll(async () => {
  await initStudioI18n(i18n);
});
afterEach(async () => {
  cleanup();
  await setStudioLanguage('en', i18n);
});

function renderDialog(changedFields: string[] = []) {
  const onReload = vi.fn();
  const onClose = vi.fn();
  render(<DeleteConflictDialog currentVersion={13} changedFields={changedFields} onReload={onReload} onClose={onClose} />);
  return { onReload, onClose };
}

describe('DeleteConflictDialog', () => {
  it('says the item changed and was not deleted, with the fields and the current version; Reload reloads', async () => {
    await setStudioLanguage('en', i18n);
    const { onReload, onClose } = renderDialog(['title', 'body']);
    const dialog = screen.getByRole('alertdialog', { name: 'Changed by someone else' });
    expect(dialog.textContent).toContain('Not deleted');
    expect(dialog.textContent).toContain('title, body');
    expect(dialog.textContent).toContain('version 13');
    fireEvent.click(screen.getByRole('button', { name: 'Reload the item' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('without changed fields (a status change) it still explains; Keep this page only closes', async () => {
    await setStudioLanguage('en', i18n);
    const { onReload, onClose } = renderDialog();
    expect(screen.getByRole('alertdialog').textContent).toContain('it is now version 13');
    fireEvent.click(screen.getByRole('button', { name: 'Keep this page' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
  });

  it('in Chinese', async () => {
    await setStudioLanguage('zh-CN', i18n);
    renderDialog(['title']);
    expect(screen.getByRole('alertdialog', { name: '已被他人修改' }).textContent).toContain('未删除');
    expect(screen.getByRole('button', { name: '刷新条目' })).toBeTruthy();
  });
});

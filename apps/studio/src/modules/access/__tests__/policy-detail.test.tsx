// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import { AddPermissionDialog } from '../policy-detail';
import { buildAccessCollectionGroups } from '../system-collections';

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

describe('AddPermissionDialog', () => {
  it('groups system collections and hides sensitive targets for non-admin principals', () => {
    render(
      <AddPermissionDialog
        collectionGroups={buildAccessCollectionGroups(['posts', 'api_keys'], false)}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        submitting={false}
        error={null}
      />,
    );

    expect(screen.getByRole('group', { name: 'Content collections' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Schema builder' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Access control' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Extension access' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Sensitive system' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'api_keys' })).not.toBeInTheDocument();
  });

  it('allows admins to select sensitive system collections', () => {
    const onSubmit = vi.fn();
    render(
      <AddPermissionDialog
        collectionGroups={buildAccessCollectionGroups(['posts'], true)}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        submitting={false}
        error={null}
      />,
    );

    expect(screen.getByRole('group', { name: 'Sensitive system' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/collection/i), { target: { value: 'api_keys' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(onSubmit).toHaveBeenCalledWith('api_keys', 'read');
  });

  // HeoPress P07a task 5.1: the editor grants the per-collection `review` action.
  it('offers the review action and submits it', () => {
    const onSubmit = vi.fn();
    render(
      <AddPermissionDialog
        collectionGroups={buildAccessCollectionGroups(['posts'], false)}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        submitting={false}
        error={null}
      />,
    );
    fireEvent.change(screen.getByLabelText(/collection/i), { target: { value: 'posts' } });
    fireEvent.change(screen.getByLabelText(/action/i), { target: { value: 'review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).toHaveBeenCalledWith('posts', 'review');
  });
});

import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { withAdminBase } from '@/lib/keybindings/commands';
import { usePermissions } from '@/lib/use-permissions';
import { ModuleLayout, type NavGroup } from '../shell/module-layout';
import { EmptyState } from '../ui/empty-state';

/**
 * Settings sections (HeoPress P07a task 12.1; spec studio/settings "设置分区"): Workspace (general, appearance, members),
 * System (API keys, license) and Advanced (the pages carried over from LumiBase). A member without site administration
 * sees only its own sections; the others are not listed and their addresses say why they are closed.
 */
export function settingsGroups(isAdmin: boolean, advanced: string[]): NavGroup[] {
  return [
    {
      title: 'settings.workspace',
      items: [
        { to: '/settings/general', label: 'settings.general', visible: isAdmin },
        { to: '/settings/appearance', label: 'settings.appearance' },
        { to: '/settings/members', label: 'settings.members', visible: isAdmin },
      ],
    },
    {
      title: 'settings.system',
      items: [
        { to: '/settings/api-keys', label: 'settings.apiKeys', visible: isAdmin },
        { to: '/settings/license', label: 'settings.license', visible: isAdmin },
      ],
    },
    { title: 'settings.advanced', items: advanced.map((p) => ({ to: `/settings/advanced/${p}`, label: `settings.legacy.${p}`, visible: isAdmin })) },
  ];
}

export function settingsLayout(advanced: string[]): ComponentType {
  return function SettingsLayout() {
    const { canAdminister } = usePermissions();
    return <ModuleLayout groups={settingsGroups(canAdminister, advanced)} />;
  };
}

/** `/settings`: General for administrators, Appearance for everyone else. */
export function SettingsHome() {
  const { canAdminister: isAdmin, isLoading } = usePermissions();
  const { location } = useRouterState();
  const navigate = useNavigate();
  const target = withAdminBase(getAdminBase(location.pathname), isAdmin ? '/settings/general' : '/settings/appearance');
  useEffect(() => {
    if (!isLoading) void navigate({ to: target as never, replace: true });
  }, [isLoading, navigate, target]);
  return null;
}

/** A section for site administrators: others see why it is closed instead of a page that fails. */
export function adminOnly(Component: ComponentType): ComponentType {
  return function AdminOnly() {
    const { t } = useTranslation('settings');
    const { canAdminister, isLoading } = usePermissions();
    if (isLoading) return null;
    if (!canAdminister) return <EmptyState title={t('adminOnly.title')} body={t('adminOnly.body')} />;
    return <Component />;
  };
}


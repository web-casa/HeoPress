// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Link, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';

const TABS: Array<{ id: string; labelKey: string; to: string }> = [
  { id: 'roles', labelKey: 'layout.tabs.roles', to: '/settings/advanced/access/roles' },
  { id: 'policies', labelKey: 'layout.tabs.policies', to: '/settings/advanced/access/policies' },
  { id: 'public', labelKey: 'layout.tabs.public', to: '/settings/advanced/access/public' },
  { id: 'api-keys', labelKey: 'layout.tabs.apiKeys', to: '/settings/advanced/access/api-keys' },
  { id: 'import-export', labelKey: 'layout.tabs.importExport', to: '/settings/advanced/access/import-export' },
  { id: 'matrix', labelKey: 'layout.tabs.matrix', to: '/settings/advanced/access/matrix' },
  { id: 'sandbox', labelKey: 'layout.tabs.sandbox', to: '/settings/advanced/access/sandbox' },
];

interface AccessLayoutProps {
  children: ReactNode;
}

/**
 * Access Control module shell. Renders a top-bar of section tabs and slots
 * the active page underneath. The active tab is derived from the router
 * location so the layout remains pure markup.
 */
export function AccessLayout({ children }: AccessLayoutProps) {
  const { t: tr } = useTranslation('access');
  const { location } = useRouterState();
  // Matched on the address inside the private admin path (it lives under Settings › Advanced since P07a).
  const adminBase = getAdminBase(location.pathname);
  const appPath = adminBase ? location.pathname.slice(adminBase.length) : location.pathname;
  const activeTab = TABS.find((t) => appPath.startsWith(t.to))?.id ?? 'roles';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{tr('layout.title')}</h1>
        <p className="text-sm text-muted-foreground">{tr('layout.description')}</p>
      </header>
      <nav className="flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={withAdminBase(adminBase, t.to) as never}
            aria-current={activeTab === t.id ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              activeTab === t.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tr(t.labelKey)}
          </Link>
        ))}
      </nav>
      <section>{children}</section>
    </div>
  );
}

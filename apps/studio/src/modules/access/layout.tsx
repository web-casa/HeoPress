// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Link, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { getAdminBase } from '@/lib/admin-base';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';

const TABS: Array<{ id: string; label: string; to: string }> = [
  { id: 'roles', label: 'Roles', to: '/settings/advanced/access/roles' },
  { id: 'policies', label: 'Policies', to: '/settings/advanced/access/policies' },
  { id: 'public', label: 'Public & subscribers', to: '/settings/advanced/access/public' },
  { id: 'api-keys', label: 'API keys', to: '/settings/advanced/access/api-keys' },
  { id: 'import-export', label: 'Import / export', to: '/settings/advanced/access/import-export' },
  { id: 'matrix', label: 'Permission matrix', to: '/settings/advanced/access/matrix' },
  { id: 'sandbox', label: 'Test sandbox', to: '/settings/advanced/access/sandbox' },
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
  const { location } = useRouterState();
  // Matched on the address inside the private admin path (it lives under Settings › Advanced since P07a).
  const adminBase = getAdminBase(location.pathname);
  const appPath = adminBase ? location.pathname.slice(adminBase.length) : location.pathname;
  const activeTab = TABS.find((t) => appPath.startsWith(t.to))?.id ?? 'roles';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Access control</h1>
        <p className="text-sm text-muted-foreground">
          Roles bundle policies; policies bundle permission rules. Use the
          matrix to audit and the sandbox to debug a verdict.
        </p>
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
            {t.label}
          </Link>
        ))}
      </nav>
      <section>{children}</section>
    </div>
  );
}

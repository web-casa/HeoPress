import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';
import { ModulePanel, PanelSection } from './module-panel';

interface NavItem {
  /** App-internal path. */
  to: string;
  /** Key in the `nav` namespace. */
  label: string;
  /** Match the path exactly (index views) rather than as a prefix. */
  exact?: boolean;
  /** Only shown when true (permission-gated sections). */
  visible?: boolean;
}

export interface NavGroup {
  title?: string;
  items: NavItem[];
}

/** A link in a module panel, `aria-current` on the selected view. */
function PanelLink({ to, active, children, count }: { to: string; active: boolean; children: ReactNode; count?: ReactNode }) {
  return (
    <Link
      to={to as never}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-8 items-center justify-between gap-2 rounded-ctl px-2 text-[13px] transition-colors',
        active ? 'bg-sel font-medium text-fg' : 'text-dim hover:bg-panel-2 hover:text-fg',
      )}
    >
      <span className="truncate">{children}</span>
      {count !== undefined ? <span className="t-num text-[12px] text-dim">{count}</span> : null}
    </Link>
  );
}

/** Is `appPath` the view `item` points at? */
function isActiveItem(appPath: string, item: NavItem): boolean {
  const target = item.to.replace(/\/$/, '');
  return item.exact ? appPath === target : appPath === target || appPath.startsWith(`${target}/`);
}

/**
 * A module whose panel is a list of views: the panel lists `groups`, the
 * main area renders the matched child route (`children` overrides).
 */
export function ModuleLayout({ groups, panelTop, children }: { groups: NavGroup[]; panelTop?: ReactNode; children?: ReactNode }) {
  const { t } = useTranslation('nav');
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const appPath = adminBase && location.pathname.startsWith(adminBase) ? location.pathname.slice(adminBase.length) || '/' : location.pathname;
  const items = groups.flatMap((g) => g.items.filter((i) => i.visible !== false));
  // The most specific matching item is the selected one.
  const selected = items.filter((i) => isActiveItem(appPath, i)).sort((a, b) => b.to.length - a.to.length)[0];
  return (
    <>
      <ModulePanel>
        {panelTop}
        {groups.map((group, index) => {
          const visible = group.items.filter((i) => i.visible !== false);
          if (visible.length === 0) return null;
          return (
            <PanelSection key={group.title ?? index} title={group.title ? t(group.title) : undefined}>
              {visible.map((item) => (
                <PanelLink key={item.to} to={withAdminBase(adminBase, item.to)} active={item === selected}>
                  {t(item.label)}
                </PanelLink>
              ))}
            </PanelSection>
          );
        })}
      </ModulePanel>
      {children ?? <Outlet />}
    </>
  );
}

/** Main-area frame for a page (legacy pages keep their own inner layout). */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cn('mx-auto w-full px-4 py-5 sm:px-6', wide ? 'max-w-[1440px]' : 'max-w-[1200px]')}>{children}</div>;
}

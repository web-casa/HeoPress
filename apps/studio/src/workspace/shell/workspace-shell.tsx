import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { LogOut, Menu, Monitor, Moon, Search, Sun, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NotificationsPanel } from '@/components/notifications-panel';
import { SearchPalette } from '@/components/search-palette';
import { SiteSwitcher } from '@/components/site-switcher';
import { setStudioLanguage } from '@/i18n';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient, hasActiveToken, logout } from '@/lib/api';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';
import { useKeybindingsStore } from '@/lib/keybindings/store';
import { useGlobalShortcuts } from '@/lib/keybindings/use-keybindings';
import { usePermissions } from '@/lib/use-permissions';
import { appearanceFromPreferences, useAppearance, type ThemeChoice } from '@/theme/appearance';
import { firstFocusable, trapTab } from './focus-trap';
import { PANEL_SLOT_ID } from './module-panel';
import { moduleOf, visibleModules, type ModuleDef } from './modules';
import { saveStudioPreferences } from './preferences';
import { ShortcutsDialog, useModuleJumps } from './shortcuts';
import { useShell } from './store';
import { CommandPalette } from './command-palette';
import { ToastRegion } from '../ui/undo-toast';

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { light: 'dark', dark: 'system', system: 'light' };
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor } as const;

/** The app-internal path (without the private admin prefix). */
function appPathOf(pathname: string, adminBase: string): string {
  return adminBase && pathname.startsWith(adminBase) ? pathname.slice(adminBase.length) || '/' : pathname;
}

/**
 * Carbon workspace shell (ADR-0019 §1): a 60px module rail, the module's
 * context panel (filled by `ModulePanel`) and the main area. Below 900px the
 * rail and panel become a drawer opened from the top bar.
 */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation('shell');
  const { location } = useRouterState();
  const navigate = useNavigate();
  const adminBase = getAdminBase(location.pathname);
  const appPath = appPathOf(location.pathname, adminBase);
  const active = moduleOf(appPath);
  const { isAdmin } = usePermissions();
  const modules = visibleModules(isAdmin);
  const activeModule = modules.find((m) => m.id === active);

  const { drawerOpen, openDrawer, closeDrawer } = useShell();
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Close the drawer on navigation.
  useEffect(() => {
    closeDrawer();
  }, [location.pathname, closeDrawer]);

  // Drawer: focus inside while open, Esc closes, focus returns to the menu button.
  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    if (drawer) firstFocusable(drawer)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeDrawer();
        menuButtonRef.current?.focus();
      } else if (drawer) {
        trapTab(drawer, e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, closeDrawer]);

  // Content search: ⌘P / Ctrl+P.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Stored keybindings, appearance and language.
  const resolvedKeymap = useKeybindingsStore((s) => s.resolvedKeymap);
  const runSave = useKeybindingsStore((s) => s.runSave);
  const setOverrides = useKeybindingsStore((s) => s.setOverrides);
  const setLoaded = useKeybindingsStore((s) => s.setLoaded);
  const prefsQuery = useQuery({
    queryKey: ['me', 'preferences'],
    queryFn: () => getApiClient().me.getPreferences(),
    enabled: hasActiveToken(),
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (!prefsQuery.data) return;
    const prefs = prefsQuery.data.data as Parameters<typeof appearanceFromPreferences>[0] & { keybindings?: Record<string, string> };
    setOverrides(prefs?.keybindings ?? {});
    setLoaded(true);
    useAppearance.getState().set(appearanceFromPreferences(prefs));
    // `undefined`: never chosen on the server — keep this browser's choice.
    if (prefs?.studio?.language !== undefined) void setStudioLanguage(prefs.studio.language);
  }, [prefsQuery.data, setOverrides, setLoaded]);

  const onAction = useCallback(
    (actionId: string) => {
      switch (actionId) {
        case 'editor.save':
          runSave();
          break;
        case 'palette.open':
        case 'palette.openAlt':
          setPaletteOpen((o) => !o);
          break;
        case 'nav.settings':
          void navigate({ to: withAdminBase(adminBase, '/settings') as never });
          break;
        case 'help.shortcuts':
          setShortcutsOpen(true);
          break;
      }
    },
    [navigate, adminBase, runSave],
  );
  useGlobalShortcuts(resolvedKeymap, onAction);
  useModuleJumps(modules, adminBase, () => setShortcutsOpen(true));

  const theme = useAppearance((s) => s.theme) ?? 'system';
  const ThemeIcon = THEME_ICON[theme];
  const cycleTheme = () => {
    const next = NEXT_THEME[theme];
    useAppearance.getState().set({ theme: next });
    if (hasActiveToken()) void saveStudioPreferences({ theme: next }).catch(() => undefined);
  };

  const onPaletteAction = (id: string) => {
    if (id === 'action.newArticle') void navigate({ to: withAdminBase(adminBase, '/content/new') as never });
    else if (id === 'action.toggleTheme') cycleTheme();
    else if (id === 'action.shortcuts') setShortcutsOpen(true);
  };

  const handleLogout = () => {
    void logout()
      .then(({ endedOnServer }) => {
        if (!endedOnServer) window.alert(t('signOutOffline'));
      })
      .finally(() => window.location.assign(adminBase ? `${adminBase}/login` : '/'));
  };

  const moduleHref = (m: ModuleDef) => withAdminBase(adminBase, m.path);

  return (
    <div className="ws flex h-screen w-screen overflow-hidden bg-bg text-fg">
      <a
        href="#main-content"
        className="absolute left-2 top-2 z-[60] -translate-y-[200%] rounded-ctl bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg shadow-md transition-transform focus:translate-y-0"
      >
        {t('skipToMain')}
      </a>

      {drawerOpen ? (
        <button
          type="button"
          aria-label={t('closeMenu')}
          tabIndex={-1}
          className="fixed inset-0 z-40 bg-black/40 min-[900px]:hidden"
          onClick={closeDrawer}
        />
      ) : null}

      <div
        ref={drawerRef}
        id="ws-drawer"
        className={cn(
          'z-50 flex h-full shrink-0',
          'max-[899px]:fixed max-[899px]:inset-y-0 max-[899px]:left-0 max-[899px]:shadow-xl max-[899px]:transition-transform max-[899px]:duration-200',
          drawerOpen ? 'max-[899px]:translate-x-0' : 'max-[899px]:-translate-x-full max-[899px]:invisible',
        )}
        {...(drawerOpen ? { role: 'dialog', 'aria-modal': true, 'aria-label': t('menu') } : {})}
      >
        <nav aria-label={t('primaryNav')} className="flex w-[60px] flex-col items-center gap-1 border-r border-line bg-panel py-3">
          <Link
            to={withAdminBase(adminBase, '/overview') as never}
            className="mb-2 flex h-9 w-9 items-center justify-center rounded-ctl bg-fg text-[13px] font-bold text-bg"
            aria-label={t('brand')}
          >
            {t('brand').charAt(0)}
          </Link>
          <RailButton label={t('search')} onClick={() => setPaletteOpen(true)}>
            <Search className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
          </RailButton>
          <div className="my-1 h-px w-6 bg-line" aria-hidden="true" />
          <ul className="flex flex-col items-center gap-1">
            {modules.map((m) => {
              const Icon = m.icon;
              const isActive = m.id === active;
              return (
                <li key={m.id}>
                  <Link
                    to={moduleHref(m) as never}
                    aria-label={t(`modules.${m.id}`)}
                    aria-current={isActive ? 'page' : undefined}
                    title={t(`modules.${m.id}`)}
                    className={cn(
                      'relative flex h-10 w-10 items-center justify-center rounded-ctl transition-colors',
                      isActive ? 'bg-brand-soft text-brand' : 'text-icon hover:bg-panel-2 hover:text-fg',
                    )}
                  >
                    {isActive ? <span className="absolute -left-[10px] h-5 w-[3px] rounded-r bg-brand" aria-hidden="true" /> : null}
                    <Icon className="h-[19px] w-[19px]" strokeWidth={1.8} aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="mt-auto flex flex-col items-center gap-1">
            <div className="text-icon [&_button]:h-10 [&_button]:w-10">
              <NotificationsPanel placement="rail" />
            </div>
            <RailButton label={`${t('theme')}: ${t(`themes.${theme}`)}`} onClick={cycleTheme}>
              <ThemeIcon className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
            </RailButton>
            <RailButton label={t('signOut')} onClick={handleLogout}>
              <LogOut className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
            </RailButton>
          </div>
        </nav>

        <aside className="flex w-[232px] flex-col border-r border-line bg-bg" aria-label={activeModule ? t(`modules.${activeModule.id}`) : undefined}>
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-3">
            <div className="min-w-0 flex-1">
              <SiteSwitcher />
            </div>
            <button
              type="button"
              onClick={closeDrawer}
              aria-label={t('closeMenu')}
              className="flex h-8 w-8 items-center justify-center rounded-ctl text-icon hover:bg-panel-2 min-[900px]:hidden"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {activeModule ? <div className="px-4 pb-1 pt-3 t-section">{t(`modules.${activeModule.id}`)}</div> : null}
          <div id={PANEL_SLOT_ID} className="flex-1 overflow-y-auto px-2 pb-4 pt-1" />
        </aside>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 min-[900px]:hidden">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={openDrawer}
            aria-label={t('menu')}
            aria-expanded={drawerOpen}
            aria-controls="ws-drawer"
            className="flex h-9 w-9 items-center justify-center rounded-ctl text-icon hover:bg-panel-2"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <span className="min-w-0 flex-1 truncate t-section">{activeModule ? t(`modules.${activeModule.id}`) : null}</span>
          <RailButton label={t('search')} onClick={() => setPaletteOpen(true)}>
            <Search className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
          </RailButton>
          <RailButton label={`${t('theme')}: ${t(`themes.${theme}`)}`} onClick={cycleTheme}>
            <ThemeIcon className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
          </RailButton>
        </header>
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-auto focus:outline-none">
          {children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} adminBase={adminBase} onAction={onPaletteAction} />
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <ToastRegion />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} modules={modules} />
    </div>
  );
}

function RailButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-10 w-10 items-center justify-center rounded-ctl text-icon transition-colors hover:bg-panel-2 hover:text-fg"
    >
      {children}
    </button>
  );
}

// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Link, useRouterState } from '@tanstack/react-router';
import { OctagonX, Sparkles, X } from 'lucide-react';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { cn } from '@/lib/cn';
import { useServerFeatures } from '@/lib/features';
import { IntentComposer } from './intent-composer';
import { KillSwitchPanel } from './kill-switch';

/**
 * Mission Control chrome (content-os-ui task 2.1; Req 1.2, 1.3).
 *
 * Every sub-route renders inside this layout: URL-driven sub-navigation
 * plus the two controls that must never be more than one click away —
 * the kill switch (emergency stop, opens as a modal so the operator never
 * has to navigate to stop the system) and the intent composer (the primary
 * verb of the Content OS).
 */

const SECTIONS = [
  { id: 'overview', path: '' },
  { id: 'inbox', path: '/inbox' },
  { id: 'intents', path: '/intents' },
  { id: 'goals', path: '/goals' },
  { id: 'agents', path: '/agents' },
  { id: 'trust', path: '/trust' },
  { id: 'constitution', path: '/constitution' },
] as const;

/** Optional `/$adminPath` prefix of the current location ('' when absent). */
export function useAdminBase(): string {
  const { location } = useRouterState();
  return getAdminBase(location.pathname);
}

/** Mission Control lives at Logs & monitoring › Agents since P07a (its old address redirects there). */
export function useMissionControlBase(): string {
  return `${useAdminBase()}/monitoring/agents`;
}

interface MissionControlActions {
  openKillSwitch: () => void;
  openComposer: () => void;
}

const ActionsContext = createContext<MissionControlActions | null>(null);

/** Layout-provided actions (Req 2.2: dashboard cards can open the kill switch modal). */
export function useMissionControlActions(): MissionControlActions {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error('useMissionControlActions must be used inside MissionControlLayout');
  return ctx;
}

export function MissionControlLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation('agents');
  const { location } = useRouterState();
  const [composerOpen, setComposerOpen] = useState(false);
  const [killSwitchOpen, setKillSwitchOpen] = useState(false);
  const features = useServerFeatures();
  // Intents need content goals; Agents need the multi-agent newsroom (P02 5.1).
  const sections = SECTIONS.filter(
    (s) => (s.id !== 'intents' || features.contentGoals) && (s.id !== 'agents' || features.agentNewsroom),
  );

  const base = `${getAdminBase(location.pathname)}/monitoring/agents`;
  const subPath = location.pathname.startsWith(base)
    ? location.pathname.slice(base.length)
    : '';
  const activeSection =
    SECTIONS.find((s) => s.path !== '' && subPath.startsWith(s.path))?.id ?? 'overview';

  const actions = useMemo<MissionControlActions>(
    () => ({
      openKillSwitch: () => setKillSwitchOpen(true),
      openComposer: () => setComposerOpen(true),
    }),
    [],
  );

  return (
    <ActionsContext.Provider value={actions}>
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t('layout.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('layout.description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Emergency stop is reachable from every sub-route (Req 1.3). */}
          <button
            type="button"
            onClick={() => setKillSwitchOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
          >
            <OctagonX className="h-4 w-4" /> {t('layout.killSwitch')}
          </button>
          {/* Primary CTA (content-os Req 16.5): declare desired state. */}
          {features.contentGoals && (
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Sparkles className="h-4 w-4" /> {t('layout.composeIntent')}
          </button>
          )}
        </div>
      </header>

      <nav className="flex gap-1 border-b" aria-label={t('layout.sectionsAria')}>
        {sections.map((s) => (
          <Link
            key={s.id}
            to={`${base}${s.path}` as never}
            aria-current={activeSection === s.id ? 'page' : undefined}
            className={cn(
              'rounded-t-md px-3 py-2 text-sm',
              activeSection === s.id
                ? 'border border-b-0 bg-background font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`layout.sections.${s.id}`)}
          </Link>
        ))}
      </nav>

      <section>{children}</section>

      {composerOpen && <IntentComposer onClose={() => setComposerOpen(false)} />}

      {killSwitchOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          role="dialog"
          aria-label={t('layout.killSwitch')}
        >
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border bg-background p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="inline-flex items-center gap-2 text-base font-semibold text-destructive">
                <OctagonX className="h-4 w-4" /> {t('layout.killSwitch')}
              </h2>
              <button
                type="button"
                onClick={() => setKillSwitchOpen(false)}
                aria-label={t('layout.closeKillSwitch')}
                className="rounded-md border p-1 hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <KillSwitchPanel />
          </div>
        </div>
      )}
    </div>
    </ActionsContext.Provider>
  );
}

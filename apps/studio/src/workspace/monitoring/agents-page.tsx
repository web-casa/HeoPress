import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Page } from '../shell/module-layout';

const MissionControlPage = lazy(() => import('@/modules/mission-control/index-page').then((m) => ({ default: m.MissionControlPage })));

/** Logs & monitoring › Agents: reserved for P10's agent view; Mission Control as it is until then. */
export function AgentsPage() {
  const { t } = useTranslation('monitoring');
  return (
    <Page wide>
      <p role="note" className="mb-4 rounded-ctl border border-line bg-panel-2 px-3 py-2 text-[13px] text-dim">
        {t('agents.reserved')}
      </p>
      <Suspense fallback={null}>
        <MissionControlPage />
      </Suspense>
    </Page>
  );
}

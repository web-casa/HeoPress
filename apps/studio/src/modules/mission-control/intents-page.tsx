// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useTranslation } from 'react-i18next';
import { MissionControlLayout, useMissionControlBase } from './layout';
import { SloTable, useSloRows } from './slo-table';

/**
 * Intents list (content-os-ui task 6.1; Req 5.1): every declared SLO with
 * its live health. Rows link into the intent detail page.
 */
function IntentsBody() {
  const { t } = useTranslation('agents');
  const base = useMissionControlBase();
  const { rows, isLoading } = useSloRows();

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('intents.loading')}</p>;
  }
  return (
    <div className="rounded-lg border bg-background p-4">
      <SloTable rows={rows} linkBase={`${base}/intents`} />
    </div>
  );
}

export function IntentsPage() {
  return (
    <MissionControlLayout>
      <IntentsBody />
    </MissionControlLayout>
  );
}

// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { MissionControlLayout } from './layout';
import { TrustLedger } from './trust-ledger';

/** Trust ledger sub-route (content-os-ui Req 1.1). */
export function TrustPage() {
  return (
    <MissionControlLayout>
      <div className="rounded-card border border-line bg-panel p-4">
        <TrustLedger />
      </div>
    </MissionControlLayout>
  );
}

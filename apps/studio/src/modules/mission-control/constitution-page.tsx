// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { ConstitutionEditor } from './constitution-editor';
import { MissionControlLayout } from './layout';

/** Constitution editor sub-route (content-os-ui Req 1.1). */
export function ConstitutionPage() {
  return (
    <MissionControlLayout>
      <div className="rounded-card border border-line bg-panel p-4">
        <ConstitutionEditor />
      </div>
    </MissionControlLayout>
  );
}

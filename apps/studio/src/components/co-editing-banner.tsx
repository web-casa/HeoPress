// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * CoEditingBanner — real-time warning shown when more than one person has the
 * same item open at once. Driven by the presence channel (usePresence): the
 * moment a second editor's `presence` message names this item, the banner
 * appears for everyone. It needs no extra backend.
 *
 * Purpose: prevent silent overwrites. The avatar stack (PresenceStack) alone is
 * easy to miss; this makes concurrent editing impossible to ignore.
 *
 * Presentational — the parent supplies the already-scoped co-editor list so a
 * single presence subscription feeds both the banner and the avatar stack.
 */

import i18n from 'i18next';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PresenceEntry } from '@/types/realtime';

interface CoEditingBannerProps {
  /** Peers on the *same* item, excluding self — de-duped by userId. */
  coEditors: PresenceEntry[];
}

/** Display name for a co-editor — prefers a `name`/`email` in meta, else userId. */
function editorLabel(peer: PresenceEntry): string {
  const meta = peer.meta ?? {};
  const name = meta.name ?? meta.email;
  return typeof name === 'string' && name.length > 0 ? name : peer.userId;
}

/** Join names into a natural-language list: "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  const sep = i18n.t('widgets:coEdit.listSeparator');
  return i18n.t('widgets:coEdit.listAnd', { head: names.slice(0, -1).join(sep), last: names[names.length - 1] });
}

export function CoEditingBanner({ coEditors }: CoEditingBannerProps) {
  const { t } = useTranslation('widgets');
  if (coEditors.length === 0) return null;

  const names = joinNames(coEditors.map(editorLabel));
  const plural = coEditors.length > 1;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-ctl border border-warn/40 bg-warn-soft p-3 text-sm text-warn"
    >
      <Users className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div>
        <p className="font-medium">
          {plural
            ? t('coEdit.many', { count: coEditors.length })
            : t('coEdit.one', { name: names })}
        </p>
        <p className="mt-0.5 text-xs text-warn">
          {plural ? t('coEdit.namesHere', { names }) : ''}
          {t('coEdit.warning')}
        </p>
      </div>
    </div>
  );
}

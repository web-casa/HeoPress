import { switchSite } from '@/lib/session/switch';
import { getAdminBase } from '@/lib/admin-base';
import i18n from 'i18next';

/**
 * Open a module view on another site (spec studio/network-summary "从概要进入修改"): Studio switches the session to that
 * site first, then lands on `path` there. Resolves with an error message when the switch was refused.
 */
export async function openOnSite(siteId: string, path: string): Promise<string | null> {
  const result = await switchSite(siteId, {
    confirmUnknownWrites: () => window.confirm(i18n.t('common:switchPendingWrites')),
    navigate: (base) => window.location.assign(`${base === '/' ? getAdminBase(window.location.pathname) : base}${path}`),
  });
  return result.ok ? null : result.message;
}

// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Trash2, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { deleteBookmark, type ViewPreset } from './api';
import { siteFetch } from '@/lib/http';

/**
 * Admin panel for managing role- and global-scoped presets (presets-inheritance
 * Req 5.4, 4.1). Lists every shared (non-user) preset for the site and lets an
 * admin delete them. Mounted in the role/settings detail area. The server
 * enforces admin on the mutating calls, so this is a convenience surface — a
 * non-admin who reached it still can't write.
 */

async function listAllPresets(): Promise<ViewPreset[]> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await siteFetch('/api/v1/presets', {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'X-HeoPress-Site': site } : {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: ViewPreset[] };
  return body.data ?? [];
}

export function RolePresets() {
  const { t } = useTranslation('dataModel');
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['all-presets'], queryFn: listAllPresets });

  const del = useMutation({
    mutationFn: (id: string) => deleteBookmark(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['all-presets'] }),
  });

  // Shared presets only: role- or global-scoped (userId is null).
  const shared = (query.data ?? []).filter((p) => !p.userId);

  return (
    <section className="space-y-3">
      <header>
        <h3 className="text-sm font-semibold">{t('presets.shared')}</h3>
        <p className="text-xs text-muted-foreground">{t('presets.sharedHint')}</p>
      </header>

      {query.isLoading && <p className="text-sm text-muted-foreground">{t('common:loading')}</p>}
      {shared.length === 0 && !query.isLoading && (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{t('presets.sharedEmpty')}</p>
      )}

      <ul className="divide-y rounded-md border">
        {shared.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="flex items-center gap-2 truncate">
              {p.roleId ? <Users className="h-4 w-4 opacity-60" /> : <Globe className="h-4 w-4 opacity-60" />}
              <span className="truncate">
                {p.bookmark ?? <span className="text-muted-foreground">{t('presets.defaultView')}</span>} · {p.collection}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                {p.roleId ? t('presets.scope.role') : t('presets.scope.global')}
              </span>
            </span>
            <button
              type="button"
              aria-label={t('presets.delete')}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
              disabled={del.isPending}
              onClick={() => del.mutate(p.id)}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

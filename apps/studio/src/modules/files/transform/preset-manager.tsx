// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { transformUrl } from './transform-panel';
import { siteFetch } from '@/lib/http';

/**
 * Transform preset manager (image-transform-dsl Req 5.1, 5.3). Lists named
 * presets, creates/deletes them, and offers a Copy-URL for applying a preset to
 * a given file key. Backend enforces the media permission.
 */

interface TransformPreset {
  id: string;
  key: string;
  name: string;
  dsl: { width?: number; height?: number; format?: string; quality?: number; fit?: string };
}

async function presetApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await siteFetch(`/api/v1/transform-presets${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(getActiveToken() ? { Authorization: `Bearer ${getActiveToken()}` } : {}),
      ...(getActiveSite() ? { 'X-HeoPress-Site': getActiveSite()! } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string }> };
  if (!res.ok) throw new Error(body.errors?.[0]?.message ?? i18n.t('files:requestFailed', { status: res.status }));
  return body.data as T;
}

export function PresetManager({ fileKey }: { fileKey?: string }) {
  const { t } = useTranslation('files');
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ key: '', name: '', width: '', height: '', format: '' });

  const query = useQuery({ queryKey: ['transform-presets'], queryFn: () => presetApi<TransformPreset[]>('') });

  const create = useMutation({
    mutationFn: () =>
      presetApi<TransformPreset>('', {
        method: 'POST',
        body: JSON.stringify({
          key: form.key.trim(),
          name: form.name.trim(),
          dsl: {
            ...(form.width ? { width: Number(form.width) } : {}),
            ...(form.height ? { height: Number(form.height) } : {}),
            ...(form.format ? { format: form.format } : {}),
          },
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['transform-presets'] });
      setShowNew(false);
      setForm({ key: '', name: '', width: '', height: '', format: '' });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => presetApi<null>(`/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['transform-presets'] }),
  });

  const presets = query.data ?? [];

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('presets.title')}</h3>
        <button type="button" className="inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1 text-xs hover:bg-panel-2" onClick={() => setShowNew((s) => !s)}>
          <Plus className="h-3.5 w-3.5" /> {t('presets.new')}
        </button>
      </header>

      {showNew && (
        <div className="grid grid-cols-2 gap-2 rounded-ctl border border-line p-3 sm:grid-cols-5">
          <input placeholder={t('presets.key')} className="rounded border border-line px-2 py-1 text-sm" value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} />
          <input placeholder={t('presets.name')} className="rounded border border-line px-2 py-1 text-sm" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          <input placeholder={t('presets.width')} type="number" className="rounded border border-line px-2 py-1 text-sm" value={form.width} onChange={(e) => setForm((f) => ({ ...f, width: e.target.value }))} />
          <input placeholder={t('presets.height')} type="number" className="rounded border border-line px-2 py-1 text-sm" value={form.height} onChange={(e) => setForm((f) => ({ ...f, height: e.target.value }))} />
          <button type="button" disabled={!form.key.trim() || !form.name.trim() || create.isPending} className="rounded-ctl bg-brand px-2 py-1 text-xs text-brand-fg disabled:opacity-50" onClick={() => create.mutate()}>
            {t('common:save')}
          </button>
          {create.isError && <p className="col-span-full text-xs text-bad">{(create.error as Error).message}</p>}
        </div>
      )}

      <ul className="divide-y rounded-ctl border border-line">
        {presets.length === 0 && <li className="p-3 text-sm text-dim">{t('presets.empty')}</li>}
        {presets.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="truncate">
              <span className="font-medium">{p.name}</span>{' '}
              <span className="font-mono text-xs text-dim">{p.key}</span>
            </span>
            <span className="flex items-center gap-1">
              {fileKey && (
                <button
                  type="button"
                  aria-label={t('presets.copyUrlFor', { key: p.key })}
                  className="rounded p-1 text-dim hover:bg-panel-2"
                  onClick={() => void navigator.clipboard?.writeText(transformUrl(fileKey, {}) + `?preset=${p.key}`)}
                >
                  <Copy className="h-4 w-4" />
                </button>
              )}
              <button type="button" aria-label={t('presets.deleteKey', { key: p.key })} className="rounded p-1 text-dim hover:bg-panel-2 hover:text-bad" disabled={del.isPending} onClick={() => del.mutate(p.id)}>
                <Trash2 className="h-4 w-4" />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Mail,
  Plus,
  Trash2,
  Pencil,
  Save,
  Send,
  Eye,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import i18n from 'i18next';
import { Trans, useTranslation } from 'react-i18next';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { useSaveHandler } from '@/lib/keybindings/use-keybindings';
import { siteFetch } from '@/lib/http';

/**
 * Email templates & layouts manager (email-service feature).
 *
 * Surfaces /api/v1/email:
 *   - Status banner from /email/capabilities (transport configured?).
 *   - Layouts CRUD (reusable HTML shells with a {{content}} slot).
 *   - Templates CRUD with a live preview pane (/email/templates/:key/preview).
 *   - Send a test mail (/email/test).
 *
 * The typed SDK doesn't (yet) cover these endpoints, so we use a small raw
 * fetch helper mirroring `materialize-page.tsx`.
 */

interface Capabilities {
  configured: boolean;
  transport: string | null;
  from: string | null;
}
interface LayoutRow {
  id: string;
  key: string;
  name: string;
  html: string;
}
interface TemplateRow {
  id: string;
  key: string;
  name: string;
  layoutId: string | null;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variables: string[];
  enabled: boolean;
}
interface Rendered {
  subject: string;
  html: string;
  text: string;
  missing: string[];
}

async function emailFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await siteFetch(`/api/v1/email${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'X-HeoPress-Site': site } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: Array<{ code: string; message?: string }>;
  };
  if (!res.ok) {
    throw new Error(body.errors?.[0]?.message ?? body.errors?.[0]?.code ?? i18n.t('siteOps:email.requestFailed', { status: res.status }));
  }
  return body.data as T;
}

export function EmailSettingsPage() {
  const { t } = useTranslation('siteOps');
  const qc = useQueryClient();

  const capsQuery = useQuery({
    queryKey: ['email', 'capabilities'],
    queryFn: () => emailFetch<Capabilities>('/capabilities'),
  });
  const layoutsQuery = useQuery({
    queryKey: ['email', 'layouts'],
    queryFn: () => emailFetch<LayoutRow[]>('/layouts'),
  });
  const templatesQuery = useQuery({
    queryKey: ['email', 'templates'],
    queryFn: () => emailFetch<TemplateRow[]>('/templates'),
  });

  const [editingTemplate, setEditingTemplate] = useState<TemplateRow | 'new' | null>(null);
  const [editingLayout, setEditingLayout] = useState<LayoutRow | 'new' | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testStatus, setTestStatus] = useState<string | null>(null);

  const layouts = layoutsQuery.data ?? [];
  const templates = templatesQuery.data ?? [];
  const caps = capsQuery.data;

  const deleteTemplate = useMutation({
    mutationFn: (id: string) => emailFetch(`/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email', 'templates'] }),
  });
  const deleteLayout = useMutation({
    mutationFn: (id: string) => emailFetch(`/layouts/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email', 'layouts'] }),
  });
  const sendTest = useMutation({
    mutationFn: (to: string) =>
      emailFetch<{ sent: boolean }>('/test', { method: 'POST', body: JSON.stringify({ to }) }),
    onSuccess: () => setTestStatus(t('email.testSent')),
    onError: (e: Error) => setTestStatus(t('email.testFailed', { message: e.message })),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('email.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('email.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditingTemplate('new')}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> {t('email.newTemplate')}
        </button>
      </header>

      {/* Status */}
      <section className="rounded-lg border p-4">
        {capsQuery.isLoading ? (
          <div className="text-muted-foreground">{t('email.checking')}</div>
        ) : caps?.configured ? (
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
            <div className="text-sm">
              <p className="font-medium">{t('email.configured', { transport: caps.transport })}</p>
              <p className="text-muted-foreground">
                <Trans t={t} i18nKey="email.sendingAs" values={{ from: caps.from }} components={{ code: <code /> }} />
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-600" />
            <div className="text-sm">
              <p className="font-medium">{t('email.notConfigured')}</p>
              <p className="text-muted-foreground">
                <Trans t={t} i18nKey="email.notConfiguredHelp" components={{ code: <code /> }} />
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Send test */}
      <section className="rounded-lg border p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Send className="h-4 w-4" /> {t('email.sendTestTitle')}
        </h2>
        <div className="flex items-center gap-2">
          <input
            type="email"
            value={testTo}
            placeholder={t('email.testPlaceholder')}
            onChange={(e) => setTestTo(e.target.value)}
            className="w-72 rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <button
            type="button"
            disabled={!testTo || sendTest.isPending || !caps?.configured}
            onClick={() => {
              setTestStatus(null);
              sendTest.mutate(testTo);
            }}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {sendTest.isPending ? t('email.sending') : t('email.sendTest')}
          </button>
          {testStatus && <span className="text-sm text-muted-foreground">{testStatus}</span>}
        </div>
      </section>

      {/* Templates */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">{t('email.templates')}</h2>
        <div className="grid gap-3">
          {templates.length === 0 && !templatesQuery.isLoading && (
            <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
              {t('email.noTemplates')}
            </div>
          )}
          {templates.map((tpl) => (
            <div key={tpl.id} className="flex items-center justify-between rounded-lg border bg-background p-4 shadow-sm">
              <div className="flex items-start gap-4">
                <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-blue-600">
                  <Mail className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold">
                    {tpl.name} <code className="text-xs text-muted-foreground">{tpl.key}</code>
                  </h3>
                  <p className="text-sm text-muted-foreground">{tpl.subject}</p>
                  {!tpl.enabled && (
                    <span className="mt-1 inline-flex rounded bg-muted px-2 py-0.5 text-xs">{t('email.disabled')}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setEditingTemplate(tpl)} className="text-muted-foreground hover:text-foreground">
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => confirm(t('email.confirmDeleteTemplate')) && deleteTemplate.mutate(tpl.id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Layouts */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('email.layouts')}</h2>
          <button
            type="button"
            onClick={() => setEditingLayout('new')}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" /> {t('email.newLayout')}
          </button>
        </div>
        <div className="grid gap-3">
          {layouts.length === 0 && !layoutsQuery.isLoading && (
            <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
              {t('email.noLayouts')}
            </div>
          )}
          {layouts.map((l) => (
            <div key={l.id} className="flex items-center justify-between rounded-lg border bg-background p-3 shadow-sm">
              <div>
                <span className="font-medium">{l.name}</span>{' '}
                <code className="text-xs text-muted-foreground">{l.key}</code>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setEditingLayout(l)} className="text-muted-foreground hover:text-foreground">
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => confirm(t('email.confirmDeleteLayout')) && deleteLayout.mutate(l.id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {editingTemplate && (
        <TemplateEditor
          template={editingTemplate === 'new' ? null : editingTemplate}
          layouts={layouts}
          onClose={() => setEditingTemplate(null)}
        />
      )}
      {editingLayout && (
        <LayoutEditor
          layout={editingLayout === 'new' ? null : editingLayout}
          onClose={() => setEditingLayout(null)}
        />
      )}
    </div>
  );
}

function LayoutEditor({ layout, onClose }: { layout: LayoutRow | null; onClose: () => void }) {
  const { t } = useTranslation('siteOps');
  const qc = useQueryClient();
  const [key, setKey] = useState(layout?.key ?? '');
  const [name, setName] = useState(layout?.name ?? '');
  const [html, setHtml] = useState(
    layout?.html ?? '<html><body style="font-family:sans-serif">{{content}}</body></html>',
  );

  const save = useMutation({
    mutationFn: () => {
      const payload = { key, name, html };
      return layout
        ? emailFetch(`/layouts/${layout.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : emailFetch('/layouts', { method: 'POST', body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['email', 'layouts'] });
      onClose();
    },
  });

  // Cmd/Ctrl+S → save this layout (mirrors the Save button's gating).
  useSaveHandler(
    () => save.mutate(),
    !save.isPending && !!key && !!name && html.includes('{{content}}'),
  );

  return (
    <Modal title={layout ? t('email.editLayout') : t('email.newLayout')} onClose={onClose}>
      <Field label={t('email.key')}>
        <input value={key} onChange={(e) => setKey(e.target.value)} className={inputCls} placeholder={t('email.layoutKeyPlaceholder')} />
      </Field>
      <Field label={t('email.name')}>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </Field>
      <Field label={t('email.layoutHtml', { slot: '{{content}}' })}>
        <textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={10} className={`${inputCls} font-mono`} />
      </Field>
      <ModalActions
        saving={save.isPending}
        disabled={!key || !name || !html.includes('{{content}}')}
        onCancel={onClose}
        onSave={() => save.mutate()}
      />
      {save.isError && <p className="text-sm text-destructive">{(save.error as Error).message}</p>}
    </Modal>
  );
}

function TemplateEditor({
  template,
  layouts,
  onClose,
}: {
  template: TemplateRow | null;
  layouts: LayoutRow[];
  onClose: () => void;
}) {
  const { t } = useTranslation('siteOps');
  const qc = useQueryClient();
  const [key, setKey] = useState(template?.key ?? '');
  const [name, setName] = useState(template?.name ?? '');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [bodyHtml, setBodyHtml] = useState(template?.bodyHtml ?? '<p>Hello {{name}},</p>');
  const [layoutId, setLayoutId] = useState(template?.layoutId ?? '');
  const [enabled, setEnabled] = useState(template?.enabled ?? true);
  const [preview, setPreview] = useState<Rendered | null>(null);
  const [previewVars, setPreviewVars] = useState('{\n  "name": "Sam"\n}');

  // Variables referenced by the subject/body (best-effort, client-side).
  const detectedVars = useMemo(() => {
    const found = new Set<string>();
    for (const src of [subject, bodyHtml]) {
      for (const m of src.matchAll(/\{\{\{?\s*([\w.]+)\s*\}?\}\}/g)) {
        const name = m[1];
        if (name && name !== 'content') found.add(name);
      }
    }
    return [...found];
  }, [subject, bodyHtml]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        key,
        name,
        subject,
        bodyHtml,
        layoutId: layoutId || null,
        enabled,
        variables: detectedVars,
      };
      return template
        ? emailFetch(`/templates/${template.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : emailFetch('/templates', { method: 'POST', body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['email', 'templates'] });
      onClose();
    },
  });

  // Cmd/Ctrl+S → save this template (mirrors the Save button's gating).
  useSaveHandler(
    () => save.mutate(),
    !save.isPending && !!key && !!name && !!subject && !!bodyHtml,
  );

  const runPreview = useMutation({
    mutationFn: async () => {
      // Preview an existing key; for an unsaved template, save first is required
      // server-side, so preview targets the stored key.
      let variables: Record<string, unknown> = {};
      try {
        variables = JSON.parse(previewVars || '{}');
      } catch {
        throw new Error(t('email.invalidJson'));
      }
      return emailFetch<Rendered>(`/templates/${encodeURIComponent(key)}/preview`, {
        method: 'POST',
        body: JSON.stringify({ variables }),
      });
    },
    onSuccess: (data) => setPreview(data),
  });

  return (
    <Modal title={template ? t('email.editTemplate') : t('email.newTemplate')} wide onClose={onClose}>
      <div className="grid grid-cols-2 gap-6">
        <div className="space-y-4">
          <Field label={t('email.key')}>
            <input value={key} onChange={(e) => setKey(e.target.value)} className={inputCls} placeholder={t('email.templateKeyPlaceholder')} />
          </Field>
          <Field label={t('email.name')}>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </Field>
          <Field label={t('email.subject')}>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className={inputCls} />
          </Field>
          <Field label={t('email.layout')}>
            <select value={layoutId} onChange={(e) => setLayoutId(e.target.value)} className={inputCls}>
              <option value="">{t('email.noLayout')}</option>
              {layouts.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.key})
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('email.bodyHtml')}>
            <textarea value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} rows={8} className={`${inputCls} font-mono`} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t('email.enabled')}
          </label>
          {detectedVars.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('email.variables')} {detectedVars.map((v) => <code key={v} className="mr-1">{`{{${v}}}`}</code>)}
            </p>
          )}
        </div>

        <div className="space-y-3">
          <Field label={t('email.sampleVariables')}>
            <textarea value={previewVars} onChange={(e) => setPreviewVars(e.target.value)} rows={4} className={`${inputCls} font-mono`} />
          </Field>
          <button
            type="button"
            onClick={() => runPreview.mutate()}
            disabled={!key || runPreview.isPending}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <Eye className="h-4 w-4" /> {runPreview.isPending ? t('email.rendering') : t('email.preview')}
          </button>
          {runPreview.isError && <p className="text-sm text-destructive">{(runPreview.error as Error).message}</p>}
          {preview && (
            <div className="rounded-md border">
              <div className="border-b bg-muted px-3 py-2 text-sm font-medium">{preview.subject}</div>
              <iframe title={t('email.previewFrame')} srcDoc={preview.html} className="h-72 w-full" />
              {preview.missing.length > 0 && (
                <p className="border-t px-3 py-2 text-xs text-amber-600">
                  {t('email.missingVariables', { names: preview.missing.join(', ') })}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <ModalActions
        saving={save.isPending}
        disabled={!key || !name || !subject || !bodyHtml}
        onCancel={onClose}
        onSave={() => save.mutate()}
      />
      {save.isError && <p className="text-sm text-destructive">{(save.error as Error).message}</p>}
    </Modal>
  );
}

// ── Small shared UI primitives ──────────────────────────────────────────

const inputCls = 'w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const { t } = useTranslation('siteOps');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className={`w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} max-h-[90vh] overflow-y-auto rounded-xl border bg-background p-6 shadow-lg`}>
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        <div className="space-y-4">{children}</div>
      </div>
      <button type="button" aria-label={t('common:close')} className="sr-only" onClick={onClose} />
    </div>
  );
}

function ModalActions({
  saving,
  disabled,
  onCancel,
  onSave,
}: {
  saving: boolean;
  disabled: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation('siteOps');
  return (
    <div className="mt-6 flex justify-end gap-2">
      <button type="button" onClick={onCancel} className="rounded-md px-4 py-2 text-sm font-medium hover:bg-muted">
        {t('common:cancel')}
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={disabled || saving}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        <Save className="h-4 w-4" /> {saving ? t('site.saving') : t('common:save')}
      </button>
    </div>
  );
}

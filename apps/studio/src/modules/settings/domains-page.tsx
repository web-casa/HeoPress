// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DomainResource, DomainUpdateInput } from '@heopress/sdk';
import {
  Globe,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  Check,
  Copy,
  AlertTriangle,
  ExternalLink,
  KeyRound,
  Languages,
  Power,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';

/**
 * Free subdomain suffix shown in the form. A reserved placeholder: the CMS only
 * offers free subdomains when the operator sets HEOPRESS_FREE_DOMAIN_SUFFIX and
 * otherwise answers FREE_SUBDOMAIN_NOT_CONFIGURED (domain model rework: P05).
 */
const FREE_SUFFIX = 'heopress.example';

/** Link to the enterprise docs section for custom domains. */
const DOCS_URL = 'https://docs.heopress.example/enterprise/custom-domains/setup-custom-domain';

export function DomainsSettingsPage() {
  const { t } = useTranslation('siteOps');
  const client = getApiClient();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['domains'],
    queryFn: async () => (await client.domains.list()).data,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['domains'] });

  const verify = useMutation({
    mutationFn: (id: string) => client.domains.verify(id),
    onSuccess: invalidate,
  });
  const setPrimary = useMutation({
    mutationFn: (id: string) => client.domains.setPrimary(id),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.domains.delete(id),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: DomainUpdateInput }) => client.domains.update(id, patch),
    onSuccess: invalidate,
  });
  const newToken = useMutation({
    mutationFn: (id: string) => client.domains.newToken(id),
    onSuccess: invalidate,
  });

  // The last failure per domain (verification not found yet, token expired, …).
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const run = (id: string, action: () => Promise<unknown>) => {
    setRowErrors(({ [id]: _cleared, ...rest }) => rest);
    action().catch((err: unknown) => {
      setRowErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : t('domains.genericError') }));
      void invalidate();
    });
  };
  const busy = verify.isPending || setPrimary.isPending || remove.isPending || update.isPending || newToken.isPending;
  const actionsFor = (d: DomainResource): RowActions => ({
    onVerify: () => run(d.id, () => verify.mutateAsync(d.id)),
    onPrimary: () => run(d.id, () => setPrimary.mutateAsync(d.id)),
    onRemove: () => {
      if (window.confirm(t('domains.confirmRemove', { hostname: d.hostname }))) run(d.id, () => remove.mutateAsync(d.id));
    },
    onToggle: () => run(d.id, () => update.mutateAsync({ id: d.id, patch: { status: d.status === 'active' ? 'disabled' : 'active' } })),
    onNewToken: () => run(d.id, () => newToken.mutateAsync(d.id)),
    onEntryLocale: (entryLocale: string | null) => run(d.id, () => update.mutateAsync({ id: d.id, patch: { entryLocale } })),
  });

  const [dialogOpen, setDialogOpen] = useState(false);

  const domains = query.data ?? [];
  const subdomains = domains.filter((d) => d.kind === 'subdomain');
  const custom = domains.filter((d) => d.kind === 'custom');

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">{t('domains.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('domains.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> {t('domains.setup')}
        </button>
      </header>

      {query.isLoading ? (
        <p className="text-muted-foreground">{t('common:loading')}</p>
      ) : query.isError ? (
        <p className="text-destructive">{t('domains.loadFailed')}</p>
      ) : (
        <>
          <Section icon={Globe} title={t('domains.freeSubdomain')}>
            {subdomains.length === 0 ? (
              <EmptyHint>
                <Trans t={t} i18nKey="domains.noSubdomain" components={{ b: <strong /> }} />
              </EmptyHint>
            ) : (
              <ul className="space-y-2">
                {subdomains.map((d) => (
                  <DomainRow
                    key={d.id}
                    domain={d}
                    actions={actionsFor(d)}
                    error={rowErrors[d.id] ?? null}
                    busy={busy}
                  />
                ))}
              </ul>
            )}
          </Section>

          <Section icon={Globe} title={t('domains.customDomains')}>
            {custom.length === 0 ? (
              <EmptyHint>
                <Trans t={t} i18nKey="domains.noCustom" components={{ code: <code className="font-mono" /> }} />
              </EmptyHint>
            ) : (
              <ul className="space-y-4">
                {custom.map((d) => (
                  <DomainRow
                    key={d.id}
                    domain={d}
                    actions={actionsFor(d)}
                    error={rowErrors[d.id] ?? null}
                    busy={busy}
                  />
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      {dialogOpen ? (
        <SetupDialog
          onClose={() => setDialogOpen(false)}
          onCreated={() => {
            invalidate();
            setDialogOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

// ── Domain row ─────────────────────────────────────────────────────────────
interface RowActions {
  onVerify: () => void;
  onPrimary: () => void;
  onRemove: () => void;
  onToggle: () => void;
  onNewToken: () => void;
  onEntryLocale: (locale: string | null) => void;
}

function DomainRow({
  domain,
  actions,
  error,
  busy,
}: {
  domain: DomainResource;
  actions: RowActions;
  error: string | null;
  busy: boolean;
}) {
  const { t } = useTranslation('siteOps');
  const [editingEntry, setEditingEntry] = useState(false);
  const pending = domain.status === 'pending';
  const expired = pending && domain.verificationExpiresAt !== null && Date.parse(domain.verificationExpiresAt) <= Date.now();
  return (
    <li className="rounded-lg border p-3" aria-label={domain.hostname}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm">{domain.hostname}</span>
          {domain.isPrimary ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              <Star className="h-3 w-3" /> {t('domains.primary')}
            </span>
          ) : null}
          <StatusBadge status={domain.status} />
          {domain.entryLocale ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-700">
              <Languages className="h-3 w-3" /> {t('domains.languageEntryValue', { locale: domain.entryLocale })}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {pending ? <IconBtn label={t('domains.verify')} onClick={actions.onVerify} disabled={busy} icon={RefreshCw} /> : null}
          {pending ? <IconBtn label={t('domains.newToken')} onClick={actions.onNewToken} disabled={busy} icon={KeyRound} /> : null}
          {domain.status === 'active' && !domain.isPrimary ? (
            <IconBtn label={t('domains.setPrimary')} onClick={actions.onPrimary} disabled={busy} icon={Star} />
          ) : null}
          {domain.kind === 'custom' && !domain.isPrimary && (domain.status === 'active' || (domain.status === 'disabled' && domain.verifiedAt)) ? (
            <IconBtn
              label={domain.status === 'active' ? t('domains.disable') : t('domains.enable')}
              onClick={actions.onToggle}
              disabled={busy}
              icon={Power}
            />
          ) : null}
          <IconBtn label={t('domains.languageEntry')} onClick={() => setEditingEntry((v) => !v)} disabled={busy} icon={Languages} />
          <IconBtn label={t('domains.remove')} onClick={actions.onRemove} disabled={busy} icon={Trash2} danger />
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : domain.statusReason ? (
        <p className="mt-2 text-xs text-muted-foreground">{domain.statusReason}</p>
      ) : null}

      {editingEntry ? (
        <EntryLocaleForm
          initial={domain.entryLocale}
          onSave={(locale) => {
            actions.onEntryLocale(locale);
            setEditingEntry(false);
          }}
          onCancel={() => setEditingEntry(false)}
        />
      ) : null}

      {pending && domain.verification.records.length > 0 ? (
        <div className="mt-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            {domain.verificationMethod === 'http_file'
              ? t('domains.httpInstructions')
              : t('domains.dnsInstructions')}
          </p>
          <DnsRecords records={domain.verification.records} />
          {domain.verificationExpiresAt ? (
            <p className={`text-xs ${expired ? 'text-destructive' : 'text-muted-foreground'}`}>
              {expired
                ? t('domains.tokenExpired')
                : t('domains.tokenValidUntil', { date: new Date(domain.verificationExpiresAt).toLocaleString() })}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function EntryLocaleForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: string | null;
  onSave: (locale: string | null) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('siteOps');
  const id = useId();
  const [value, setValue] = useState(initial ?? '');
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value.trim() || null);
      }}
    >
      <div className="space-y-1">
        <label htmlFor={id} className="block text-xs font-medium">
          {t('domains.entryLocaleLabel')}
        </label>
        <input
          id={id}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('domains.localePlaceholder')}
          className="block w-40 rounded-md border border-input bg-background px-2 py-1 font-mono text-sm"
        />
      </div>
      <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
        {t('domains.saveLanguage')}
      </button>
      <button type="button" onClick={onCancel} className="rounded-md border px-3 py-1.5 text-xs">
        {t('common:cancel')}
      </button>
    </form>
  );
}

// ── Setup dialog ─────────────────────────────────────────────────────────────
function SetupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation('siteOps');
  const client = getApiClient();
  const kindId = useId();
  const hostId = useId();
  const [kind, setKind] = useState<'subdomain' | 'custom'>('custom');
  const methodId = useId();
  const localeId = useId();
  const [hostname, setHostname] = useState('');
  const [method, setMethod] = useState<'dns_txt' | 'http_file'>('dns_txt');
  const [entryLocale, setEntryLocale] = useState('');
  const [created, setCreated] = useState<DomainResource | null>(null);

  const create = useMutation({
    mutationFn: () =>
      client.domains.create({
        kind,
        hostname: hostname.trim().toLowerCase(),
        ...(kind === 'custom' ? { verificationMethod: method } : {}),
        entryLocale: entryLocale.trim() || null,
      }),
    onSuccess: (res) => setCreated(res.data),
  });

  const errorMsg = create.isError
    ? /DOMAIN_TAKEN/i.test(String(create.error))
      ? t('site.domainTaken')
      : /VALIDATION/i.test(String(create.error))
        ? kind === 'subdomain'
          ? t('domains.invalidLabel')
          : t('domains.invalidDomain')
        : create.error instanceof Error
          ? create.error.message
          : t('domains.createFailed')
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {created ? (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">
              {created.status === 'active' ? t('domains.ready') : t('domains.almostThere')}
            </h2>
            {created.status === 'active' ? (
              <p className="text-sm text-muted-foreground">
                <Trans t={t} i18nKey="domains.isLive" values={{ hostname: created.hostname }} components={{ code: <code className="font-mono" /> }} />
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  <Trans
                    t={t}
                    i18nKey={created.verificationMethod === 'http_file' ? 'domains.createdHttp' : 'domains.createdDns'}
                    values={{ hostname: created.hostname }}
                    components={{ code: <code className="font-mono" /> }}
                  />
                </p>
                <DnsRecords records={created.verification.records} />
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  {t('domains.guide')} <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onCreated}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('domains.done')}
              </button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <h2 className="text-lg font-semibold">{t('domains.setupTitle')}</h2>

            <div className="space-y-1">
              <label htmlFor={kindId} className="block text-sm font-medium">
                {t('domains.type')}
              </label>
              <select
                id={kindId}
                value={kind}
                onChange={(e) => setKind(e.target.value as 'subdomain' | 'custom')}
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="custom">{t('domains.kindCustom')}</option>
                <option value="subdomain">{t('domains.kindSubdomain', { suffix: FREE_SUFFIX })}</option>
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor={hostId} className="block text-sm font-medium">
                {kind === 'subdomain' ? t('domains.subdomainLabel') : t('domains.domain')}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={hostId}
                  autoFocus
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  placeholder={kind === 'subdomain' ? t('domains.subdomainPlaceholder') : t('domains.domainPlaceholder')}
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                />
                {kind === 'subdomain' ? (
                  <span className="shrink-0 font-mono text-sm text-muted-foreground">
                    .{FREE_SUFFIX}
                  </span>
                ) : null}
              </div>
              {errorMsg ? <p className="text-xs text-destructive">{errorMsg}</p> : null}
            </div>

            {kind === 'custom' ? (
              <div className="space-y-1">
                <label htmlFor={methodId} className="block text-sm font-medium">
                  {t('domains.proveWith')}
                </label>
                <select
                  id={methodId}
                  value={method}
                  onChange={(e) => setMethod(e.target.value as 'dns_txt' | 'http_file')}
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="dns_txt">{t('domains.methodDns')}</option>
                  <option value="http_file">{t('domains.methodHttp')}</option>
                </select>
              </div>
            ) : null}

            <div className="space-y-1">
              <label htmlFor={localeId} className="block text-sm font-medium">
                {t('domains.languageEntryOptional')}
              </label>
              <input
                id={localeId}
                value={entryLocale}
                onChange={(e) => setEntryLocale(e.target.value)}
                placeholder={t('domains.localePlaceholder')}
                className="block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {t('domains.languageEntryHelp')}
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
              >
                {t('common:cancel')}
              </button>
              <button
                type="submit"
                disabled={create.isPending || hostname.trim().length === 0}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {create.isPending ? t('domains.creating') : t('domains.create')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ── DNS records table ─────────────────────────────────────────────────────────
function DnsRecords({ records }: { records: DomainResource['verification']['records'] }) {
  const { t } = useTranslation('siteOps');
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">{t('domains.type')}</th>
            <th className="px-2 py-1.5 font-medium">{t('domains.recordName')}</th>
            <th className="px-2 py-1.5 font-medium">{t('domains.recordValue')}</th>
            <th className="px-2 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => (
            <tr key={`${r.type}-${i}`} className="border-t">
              <td className="px-2 py-1.5 font-mono">{r.type}</td>
              <td className="max-w-[8rem] truncate px-2 py-1.5 font-mono" title={r.name}>
                {r.name}
              </td>
              <td className="max-w-[12rem] truncate px-2 py-1.5 font-mono" title={r.value}>
                {r.value}
              </td>
              <td className="px-2 py-1.5">
                <CopyButton value={r.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation('siteOps');
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={t('domains.copyValue')}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

// ── Primitives ─────────────────────────────────────────────────────────────
const STATUS_STYLE: Record<DomainResource['status'], { label: string; cls: string }> = {
  active: { label: 'domains.status.active', cls: 'bg-emerald-500/10 text-emerald-600' },
  pending: { label: 'domains.status.pending', cls: 'bg-amber-500/10 text-amber-600' },
  disabled: { label: 'domains.status.disabled', cls: 'bg-muted text-muted-foreground' },
  failed: { label: 'domains.status.failed', cls: 'bg-destructive/10 text-destructive' },
};

function StatusBadge({ status }: { status: DomainResource['status'] }) {
  const { t } = useTranslation('siteOps');
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {t(s.label)}
    </span>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  icon: Icon,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon: LucideIcon;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md p-2 transition hover:bg-accent disabled:opacity-40 ${
        danger ? 'text-destructive hover:bg-destructive/10' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export default DomainsSettingsPage;

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
      setRowErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : 'Something went wrong.' }));
      void invalidate();
    });
  };
  const busy = verify.isPending || setPrimary.isPending || remove.isPending || update.isPending || newToken.isPending;
  const actionsFor = (d: DomainResource): RowActions => ({
    onVerify: () => run(d.id, () => verify.mutateAsync(d.id)),
    onPrimary: () => run(d.id, () => setPrimary.mutateAsync(d.id)),
    onRemove: () => {
      if (window.confirm(`Remove ${d.hostname}? It stops serving this site.`)) run(d.id, () => remove.mutateAsync(d.id));
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
          <h1 className="text-3xl font-semibold tracking-tight">Domains</h1>
          <p className="text-sm text-muted-foreground">
            Connect the domains this site serves on. A domain serves nothing until you prove it is
            yours; its certificate is issued on the first HTTPS visit after that. Other domains
            redirect to the primary one, except language entries, which keep their own address.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Setup domain
        </button>
      </header>

      {query.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : query.isError ? (
        <p className="text-destructive">Failed to load domains.</p>
      ) : (
        <>
          <Section icon={Globe} title="Free subdomain">
            {subdomains.length === 0 ? (
              <EmptyHint>
                No free subdomain yet. Use <strong>Setup domain</strong> and pick “Free subdomain”.
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

          <Section icon={Globe} title="Custom domains">
            {custom.length === 0 ? (
              <EmptyHint>
                Connect a domain you own (e.g. <code className="font-mono">cms.acme.com</code>).
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
              <Star className="h-3 w-3" /> Primary
            </span>
          ) : null}
          <StatusBadge status={domain.status} />
          {domain.entryLocale ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-700">
              <Languages className="h-3 w-3" /> Language entry: {domain.entryLocale}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {pending ? <IconBtn label="Verify" onClick={actions.onVerify} disabled={busy} icon={RefreshCw} /> : null}
          {pending ? <IconBtn label="New token" onClick={actions.onNewToken} disabled={busy} icon={KeyRound} /> : null}
          {domain.status === 'active' && !domain.isPrimary ? (
            <IconBtn label="Set primary" onClick={actions.onPrimary} disabled={busy} icon={Star} />
          ) : null}
          {domain.kind === 'custom' && !domain.isPrimary && (domain.status === 'active' || (domain.status === 'disabled' && domain.verifiedAt)) ? (
            <IconBtn
              label={domain.status === 'active' ? 'Disable' : 'Enable'}
              onClick={actions.onToggle}
              disabled={busy}
              icon={Power}
            />
          ) : null}
          <IconBtn label="Language entry" onClick={() => setEditingEntry((v) => !v)} disabled={busy} icon={Languages} />
          <IconBtn label="Remove" onClick={actions.onRemove} disabled={busy} icon={Trash2} danger />
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
              ? 'Serve this text at this address from the server that hosts the domain now — before pointing it at HeoPress — then click Verify. (Already pointing here? Use the DNS TXT method instead.)'
              : 'Add these records at your DNS provider, then click Verify:'}
          </p>
          <DnsRecords records={domain.verification.records} />
          {domain.verificationExpiresAt ? (
            <p className={`text-xs ${expired ? 'text-destructive' : 'text-muted-foreground'}`}>
              {expired
                ? 'This token has expired. Get a new token and publish it instead.'
                : `Token valid until ${new Date(domain.verificationExpiresAt).toLocaleString()}.`}
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
          Language served on this domain (empty: none)
        </label>
        <input
          id={id}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="en"
          className="block w-40 rounded-md border border-input bg-background px-2 py-1 font-mono text-sm"
        />
      </div>
      <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
        Save language
      </button>
      <button type="button" onClick={onCancel} className="rounded-md border px-3 py-1.5 text-xs">
        Cancel
      </button>
    </form>
  );
}

// ── Setup dialog ─────────────────────────────────────────────────────────────
function SetupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
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
      ? 'That domain is already in use.'
      : /VALIDATION/i.test(String(create.error))
        ? kind === 'subdomain'
          ? 'Enter a single label like “acme”.'
          : 'Enter a valid domain like cms.example.com.'
        : create.error instanceof Error
          ? create.error.message
          : 'Could not create the domain.'
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
              {created.status === 'active' ? 'Domain ready' : 'Almost there'}
            </h2>
            {created.status === 'active' ? (
              <p className="text-sm text-muted-foreground">
                <code className="font-mono">{created.hostname}</code> is live.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {created.verificationMethod === 'http_file'
                    ? 'Serve this from the server that hosts '
                    : 'Add these records at your DNS provider for '}
                  <code className="font-mono">{created.hostname}</code>, then click Verify on the domain. Once
                  it is verified, its certificate is issued on the first HTTPS visit.
                </p>
                <DnsRecords records={created.verification.records} />
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Step-by-step guide <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onCreated}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Done
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
            <h2 className="text-lg font-semibold">Setup a domain</h2>

            <div className="space-y-1">
              <label htmlFor={kindId} className="block text-sm font-medium">
                Type
              </label>
              <select
                id={kindId}
                value={kind}
                onChange={(e) => setKind(e.target.value as 'subdomain' | 'custom')}
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="custom">Custom domain (your own)</option>
                <option value="subdomain">Free subdomain ({FREE_SUFFIX})</option>
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor={hostId} className="block text-sm font-medium">
                {kind === 'subdomain' ? 'Subdomain label' : 'Domain'}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={hostId}
                  autoFocus
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  placeholder={kind === 'subdomain' ? 'acme' : 'cms.acme.com'}
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
                  Prove it is yours with
                </label>
                <select
                  id={methodId}
                  value={method}
                  onChange={(e) => setMethod(e.target.value as 'dns_txt' | 'http_file')}
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="dns_txt">A DNS TXT record</option>
                  <option value="http_file">A file on the current web server</option>
                </select>
              </div>
            ) : null}

            <div className="space-y-1">
              <label htmlFor={localeId} className="block text-sm font-medium">
                Language entry (optional)
              </label>
              <input
                id={localeId}
                value={entryLocale}
                onChange={(e) => setEntryLocale(e.target.value)}
                placeholder="en"
                className="block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                A language entry serves that language on its own address and is never redirected.
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={create.isPending || hostname.trim().length === 0}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {create.isPending ? 'Creating…' : 'Create'}
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
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">Type</th>
            <th className="px-2 py-1.5 font-medium">Name</th>
            <th className="px-2 py-1.5 font-medium">Value</th>
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
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy value"
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
  active: { label: 'Active', cls: 'bg-emerald-500/10 text-emerald-600' },
  pending: { label: 'Pending verification', cls: 'bg-amber-500/10 text-amber-600' },
  disabled: { label: 'Disabled', cls: 'bg-muted text-muted-foreground' },
  failed: { label: 'Failed', cls: 'bg-destructive/10 text-destructive' },
};

function StatusBadge({ status }: { status: DomainResource['status'] }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
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

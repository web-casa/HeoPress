// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { Puzzle, Download, Search, Check, ExternalLink, ShieldAlert, ShieldCheck, Info, X, User, ArrowBigUp, Upload } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { PageHeader } from '@/workspace/ui/page-header';
import { PermissionApprovalDialog, PermissionList, apiErrorMessage } from './extension-permissions';

/** Example values shown as placeholders; not translated. */
const EXAMPLES = { slug: 'my-extension', bundleUrl: 'https://…/bundle.js', repositoryUrl: 'https://github.com/…' };
const SIGNATURE_ALGS = ['ed25519', 'rsa-pss-sha256'];

interface PublishedExtension {
  id: string;
  name: string;
  version: string;
  type: string;
  publisher: string;
  marketplaceSlug: string;
  publishedAt: string;
  /** Cryptographically signed by a registered publisher key. */
  verified?: boolean;
  /** Cumulative package downloads. */
  totalDownloads?: number;
  /** Community upvotes for the listing. */
  voteCount?: number;
  /** Whether the current user has upvoted. */
  hasVoted?: boolean;
}

interface ExtensionDetail extends PublishedExtension {
  manifest: {
    description?: string;
  };
  /** What installing asks the admin to approve (HeoPress P12). */
  requestedCapabilities?: string[];
  bundleUrl: string;
  bundleSha256: string;
  signature: string;
  signatureAlg: string;
  publisherKeyId: string;
}

/**
 * Publish dialog (studio-ops-ui task 3; Req 3): completes the publish loop
 * in the UI — pick a registered extension, attach slug + signing material,
 * POST /marketplace/publish. Signature fields are pass-through: signing
 * happens offline with the publisher key; this form only carries the result.
 */
function PublishDialog({
  extensions,
  onClose,
}: {
  extensions: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const { t } = useTranslation('system');
  const client = getApiClient();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    extensionId: '',
    marketplaceSlug: '',
    publisher: '',
    signature: '',
    signatureAlg: 'ed25519',
    publisherKeyId: '',
    bundleSha256: '',
  });

  const mutation = useMutation({
    mutationFn: () =>
      client.rawRequest<unknown>('/api/v1/marketplace/publish', {
        method: 'POST',
        body: JSON.stringify(form),
        headers: { 'Content-Type': 'application/json' },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['marketplace-extensions'] });
      onClose();
    },
  });

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const valid =
    form.extensionId &&
    /^[a-z0-9-]+$/.test(form.marketplaceSlug) &&
    form.publisher &&
    form.signature &&
    form.publisherKeyId &&
    /^[0-9a-f]{64}$/.test(form.bundleSha256);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      role="dialog"
      aria-label={t('marketplace.publish')}
    >
      <div className="max-h-[85vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-card border border-line bg-panel p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="t-section">{t('marketplace.publish')}</h2>
          <button type="button" onClick={onClose} aria-label={t('marketplace.closePublish')} className="rounded-ctl border border-line p-1 hover:bg-panel-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="block text-xs">
          <span className="mb-1 block text-dim">{t('marketplace.fields.extension')} *</span>
          <select
            value={form.extensionId}
            onChange={set('extensionId')}
            aria-label={t('marketplace.extensionToPublish')}
            className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5"
          >
            <option value="">{t('marketplace.choose')}</option>
            {extensions.map((ext) => (
              <option key={ext.id} value={ext.id}>
                {ext.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs">
            <span className="mb-1 block text-dim">{t('marketplace.fields.slug')} *</span>
            <input value={form.marketplaceSlug} onChange={set('marketplaceSlug')} placeholder={EXAMPLES.slug} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-dim">{t('marketplace.fields.publisher')} *</span>
            <input value={form.publisher} onChange={set('publisher')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-dim">{t('marketplace.fields.signatureAlg')}</span>
            <select value={form.signatureAlg} onChange={set('signatureAlg')} aria-label={t('marketplace.fields.signatureAlgorithm')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5">
              {SIGNATURE_ALGS.map((alg) => (
                <option key={alg} value={alg}>
                  {alg}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-dim">{t('marketplace.fields.publisherKeyId')} *</span>
            <input value={form.publisherKeyId} onChange={set('publisherKeyId')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="mb-1 block text-dim">{t('marketplace.fields.bundleSignature')} *</span>
            <input value={form.signature} onChange={set('signature')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="mb-1 block text-dim">{t('marketplace.fields.bundleSha')} *</span>
            <input value={form.bundleSha256} onChange={set('bundleSha256')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono" />
          </label>
        </div>
        {mutation.isError && (
          <p className="text-xs text-bad">
            {mutation.error instanceof Error ? mutation.error.message : t('marketplace.publishFailed')}
          </p>
        )}
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={!valid || mutation.isPending}
          className="rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg hover:opacity-90 disabled:opacity-50"
        >
          {mutation.isPending ? t('marketplace.publishing') : t('marketplace.publishToCatalog')}
        </button>
      </div>
    </div>
  );
}

/**
 * Community submit dialog: lets any user propose an extension for the public
 * catalog. The listing lands in `pending` review (unpublished) — publishing a
 * signed bundle is a separate, moderated step.
 */
function SubmitDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('system');
  const client = getApiClient();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    version: '0.1.0',
    type: 'module',
    marketplaceSlug: '',
    bundleUrl: '',
    description: '',
    publisher: '',
    repositoryUrl: '',
  });

  const mutation = useMutation({
    mutationFn: () =>
      client.rawRequest<unknown>('/api/v1/marketplace/submit', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          repositoryUrl: form.repositoryUrl || undefined,
          description: form.description || undefined,
          publisher: form.publisher || undefined,
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['marketplace-extensions'] });
      onClose();
    },
  });

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const valid =
    form.name &&
    /^\d+\.\d+\.\d+/.test(form.version) &&
    /^[a-z0-9-]+$/.test(form.marketplaceSlug) &&
    /^https?:\/\//.test(form.bundleUrl);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      role="dialog"
      aria-label={t('marketplace.submit')}
    >
      <div className="max-h-[85vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-card border border-line bg-panel p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="t-section">{t('marketplace.submitTitle')}</h2>
          <button type="button" onClick={onClose} aria-label={t('marketplace.closeSubmit')} className="rounded-ctl border border-line p-1 hover:bg-panel-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-dim">
          {t('marketplace.submitBody')}
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs">
            <span className="mb-1 block text-dim">{t('marketplace.fields.name')} *</span>
            <input value={form.name} onChange={set('name')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-dim">{t('marketplace.fields.version')} *</span>
            <input value={form.version} onChange={set('version')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-dim">{t('marketplace.fields.type')} *</span>
            <select value={form.type} onChange={set('type')} aria-label={t('marketplace.fields.extensionType')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5">
              {['module', 'interface', 'display', 'layout', 'panel', 'endpoint', 'hook', 'operation'].map((tp) => (
                <option key={tp} value={tp}>{t(`marketplace.types.${tp}`)}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-dim">{t('marketplace.fields.slug')} *</span>
            <input value={form.marketplaceSlug} onChange={set('marketplaceSlug')} placeholder={EXAMPLES.slug} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="mb-1 block text-dim">{t('marketplace.fields.bundleUrl')} *</span>
            <input value={form.bundleUrl} onChange={set('bundleUrl')} placeholder={EXAMPLES.bundleUrl} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-dim">{t('marketplace.fields.publisher')}</span>
            <input value={form.publisher} onChange={set('publisher')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-dim">{t('marketplace.fields.repositoryUrl')}</span>
            <input value={form.repositoryUrl} onChange={set('repositoryUrl')} placeholder={EXAMPLES.repositoryUrl} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="mb-1 block text-dim">{t('marketplace.fields.description')}</span>
            <textarea value={form.description} onChange={set('description')} rows={3} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5" />
          </label>
        </div>
        {mutation.isError && (
          <p className="text-xs text-bad">
            {mutation.error instanceof Error ? mutation.error.message : t('marketplace.submitFailed')}
          </p>
        )}
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={!valid || mutation.isPending}
          className="rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg hover:opacity-90 disabled:opacity-50"
        >
          {mutation.isPending ? t('marketplace.submitting') : t('marketplace.submitForReview')}
        </button>
      </div>
    </div>
  );
}

export function MarketplacePage() {
  const { t } = useTranslation(['system', 'common']);
  const client = getApiClient();
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [publishing, setPublishing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Fetch installed extensions
  const installedQuery = useQuery({
    queryKey: ['extensions'],
    queryFn: async () => (await client.extensions.list()).data,
  });

  // Fetch published extensions from marketplace
  const marketplaceQuery = useQuery({
    queryKey: ['marketplace-extensions'],
    queryFn: async () => {
      const resp = await client.rawRequest<PublishedExtension[]>('/api/v1/marketplace/extensions');
      return resp.data;
    },
  });

  // Fetch single extension detail if selected
  const detailQuery = useQuery({
    queryKey: ['marketplace-extension-detail', selectedSlug],
    queryFn: async () => {
      if (!selectedSlug) return null;
      const resp = await client.rawRequest<ExtensionDetail>(`/api/v1/marketplace/extensions/${selectedSlug}`);
      return resp.data;
    },
    enabled: !!selectedSlug,
  });

  // Install mutation: sends exactly the capabilities the admin approved in the dialog (HeoPress P12).
  const [installTarget, setInstallTarget] = useState<{ slug: string; name: string; capabilities: string[] } | null>(null);
  const installMutation = useMutation({
    mutationFn: ({ slug, capabilities }: { slug: string; capabilities: string[] }) =>
      client.rawRequest<unknown>(`/api/v1/marketplace/extensions/${slug}/install`, {
        method: 'POST',
        body: JSON.stringify({ approvedCapabilities: capabilities }),
        headers: { 'Content-Type': 'application/json' },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['extensions'] });
      void qc.invalidateQueries({ queryKey: ['marketplace-extensions'] });
      setInstallTarget(null);
      setSelectedSlug(null);
    },
  });

  // Toggle upvote — DELETE when already voted, POST otherwise.
  const voteMutation = useMutation({
    mutationFn: ({ slug, hasVoted }: { slug: string; hasVoted: boolean }) =>
      client.rawRequest<unknown>(`/api/v1/marketplace/extensions/${slug}/vote`, {
        method: hasVoted ? 'DELETE' : 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['marketplace-extensions'] });
      void qc.invalidateQueries({ queryKey: ['marketplace-extension-detail'] });
    },
  });

  // Download the signed package without installing. The endpoint bumps the
  // download counter and 302s to the bundle.
  const handleDownload = (slug: string) => {
    window.open(`/api/v1/marketplace/extensions/${slug}/download`, '_blank', 'noopener');
    void qc.invalidateQueries({ queryKey: ['marketplace-extensions'] });
  };

  const published = marketplaceQuery.data ?? [];
  const installed = installedQuery.data ?? [];

  // Map installed extensions by slug for quick lookup
  const installedSlugs = new Set(
    installed
      .map((ext) => (ext as any).marketplaceSlug)
      .filter((slug): slug is string => !!slug)
  );

  const filtered = published.filter((ext) => {
    const matchesSearch =
      ext.name.toLowerCase().includes(search.toLowerCase()) ||
      ext.publisher.toLowerCase().includes(search.toLowerCase()) ||
      ext.marketplaceSlug.toLowerCase().includes(search.toLowerCase());
    
    const matchesType = filterType === 'all' || ext.type === filterType;

    return matchesSearch && matchesType;
  });

  /** Open the permission dialog with what the listing requests. */
  const handleInstall = async (slug: string) => {
    installMutation.reset();
    const resp = await client.rawRequest<ExtensionDetail>(`/api/v1/marketplace/extensions/${slug}`);
    setInstallTarget({ slug, name: resp.data.name, capabilities: resp.data.requestedCapabilities ?? [] });
  };

  const selectedExtension = detailQuery.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={<span className="flex items-center gap-2"><Puzzle className="h-5 w-5 text-brand" /> {t('marketplace.title')}</span>}
        description={t('marketplace.description')}
        actions={
          <>
            <div className="flex items-center gap-2 self-start">
          {/* Community submission loop */}
          <button
            type="button"
            onClick={() => setSubmitting(true)}
            className="inline-flex items-center gap-1 rounded-ctl border border-line px-3 py-2 text-sm font-medium hover:bg-panel-2"
          >
            <Upload className="h-4 w-4" /> {t('marketplace.submit')}
          </button>
          {/* Publish loop (studio-ops-ui Req 3) */}
          <button
            type="button"
            onClick={() => setPublishing(true)}
            className="inline-flex items-center gap-1 rounded-ctl border border-line px-3 py-2 text-sm font-medium hover:bg-panel-2"
          >
            <ExternalLink className="h-4 w-4" /> {t('marketplace.publish')}
          </button>
        </div>
          </>
        }
      />

      {submitting && <SubmitDialog onClose={() => setSubmitting(false)} />}

      {publishing && (
        <PublishDialog
          extensions={installed.map((ext) => ({
            id: (ext as { id: string }).id,
            name: (ext as { name: string }).name,
          }))}
          onClose={() => setPublishing(false)}
        />
      )}

      {/* Filter and Search Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-dim" />
          <input
            type="text"
            placeholder={t('marketplace.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-card border bg-panel pl-9 pr-4 py-2 text-sm outline-none transition focus:border-brand focus:ring-1 focus:ring-brand"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-dim">{t('marketplace.filterType')}</span>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="rounded-card border bg-panel px-3 py-1.5 text-sm outline-none transition focus:border-brand"
          >
            <option value="all">{t('marketplace.allTypes')}</option>
            {['module', 'interface', 'display', 'layout', 'panel', 'endpoint'].map((tp) => (
              <option key={tp} value={tp}>
                {t(`marketplace.types.${tp}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Grid Content */}
      {marketplaceQuery.isLoading || installedQuery.isLoading ? (
        <div className="flex items-center justify-center p-12">
          <span className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-card border border-dashed p-12 text-center text-dim bg-panel-2">
          <Puzzle className="mx-auto h-12 w-12 text-dim mb-3" />
          <h3 className="font-semibold text-lg text-fg">{t('marketplace.noneFound')}</h3>
          <p className="text-sm mt-1">{t('marketplace.noneFoundHint')}</p>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((ext) => {
            const isInstalled = installedSlugs.has(ext.marketplaceSlug);
            return (
              <div
                key={ext.id}
                className="group relative flex flex-col justify-between rounded-card border bg-panel p-5 transition hover:shadow-md hover:border-brand/50"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-card bg-brand-soft text-brand border border-brand/10 group-hover:bg-brand group-hover:text-brand-fg transition-colors duration-200">
                      <Puzzle className="h-6 w-6" />
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="inline-flex items-center rounded-full bg-panel-2 px-2.5 py-0.5 text-xs font-semibold text-fg border border-line border-secondary-foreground/10 capitalize">
                        {ext.type}
                      </span>
                      {ext.verified && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft border border-ok/40 px-2 py-0.5 text-[10px] font-bold text-ok" title={t('marketplace.verifiedSource')}>
                          <ShieldCheck className="h-3 w-3" />
                          {t('marketplace.verified')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-4">
                    <h3 className="font-bold text-lg text-fg flex items-center gap-2 group-hover:text-brand transition-colors">
                      {ext.name}
                    </h3>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
                      <span className="flex items-center gap-1 font-medium text-fg">
                        <User className="h-3.5 w-3.5" />
                        {ext.publisher}
                      </span>
                      <span>•</span>
                      <span>{`v${ext.version}`}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => voteMutation.mutate({ slug: ext.marketplaceSlug, hasVoted: !!ext.hasVoted })}
                    disabled={voteMutation.isPending}
                    aria-pressed={!!ext.hasVoted}
                    aria-label={t('marketplace.upvote')}
                    className={`inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1 font-semibold transition disabled:opacity-50 ${ext.hasVoted ? 'border-brand/40 bg-brand-soft text-brand' : 'hover:bg-panel-2 text-dim' }`}
                  >
                    <ArrowBigUp className="h-3.5 w-3.5" />
                    {ext.voteCount ?? 0}
                  </button>
                  <span className="inline-flex items-center gap-1 text-dim" title={t('marketplace.downloads')}>
                    <Download className="h-3.5 w-3.5" />
                    {ext.totalDownloads ?? 0}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDownload(ext.marketplaceSlug)}
                    className="ml-auto inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1 font-medium hover:bg-panel-2"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t('marketplace.download')}
                  </button>
                </div>

                <div className="mt-4 flex items-center justify-between border-t pt-4">
                  <button
                    onClick={() => setSelectedSlug(ext.marketplaceSlug)}
                    className="inline-flex items-center gap-1 text-sm font-semibold text-brand hover:underline"
                  >
                    <Info className="h-4 w-4" />
                    {t('marketplace.details')}
                  </button>

                  {isInstalled ? (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-ok bg-ok-soft border border-ok/40 rounded-full px-3 py-1">
                      <Check className="h-3.5 w-3.5" />
                      {t('marketplace.installed')}
                    </span>
                  ) : (
                    <button
                      onClick={() => void handleInstall(ext.marketplaceSlug)}
                      disabled={installMutation.isPending && installMutation.variables?.slug === ext.marketplaceSlug}
                      className="inline-flex items-center gap-1.5 rounded-card bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg transition hover:bg-brand/95 disabled:opacity-50"
                    >
                      <Download className="h-3.5 w-3.5" />
                      {installMutation.isPending && installMutation.variables?.slug === ext.marketplaceSlug
                        ? t('marketplace.installing')
                        : t('marketplace.install')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Extension Detail Modal */}
      {selectedSlug && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-card border border-line bg-panel p-6 shadow-2xl relative animate-in fade-in zoom-in-95 duration-150">
            <button
              onClick={() => setSelectedSlug(null)}
              aria-label={t('common:close')}
              className="absolute right-4 top-4 text-dim hover:text-fg transition rounded-ctl p-1 hover:bg-panel-2"
            >
              <X className="h-5 w-5" />
            </button>

            {detailQuery.isLoading ? (
              <div className="flex h-64 items-center justify-center">
                <span className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
              </div>
            ) : !selectedExtension ? (
              <div className="text-center py-8 text-bad flex flex-col items-center gap-2">
                <ShieldAlert className="h-10 w-10" />
                <p>{t('marketplace.detailFailed')}</p>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-card bg-brand-soft text-brand border border-brand/20">
                    <Puzzle className="h-8 w-8" />
                  </div>
                  <div>
                    <h2 className="t-section">{selectedExtension.name}</h2>
                    <p className="text-sm text-dim mt-0.5">
                      {t('marketplace.by')} <span className="font-semibold text-fg">{selectedExtension.publisher}</span>{` • v${selectedExtension.version}`}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <span className="inline-flex items-center rounded-full bg-panel-2 px-2.5 py-0.5 text-xs font-semibold capitalize border border-line">
                        {selectedExtension.type}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="border-t pt-4 space-y-4">
                  <div>
                    <h4 className="text-sm font-semibold text-dim mb-1">{t('marketplace.fields.description')}</h4>
                    <p className="text-sm leading-relaxed text-fg">
                      {selectedExtension.manifest?.description || t('marketplace.noDescription')}
                    </p>
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold text-dim mb-1.5">{t('marketplace.permissions')}</h4>
                    <PermissionList capabilities={selectedExtension.requestedCapabilities ?? []} />
                  </div>

                  <div className="rounded-card bg-warn-soft border border-warn/40 p-3 flex gap-2.5">
                    <ShieldAlert className="h-5 w-5 text-warn flex-shrink-0 mt-0.5" />
                    <div>
                      <h5 className="text-xs font-bold text-warn">{t('marketplace.signed')}</h5>
                      <p className="text-xs text-warn mt-0.5 leading-relaxed">
                        <Trans
                          t={t}
                          i18nKey="marketplace.signedBody"
                          values={{ keyId: selectedExtension.publisherKeyId }}
                          components={{ code: <code className="bg-warn-soft px-1 py-0.2 rounded font-mono text-[10px]" /> }}
                        />
                      </p>
                    </div>
                  </div>
                </div>

                <div className="border-t pt-4 flex justify-end gap-2">
                  <button
                    onClick={() => handleDownload(selectedExtension.marketplaceSlug)}
                    className="inline-flex items-center gap-1.5 rounded-card border border-line px-4 py-2 text-sm font-semibold hover:bg-panel-2 transition"
                  >
                    <Download className="h-4 w-4" />
                    {t('marketplace.download')}
                  </button>
                  <button
                    onClick={() => setSelectedSlug(null)}
                    className="rounded-card border border-line px-4 py-2 text-sm font-semibold hover:bg-panel-2 transition"
                  >
                    {t('common:cancel')}
                  </button>

                  {installedSlugs.has(selectedExtension.marketplaceSlug) ? (
                    <button
                      disabled
                      className="inline-flex items-center gap-1 rounded-card bg-ok-soft border border-ok/40 px-4 py-2 text-sm font-bold text-ok"
                    >
                      <Check className="h-4 w-4" />
                      {t('marketplace.installed')}
                    </button>
                  ) : (
                    <button
                      onClick={() => void handleInstall(selectedExtension.marketplaceSlug)}
                      disabled={installMutation.isPending}
                      className="inline-flex items-center gap-1.5 rounded-card bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:bg-brand/90 transition"
                    >
                      <Download className="h-4 w-4" />
                      {installMutation.isPending ? t('marketplace.installing') : t('marketplace.installExtension')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {installTarget && (
        <PermissionApprovalDialog
          title={t('marketplace.approveInstallTitle', { name: installTarget.name })}
          intro={t('extensions.approveInstallIntro')}
          capabilities={installTarget.capabilities}
          approveLabel={t('extensions.approveAndInstall')}
          pending={installMutation.isPending}
          error={apiErrorMessage(installMutation.error)}
          onApprove={() => installMutation.mutate(installTarget)}
          onCancel={() => setInstallTarget(null)}
        />
      )}
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeoPressError, type SiteIdentity, type SiteIdentityInput } from '@heopress/sdk';
import { BadgeCheck, Check, Save } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { getApiClient } from '@/lib/api';

/**
 * Site identity — whom the site speaks for (HeoPress P07 task 2.12; spec seo/page-metadata "站点身份").
 *
 * An organisation, a person or a local business, with its name, logo, contact details and official profiles. The
 * site's structured data names it (Organization, Person or LocalBusiness); a field left empty stays out of it — nothing
 * is made up. A new site lands here first (`?new=1`) so its operator says who it is before publishing.
 */

type Kind = SiteIdentity['kind'];

const KINDS: Array<{ value: Kind; label: string; hint: string }> = [
  { value: 'organization', label: 'Organization', hint: 'A company, publication or other organisation.' },
  { value: 'person', label: 'Person', hint: 'A personal site: the person it belongs to.' },
  { value: 'local_business', label: 'Local business', hint: 'A shop, restaurant or office people visit.' },
];

const EMPTY_ADDRESS: SiteIdentity['address'] = { streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', addressCountry: '' };

interface Form {
  kind: Kind;
  name: string;
  logo: string;
  email: string;
  telephone: string;
  address: SiteIdentity['address'];
  /** One address per line. */
  sameAs: string;
}

const formOf = (identity: SiteIdentity | null): Form => ({
  kind: identity?.kind ?? 'organization',
  name: identity?.name ?? '',
  logo: identity?.logo ?? '',
  email: identity?.email ?? '',
  telephone: identity?.telephone ?? '',
  address: identity?.address ?? EMPTY_ADDRESS,
  sameAs: (identity?.sameAs ?? []).join('\n'),
});

const inputOf = (f: Form, version: number): SiteIdentityInput => ({
  version,
  kind: f.kind,
  name: f.name.trim(),
  logo: f.logo.trim(),
  email: f.email.trim(),
  telephone: f.telephone.trim(),
  // A person has no address field in the form: none is sent, even one left from an earlier kind.
  address: f.kind === 'person' ? EMPTY_ADDRESS : f.address,
  sameAs: f.sameAs
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean),
});

function messageOf(err: unknown): string {
  if (err instanceof HeoPressError) {
    const first = (err.body as { errors?: Array<{ code?: string; message?: string }> })?.errors?.[0];
    if (first?.code === 'VERSION_CONFLICT') return 'Someone changed the identity meanwhile. Reload the page and try again.';
    if (first?.message) return first.message;
  }
  return 'The identity could not be saved.';
}

const inputClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';

export function SiteIdentityPage() {
  const client = getApiClient();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['site-identity'], queryFn: async () => (await client.site.identity()).data });
  const [form, setForm] = useState<Form>(formOf(null));
  const [saved, setSaved] = useState(false);
  const ids = { kind: useId(), name: useId(), logo: useId(), email: useId(), telephone: useId(), street: useId(), locality: useId(), region: useId(), postal: useId(), country: useId(), sameAs: useId() };
  const isNew = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('new') === '1';

  useEffect(() => {
    if (query.data) setForm(formOf(query.data.identity));
  }, [query.data]);

  const save = useMutation({
    mutationFn: async () => (await client.site.updateIdentity(inputOf(form, query.data?.version ?? 0))).data,
    onSuccess: (data) => {
      qc.setQueryData(['site-identity'], data);
      setSaved(true);
    },
  });

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const setAddress = (key: keyof SiteIdentity['address'], value: string) => set('address', { ...form.address, [key]: value });

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (query.isError) return <p role="alert" className="text-sm text-destructive">The identity could not be loaded.</p>;

  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <BadgeCheck className="h-5 w-5" aria-hidden="true" />
          Site identity
        </h1>
        <p className="text-sm text-muted-foreground">
          Who this site speaks for. Search engines and AI assistants read it from the site&apos;s structured data. Fields you leave empty are left out — nothing is made up.
        </p>
      </header>
      {isNew && !query.data?.identity ? (
        <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm">
          Your site is ready. Before you publish, say who it represents: an organization, a person or a local business.
        </p>
      ) : null}
      <form
        aria-label="Site identity"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">This site represents</legend>
          {KINDS.map((k) => (
            <label key={k.value} className="flex items-start gap-2 text-sm">
              <input type="radio" name={ids.kind} value={k.value} checked={form.kind === k.value} onChange={() => set('kind', k.value)} className="mt-1" />
              <span>
                <span className="font-medium">{k.label}</span> <span className="text-muted-foreground">— {k.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="space-y-1">
          <label htmlFor={ids.name} className="text-sm font-medium">
            Name
          </label>
          <input id={ids.name} required maxLength={200} value={form.name} onChange={(e) => set('name', e.target.value)} className={inputClass} />
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.logo} className="text-sm font-medium">
            {form.kind === 'person' ? 'Picture' : 'Logo'} (address)
          </label>
          <input id={ids.logo} type="url" placeholder="https://example.com/logo.png" value={form.logo} onChange={(e) => set('logo', e.target.value)} className={inputClass} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={ids.email} className="text-sm font-medium">
              Email
            </label>
            <input id={ids.email} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} className={inputClass} />
          </div>
          <div className="space-y-1">
            <label htmlFor={ids.telephone} className="text-sm font-medium">
              Telephone
            </label>
            <input id={ids.telephone} type="tel" value={form.telephone} onChange={(e) => set('telephone', e.target.value)} className={inputClass} />
          </div>
        </div>
        {form.kind !== 'person' ? (
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="text-sm font-medium">Address</legend>
            <div className="space-y-1 sm:col-span-2">
              <label htmlFor={ids.street} className="text-xs text-muted-foreground">
                Street address
              </label>
              <input id={ids.street} value={form.address.streetAddress} onChange={(e) => setAddress('streetAddress', e.target.value)} className={inputClass} />
            </div>
            <div className="space-y-1">
              <label htmlFor={ids.locality} className="text-xs text-muted-foreground">
                City
              </label>
              <input id={ids.locality} value={form.address.addressLocality} onChange={(e) => setAddress('addressLocality', e.target.value)} className={inputClass} />
            </div>
            <div className="space-y-1">
              <label htmlFor={ids.region} className="text-xs text-muted-foreground">
                Region
              </label>
              <input id={ids.region} value={form.address.addressRegion} onChange={(e) => setAddress('addressRegion', e.target.value)} className={inputClass} />
            </div>
            <div className="space-y-1">
              <label htmlFor={ids.postal} className="text-xs text-muted-foreground">
                Postal code
              </label>
              <input id={ids.postal} value={form.address.postalCode} onChange={(e) => setAddress('postalCode', e.target.value)} className={inputClass} />
            </div>
            <div className="space-y-1">
              <label htmlFor={ids.country} className="text-xs text-muted-foreground">
                Country (two-letter code)
              </label>
              <input id={ids.country} maxLength={2} value={form.address.addressCountry} onChange={(e) => setAddress('addressCountry', e.target.value.toUpperCase())} className={inputClass} />
            </div>
          </fieldset>
        ) : null}
        <div className="space-y-1">
          <label htmlFor={ids.sameAs} className="text-sm font-medium">
            Official profiles
          </label>
          <textarea
            id={ids.sameAs}
            rows={4}
            placeholder={'https://social.example.com/your-name\nhttps://code.example.com/your-name'}
            value={form.sameAs}
            onChange={(e) => set('sameAs', e.target.value)}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
          <p className="text-xs text-muted-foreground">One address per line: social accounts, a registry entry, a profile page.</p>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={save.isPending} className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-sm">
            <Save className="h-4 w-4" aria-hidden="true" />
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {saved ? (
            <span role="status" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <Check className="h-4 w-4" aria-hidden="true" />
              Saved
            </span>
          ) : null}
          {save.isError ? (
            <span role="alert" className="text-sm text-destructive">
              {messageOf(save.error)}
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}

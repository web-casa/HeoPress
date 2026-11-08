// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useTranslation } from 'react-i18next';
import { ExternalLink, Info, Minus } from 'lucide-react';
import { readOptions, type InterfaceComponent } from './types';

interface PresentationLink {
  label: string;
  href: string;
}

interface PresentationOptions {
  variant?: 'divider' | 'notice';
  title?: string;
  subtitle?: string;
  text?: string;
  /** Tailwind color token, e.g. `amber`, `emerald`. */
  tone?: 'muted' | 'amber' | 'emerald' | 'destructive';
  /** Links rendered by `presentation-links`. */
  links?: PresentationLink[];
}

/**
 * `presentation-divider` / `presentation-notice` — read-only layout helpers.
 * No value is stored; the interface ignores `value` and `onChange`.
 */
export const PresentationInterface: InterfaceComponent<unknown> = ({ field }) => {
  const opts = readOptions<PresentationOptions>(field);
  const variant = opts.variant ?? 'divider';

  if (variant === 'divider') {
    return (
      <div className="flex items-center gap-2 py-2 text-dim">
        <Minus className="h-3 w-3" />
        <span className="text-xs uppercase">{opts.title ?? field.name}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }

  const tones: Record<NonNullable<PresentationOptions['tone']>, string> = {
    muted: 'border-line bg-panel-2 text-dim',
    amber: 'border-warn/40 bg-warn-soft text-warn',
    emerald: 'border-ok/40 bg-ok-soft text-ok',
    destructive: 'border-bad/40 bg-bad-soft text-bad',
  };
  const tone = tones[opts.tone ?? 'muted'];

  return (
    <div className={`flex items-start gap-2 rounded-ctl border p-3 text-sm ${tone}`}>
      <Info className="mt-0.5 h-4 w-4 flex-none" />
      <div>
        {opts.title && <p className="mb-0.5 font-medium">{opts.title}</p>}
        {opts.text && <p className="text-xs leading-relaxed">{opts.text}</p>}
      </div>
    </div>
  );
};

/**
 * `presentation-header` — section heading with optional subtitle. Stores no
 * value; used to break long forms into labelled sections.
 */
export const PresentationHeaderInterface: InterfaceComponent<unknown> = ({ field }) => {
  const opts = readOptions<PresentationOptions>(field);
  return (
    <div className="border-b border-line pb-1.5 pt-2">
      <h3 className="text-sm font-semibold">{opts.title ?? field.name}</h3>
      {opts.subtitle && <p className="text-xs text-dim">{opts.subtitle}</p>}
    </div>
  );
};

/**
 * `presentation-links` — a row of link buttons (e.g. external references or
 * docs). Stores no value.
 */
export const PresentationLinksInterface: InterfaceComponent<unknown> = ({ field }) => {
  const opts = readOptions<PresentationOptions>(field);
  const links = opts.links ?? [];
  const { t } = useTranslation('items');
  if (links.length === 0) {
    return <p className="text-xs text-dim">{t('interfaces.noLinks')}</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {links.map((link, i) => (
        <a
          key={`${link.href}-${i}`}
          href={link.href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1 text-xs hover:bg-panel-2"
        >
          <ExternalLink className="h-3 w-3" />
          {link.label || link.href}
        </a>
      ))}
    </div>
  );
};

// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FocalPicker } from './focal-picker';

/**
 * Custom transform panel (image-transform-dsl Req 5.2, 5.4). Lets an operator
 * dial in a `TransformDsl` (width/height/format/quality/fit/focal), see a live
 * preview, and copy the delivery URL. Hidden when `presetOnly` is set — then
 * only preset-based URLs are offered (see PresetManager).
 */

const FORMATS = ['', 'webp', 'avif', 'jpeg', 'png'] as const;
const FITS = ['', 'cover', 'contain', 'fill', 'inside', 'outside'] as const;

export interface TransformPanelProps {
  /** Public media key (path under /api/v1/media). */
  fileKey: string;
  /** Base URL to prefix (defaults to relative). */
  baseUrl?: string;
  presetOnly?: boolean;
}

export function transformUrl(
  fileKey: string,
  dsl: { width?: number; height?: number; format?: string; quality?: number; fit?: string; focal?: { x: number; y: number } },
  baseUrl = '',
): string {
  const path = `${baseUrl}/api/v1/media/${fileKey.split('/').map(encodeURIComponent).join('/')}`;
  const qs = new URLSearchParams();
  if (dsl.width) qs.set('width', String(dsl.width));
  if (dsl.height) qs.set('height', String(dsl.height));
  if (dsl.format) qs.set('format', dsl.format);
  if (dsl.quality) qs.set('quality', String(dsl.quality));
  if (dsl.fit) qs.set('fit', dsl.fit);
  if (dsl.focal) qs.set('focal', `${dsl.focal.x},${dsl.focal.y}`);
  const q = qs.toString();
  return q ? `${path}?${q}` : path;
}

export function TransformPanel({ fileKey, baseUrl = '', presetOnly }: TransformPanelProps) {
  const { t } = useTranslation('files');
  const [dsl, setDsl] = useState<{
    width?: number;
    height?: number;
    format?: string;
    quality?: number;
    fit?: string;
    focal?: { x: number; y: number };
  }>({});
  const [copied, setCopied] = useState(false);

  const url = useMemo(() => transformUrl(fileKey, dsl, baseUrl), [fileKey, dsl, baseUrl]);
  const originalUrl = useMemo(() => transformUrl(fileKey, {}, baseUrl), [fileKey, baseUrl]);

  if (presetOnly) {
    return <p className="text-sm text-dim">{t('transform.presetOnly')}</p>;
  }

  const num = (v: string): number | undefined => (v ? Number(v) : undefined);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-xs">
          <span className="text-dim">{t('transform.width')}</span>
          <input type="number" className="w-full rounded border border-line px-2 py-1 text-sm" value={dsl.width ?? ''} onChange={(e) => setDsl((d) => ({ ...d, width: num(e.target.value) }))} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-dim">{t('transform.height')}</span>
          <input type="number" className="w-full rounded border border-line px-2 py-1 text-sm" value={dsl.height ?? ''} onChange={(e) => setDsl((d) => ({ ...d, height: num(e.target.value) }))} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-dim">{t('transform.quality')}</span>
          <input type="number" min={1} max={100} className="w-full rounded border border-line px-2 py-1 text-sm" value={dsl.quality ?? ''} onChange={(e) => setDsl((d) => ({ ...d, quality: num(e.target.value) }))} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-dim">{t('transform.format')}</span>
          <select className="w-full rounded border border-line px-2 py-1 text-sm" value={dsl.format ?? ''} onChange={(e) => setDsl((d) => ({ ...d, format: e.target.value || undefined }))}>
            {FORMATS.map((f) => <option key={f} value={f}>{f || t('transform.auto')}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-dim">{t('transform.fit')}</span>
          <select className="w-full rounded border border-line px-2 py-1 text-sm" value={dsl.fit ?? ''} onChange={(e) => setDsl((d) => ({ ...d, fit: e.target.value || undefined }))}>
            {FITS.map((f) => <option key={f} value={f}>{f || t('transform.default')}</option>)}
          </select>
        </label>
      </div>

      <FocalPicker src={originalUrl} focal={dsl.focal} onChange={(focal) => setDsl((d) => ({ ...d, focal }))} />

      <div className="flex items-center gap-2">
        <input readOnly value={url} className="flex-1 rounded border border-line bg-panel-2 px-2 py-1 font-mono text-xs" />
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1 text-xs hover:bg-panel-2"
          onClick={() => {
            void navigator.clipboard?.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          {copied ? t('transform.copied') : t('transform.copyUrl')}
        </button>
      </div>
    </div>
  );
}

// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useTranslation } from 'react-i18next';
import {
  Star, Heart, Home, User, Settings, Bell, Mail, Calendar, Clock, Search,
  File, Folder, Image, Video, Music, Tag, Bookmark, Flag, MapPin, Globe,
  Phone, Camera, Cloud, Lock, Key, Zap, Shield, Gift, ShoppingCart, CreditCard,
  CheckCircle, AlertTriangle, Info, X, Plus, Trash2, Edit, Eye, Link2, Share2,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import type { InterfaceComponent } from './types';

/** Curated icon set, keyed by stable string ids stored as the field value. */
const ICONS: Record<string, LucideIcon> = {
  star: Star, heart: Heart, home: Home, user: User, settings: Settings,
  bell: Bell, mail: Mail, calendar: Calendar, clock: Clock, search: Search,
  file: File, folder: Folder, image: Image, video: Video, music: Music,
  tag: Tag, bookmark: Bookmark, flag: Flag, 'map-pin': MapPin, globe: Globe,
  phone: Phone, camera: Camera, cloud: Cloud, lock: Lock, key: Key,
  zap: Zap, shield: Shield, gift: Gift, 'shopping-cart': ShoppingCart, 'credit-card': CreditCard,
  'check-circle': CheckCircle, 'alert-triangle': AlertTriangle, info: Info, x: X, plus: Plus,
  trash: Trash2, edit: Edit, eye: Eye, link: Link2, share: Share2,
};

/**
 * `select-icon` — pick a single icon from a curated set. Stores the icon id
 * (e.g. `star`) as a `string`.
 */
export const SelectIconInterface: InterfaceComponent<string> = ({
  value,
  disabled,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation('items');
  const Active = value ? ICONS[value] : undefined;

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-ctl border border-line bg-bg px-2 py-1 text-sm disabled:opacity-50"
      >
        {Active ? <Active className="h-4 w-4" /> : <span className="text-dim">{t('interfaces.pickIcon')}</span>}
        {value && <span className="text-xs text-dim">{value}</span>}
      </button>

      {open && (
        <div className="absolute z-10 mt-1 w-72 rounded-ctl border border-line bg-bg p-2 shadow-lg">
          <div className="grid grid-cols-8 gap-1">
            {Object.entries(ICONS).map(([id, Icon]) => (
              <button
                key={id}
                type="button"
                title={id}
                onClick={() => {
                  onChange(id);
                  setOpen(false);
                }}
                className={cn(
                  'flex items-center justify-center rounded-ctl p-1.5 hover:bg-panel-2',
                  value === id && 'bg-brand-soft text-brand',
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="mt-2 w-full rounded-ctl border border-line px-2 py-1 text-xs text-dim hover:bg-panel-2"
            >
              {t('interfaces.clear')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

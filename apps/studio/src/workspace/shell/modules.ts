import {
  Activity,
  BarChart3,
  Bot,
  FileText,
  Globe2,
  LayoutDashboard,
  Settings,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';

/**
 * The eight Carbon modules (ADR-0019 §2). `path` is app-internal (without
 * the private admin prefix); `key` is the second key of the G + letter jump.
 * SEO / GEO and search never share an icon (ADR-0019 §4).
 */
export type ModuleId = 'overview' | 'content' | 'sites' | 'seo' | 'aiTraffic' | 'audit' | 'monitoring' | 'settings';

export interface ModuleDef {
  id: ModuleId;
  path: string;
  icon: LucideIcon;
  key: string;
  /** Only site administrators may enter (Logs & monitoring, ADR-0019 §2). */
  adminOnly?: boolean;
}

export const MODULES: readonly ModuleDef[] = [
  { id: 'overview', path: '/overview', icon: LayoutDashboard, key: 'o' },
  { id: 'content', path: '/content', icon: FileText, key: 'c' },
  { id: 'sites', path: '/sites', icon: Globe2, key: 's' },
  { id: 'seo', path: '/seo', icon: Bot, key: 'e' },
  { id: 'aiTraffic', path: '/ai-traffic', icon: BarChart3, key: 'a' },
  { id: 'audit', path: '/audit', icon: ShieldAlert, key: 'u' },
  { id: 'monitoring', path: '/monitoring', icon: Activity, key: 'l', adminOnly: true },
  { id: 'settings', path: '/settings', icon: Settings, key: ',' },
];

/** The modules a user may enter. */
export function visibleModules(isSiteAdmin: boolean): ModuleDef[] {
  return MODULES.filter((m) => !m.adminOnly || isSiteAdmin);
}

/** The module an app-internal pathname belongs to (`/` is the overview). */
export function moduleOf(appPath: string): ModuleId {
  const first = `/${appPath.split('/').filter(Boolean)[0] ?? 'overview'}`;
  return MODULES.find((m) => m.path === first)?.id ?? 'overview';
}


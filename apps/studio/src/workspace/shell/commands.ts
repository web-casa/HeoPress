import type { ModuleId } from './modules';

/**
 * What the ⌘K palette offers besides content search (ADR-0019 §5.1,
 * p07a task 2.5): module views to jump to and actions to run, each filtered
 * by what the user may do. Labels are keys in the `nav` / `shell` namespaces.
 */
export interface PaletteCommand {
  id: string;
  /** `jump`: navigate to `to`; `action`: the shell runs `id`. */
  kind: 'jump' | 'action';
  module: ModuleId;
  label: string;
  to?: string;
  keywords?: string;
  /** Only site administrators (`permissions.admin`). */
  adminOnly?: boolean;
  /** Needs this collection action (`collection::action`). */
  needs?: [collection: string, action: 'create' | 'read' | 'update' | 'delete' | 'review'];
}

/** The views of Settings › Advanced, in the panel's order (`ADVANCED_NAV` in workspace/routes.tsx; a test keeps them equal). */
export const ADVANCED_VIEWS = [
  'access', 'data-model', 'automation/flows', 'branding', 'users', 'keyboard', 'editorial-profile', 'storage', 'models', 'ai-pipeline', 'uploads', 'teams',
  'integrations/git', 'webhooks', 'change-feed', 'deployments', 'email', 'extensions', 'marketplace', 'developer/types', 'agent-harness',
  'materialize', 'security', 'encryption', 'updates',
] as const;

const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  { id: 'go.overview', kind: 'jump', module: 'overview', label: 'nav:overview.home', to: '/overview' },
  { id: 'go.dashboards', kind: 'jump', module: 'overview', label: 'nav:overview.dashboards', to: '/overview/dashboards', keywords: 'insights' },
  { id: 'go.content', kind: 'jump', module: 'content', label: 'nav:content.workspace', to: '/content', keywords: 'review' },
  { id: 'go.contentTypes', kind: 'jump', module: 'content', label: 'nav:content.collections', to: '/content/collections', keywords: 'collections types articles pages' },
  { id: 'go.translationMemory', kind: 'jump', module: 'content', label: 'nav:content.translationMemory', to: '/content/translation-memory', keywords: 'tm glossary' },
  { id: 'go.media', kind: 'jump', module: 'content', label: 'nav:content.media', to: '/content/media', keywords: 'files images' },
  { id: 'go.sources', kind: 'jump', module: 'content', label: 'nav:content.sources', to: '/content/sources', keywords: 'rss atom feed sitemap ingest licence' },
  { id: 'go.aiReview', kind: 'jump', module: 'content', label: 'nav:content.aiReview', to: '/content/ai-review', keywords: 'ai gate quality review queue veto' },
  { id: 'go.workbench', kind: 'jump', module: 'content', label: 'nav:content.workbench', to: '/content/workbench', keywords: 'ai prompt trial' },
  { id: 'go.flowDrafts', kind: 'jump', module: 'content', label: 'nav:content.flowDrafts', to: '/content/flow-drafts', adminOnly: true, keywords: 'ai agent flow approval' },
  { id: 'go.translations', kind: 'jump', module: 'content', label: 'nav:content.translations', to: '/content/translations', keywords: 'i18n' },
  { id: 'go.topology', kind: 'jump', module: 'sites', label: 'nav:sites.topology', to: '/sites' },
  { id: 'go.sitesList', kind: 'jump', module: 'sites', label: 'nav:sites.list', to: '/sites/list', keywords: 'sites network' },
  { id: 'go.domains', kind: 'jump', module: 'sites', label: 'nav:sites.domains', to: '/sites/domains', keywords: 'dns certificate https' },
  { id: 'go.seo', kind: 'jump', module: 'seo', label: 'nav:seo.appearance', to: '/seo', keywords: 'title description template' },
  { id: 'go.seo.crawlers', kind: 'jump', module: 'seo', label: 'nav:seo.crawlers', to: '/seo/crawlers', keywords: 'robots crawler ai gptbot' },
  { id: 'go.seo.machine', kind: 'jump', module: 'seo', label: 'nav:seo.machine', to: '/seo/machine', keywords: 'llms markdown indexnow feed' },
  { id: 'go.seo.canonical', kind: 'jump', module: 'seo', label: 'nav:seo.canonical', to: '/seo/canonical', keywords: 'canonical www https host' },
  { id: 'go.seo.content', kind: 'jump', module: 'seo', label: 'nav:seo.settings', to: '/seo/content', keywords: 'sponsored shared translations' },
  { id: 'go.seo.redirects', kind: 'jump', module: 'seo', label: 'nav:seo.redirects', to: '/seo/redirects', keywords: '301 redirect' },
  { id: 'go.identity', kind: 'jump', module: 'seo', label: 'nav:seo.identity', to: '/seo/identity', keywords: 'organization schema' },
  { id: 'go.rootFiles', kind: 'jump', module: 'seo', label: 'nav:seo.rootFiles', to: '/seo/root-files', keywords: 'ads.txt verification' },
  { id: 'go.aiTraffic', kind: 'jump', module: 'aiTraffic', label: 'nav:aiTraffic.report', to: '/ai-traffic', keywords: 'gptbot crawler referral' },
  { id: 'go.audit', kind: 'jump', module: 'audit', label: 'nav:audit.issues', to: '/audit' },
  { id: 'go.links', kind: 'jump', module: 'audit', label: 'nav:audit.links', to: '/audit/links', keywords: 'broken orphan' },
  { id: 'go.events', kind: 'jump', module: 'monitoring', label: 'nav:monitoring.events', to: '/monitoring', adminOnly: true, keywords: 'logs' },
  { id: 'go.reachability', kind: 'jump', module: 'monitoring', label: 'nav:monitoring.reachability', to: '/monitoring/reachability', adminOnly: true },
  { id: 'go.activity', kind: 'jump', module: 'monitoring', label: 'nav:monitoring.activity', to: '/monitoring/activity', adminOnly: true, keywords: 'audit log history' },
  { id: 'go.agents', kind: 'jump', module: 'monitoring', label: 'nav:monitoring.agents', to: '/monitoring/agents', adminOnly: true, keywords: 'mission control agents' },
  { id: 'go.general', kind: 'jump', module: 'settings', label: 'nav:settings.general', to: '/settings/general', adminOnly: true },
  { id: 'go.appearance', kind: 'jump', module: 'settings', label: 'nav:settings.appearance', to: '/settings/appearance', keywords: 'theme dark language' },
  { id: 'go.members', kind: 'jump', module: 'settings', label: 'nav:settings.members', to: '/settings/members', adminOnly: true, keywords: 'users invite roles' },
  { id: 'go.apiKeys', kind: 'jump', module: 'settings', label: 'nav:settings.apiKeys', to: '/settings/api-keys', adminOnly: true, keywords: 'token' },
  { id: 'go.license', kind: 'jump', module: 'settings', label: 'nav:settings.license', to: '/settings/license', adminOnly: true, keywords: 'agpl commercial' },
  // Settings › Advanced: administrators only (spec studio/settings).
  ...ADVANCED_VIEWS.map((view): PaletteCommand => ({ id: `go.advanced.${view}`, kind: 'jump', module: 'settings', label: `nav:settings.legacy.${view}`, to: `/settings/advanced/${view}`, adminOnly: true, keywords: 'advanced' })),
  { id: 'action.newArticle', kind: 'action', module: 'content', label: 'shell:actions.newArticle', needs: ['articles', 'create'] },
  { id: 'action.toggleTheme', kind: 'action', module: 'settings', label: 'shell:actions.toggleTheme' },
  { id: 'action.shortcuts', kind: 'action', module: 'settings', label: 'shell:shortcuts.title' },
];

/** The commands this user may see. */
export function availableCommands(
  isAdmin: boolean,
  can: (collection: string, action: NonNullable<PaletteCommand['needs']>[1]) => boolean,
  commands: readonly PaletteCommand[] = PALETTE_COMMANDS,
): PaletteCommand[] {
  return commands.filter((c) => {
    if (c.adminOnly && !isAdmin) return false;
    if (c.needs && !isAdmin && !can(c.needs[0], c.needs[1])) return false;
    return true;
  });
}

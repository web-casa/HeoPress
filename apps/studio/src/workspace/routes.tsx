import { createRoute, notFound, Outlet, redirect, type AnyRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { getAdminBase } from '@/lib/admin-base';
import { legacyTarget } from './legacy-redirects';
import { adminOnly, SettingsHome, settingsLayout } from './settings/settings-nav';
import { ModuleLayout, Page, type NavGroup } from './shell/module-layout';

/**
 * The Carbon workspace route tree (ADR-0019 §2, p07a task 2.3). One
 * declarative table; `buildWorkspaceRoutes` creates it twice — at the root
 * and under the private `/$adminPath` prefix — and adds a redirect route for
 * every old address family (task 2.4). Each module is its own chunk.
 */

const lazyPage = (load: () => Promise<unknown>) => lazy(() => load().then((c) => ({ default: c as ComponentType })));

// Carbon pages.
const OverviewPage = lazyPage(() => import('./overview/overview-page').then((m) => m.OverviewPage));
const SitesTopologyPage = lazyPage(() => import('./sites/topology-page').then((m) => m.SitesTopologyPage));
const SitesListPage = lazyPage(() => import('./sites/topology-page').then((m) => m.SitesListPage));
const MonitoringPage = lazyPage(() => import('./monitoring/monitoring-page').then((m) => m.MonitoringPage));
const AppearancePage = lazyPage(() => import('./settings/appearance-page').then((m) => m.AppearancePage));
const LicensePage = lazyPage(() => import('./settings/license-page').then((m) => m.LicensePage));
const GeneralPage = lazyPage(() => import('./settings/general-page').then((m) => m.GeneralPage));
const MembersPage = lazyPage(() => import('./settings/members-page').then((m) => m.MembersPage));
const ApiKeysSettingsPage = lazyPage(() => import('./settings/api-keys-page').then((m) => m.ApiKeysSettingsPage));
const ReviewPage = lazyPage(() => import('./content/review-page').then((m) => m.ReviewPage));
const NewArticlePage = lazyPage(() => import('./content/new-article-page').then((m) => m.NewArticlePage));
const AgentsPage = lazyPage(() => import('./monitoring/agents-page').then((m) => m.AgentsPage));
const AuditWorkspacePage = lazyPage(() => import('./audit/audit-page').then((m) => m.AuditPage));
const AiTrafficWorkspacePage = lazyPage(() => import('./ai-traffic/ai-traffic-page').then((m) => m.AiTrafficPage));

// Pages moved in from LumiBase / earlier phases.
const SourcesPage = lazyPage(() => import('./content/sources-page').then((m) => m.SourcesPage));
const ContentTypesPage = lazyPage(() => import('./content/content-types-page').then((m) => m.ContentTypesPage));
const ItemsListPage = lazyPage(() => import('@/modules/content/items-list').then((m) => m.ItemsListPage));
const ItemRoute = lazyPage(() => import('./content/article-editor').then((m) => m.ItemRoute));
const FilesPage = lazyPage(() => import('@/modules/files').then((m) => m.FilesPage));
const TranslationsPage = lazyPage(() => import('@/modules/translations').then((m) => m.TranslationsPage));
const TranslationMemoryPage = lazyPage(() => import('@/modules/translations/tm-page').then((m) => m.TranslationMemoryPage));
const InsightsListPage = lazyPage(() => import('@/modules/insights/list-page').then((m) => m.InsightsListPage));
const InsightsDashboardPage = lazyPage(() => import('@/modules/insights/dashboard-page').then((m) => m.DashboardViewPage));
const DomainsSettingsPage = lazyPage(() => import('@/modules/settings/domains-page').then((m) => m.DomainsSettingsPage));
const ContentSettingsPage = lazyPage(() => import('@/modules/settings/content-settings-page').then((m) => m.ContentSettingsPage));
const AppearanceSection = lazyPage(() => import('./seo/seo-pages').then((m) => m.AppearanceSection));
const CrawlersSection = lazyPage(() => import('./seo/seo-pages').then((m) => m.CrawlersSection));
const MachineSection = lazyPage(() => import('./seo/seo-pages').then((m) => m.MachineSection));
const CanonicalSection = lazyPage(() => import('./seo/seo-pages').then((m) => m.CanonicalSection));
const IdentitySection = lazyPage(() => import('./seo/seo-pages').then((m) => m.IdentitySection));
const RootFilesSection = lazyPage(() => import('./seo/seo-pages').then((m) => m.RootFilesSection));
const RedirectsSection = lazyPage(() => import('./seo/seo-pages').then((m) => m.RedirectsSection));
const LinkReportPage = lazyPage(() => import('@/modules/settings/link-report-page').then((m) => m.LinkReportPage));
const ReachabilityPage = lazyPage(() => import('@/modules/settings/reachability-page').then((m) => m.ReachabilityPage));
const ActivityPage = lazyPage(() => import('@/modules/settings/activity-page').then((m) => m.ActivityPage));
const SiteSettingsPage = lazyPage(() => import('@/modules/settings/site-page').then((m) => m.SiteSettingsPage));
const UsersPage = lazyPage(() => import('@/modules/users/users-page').then((m) => m.UsersPage));
const TeamsPage = lazyPage(() => import('@/modules/users/teams-page').then((m) => m.TeamsPage));
const ApiKeysPage = lazyPage(() => import('@/modules/access/api-keys-page').then((m) => m.ApiKeysPage));
const MissionControlInboxPage = lazyPage(() => import('@/modules/mission-control/inbox-page').then((m) => m.InboxPage));
const MissionControlIntentsPage = lazyPage(() => import('@/modules/mission-control/intents-page').then((m) => m.IntentsPage));
const MissionControlIntentDetailPage = lazyPage(() => import('@/modules/mission-control/intent-detail').then((m) => m.IntentDetailPage));
const MissionControlGoalsPage = lazyPage(() => import('@/modules/mission-control/goals-page').then((m) => m.GoalsPage));
const MissionControlAgentsPage = lazyPage(() => import('@/modules/mission-control/agents-page').then((m) => m.AgentsPage));
const MissionControlTrustPage = lazyPage(() => import('@/modules/mission-control/trust-page').then((m) => m.TrustPage));
const MissionControlConstitutionPage = lazyPage(() => import('@/modules/mission-control/constitution-page').then((m) => m.ConstitutionPage));
// Settings › Advanced.
const AccessLayout = lazy(() => import('@/modules/access/layout').then((m) => ({ default: m.AccessLayout })));
const RolesListPage = lazyPage(() => import('@/modules/access/roles-page').then((m) => m.RolesListPage));
const RoleDetailPage = lazyPage(() => import('@/modules/access/role-detail').then((m) => m.RoleDetailPage));
const PoliciesListPage = lazyPage(() => import('@/modules/access/policies-page').then((m) => m.PoliciesListPage));
const PolicyDetailPage = lazyPage(() => import('@/modules/access/policy-detail').then((m) => m.PolicyDetailPage));
const PublicAccessPage = lazyPage(() => import('@/modules/access/public-access-page').then((m) => m.PublicAccessPage));
const AccessImportExportPage = lazyPage(() => import('@/modules/access/import-export-page').then((m) => m.AccessImportExportPage));
const PermissionMatrixPage = lazyPage(() => import('@/modules/access/permission-matrix').then((m) => m.PermissionMatrixPage));
const TestSandboxPage = lazyPage(() => import('@/modules/access/test-sandbox').then((m) => m.TestSandboxPage));
const CollectionsListPage = lazyPage(() => import('@/modules/data-model/list').then((m) => m.CollectionsListPage));
const CollectionDetailPage = lazyPage(() => import('@/modules/data-model/detail').then((m) => m.CollectionDetailPage));
const CollectionWizardPage = lazyPage(() => import('@/modules/data-model/wizard').then((m) => m.CollectionWizardPage));
const FlowsListPage = lazyPage(() => import('@/modules/automation/flows-page').then((m) => m.FlowsListPage));
const FlowEditor = lazyPage(() => import('@/modules/automation/flow-editor').then((m) => m.FlowEditor));
const DeveloperTypesPage = lazyPage(() => import('@/modules/settings/types-page').then((m) => m.DeveloperTypesPage));
const WebhooksPage = lazyPage(() => import('@/modules/settings/webhooks-page').then((m) => m.WebhooksPage));
const GitIntegrationsPage = lazyPage(() => import('@/modules/settings/git-integrations-page').then((m) => m.GitIntegrationsPage));
const ChangeFeedPage = lazyPage(() => import('@/modules/settings/change-feed-page').then((m) => m.ChangeFeedPage));
const DeploymentsPage = lazyPage(() => import('@/modules/settings/deployments-page').then((m) => m.DeploymentsPage));
const EmailSettingsPage = lazyPage(() => import('@/modules/settings/email-page').then((m) => m.EmailSettingsPage));
const EditorialProfilePage = lazyPage(() => import('@/modules/settings/editorial-profile-page').then((m) => m.EditorialProfilePage));
const StorageSettingsPage = lazyPage(() => import('@/modules/settings/storage-page').then((m) => m.StorageSettingsPage));
const ModelsSettingsPage = lazyPage(() => import('@/modules/settings/models-page').then((m) => m.ModelsSettingsPage));
const KeyboardSettingsPage = lazyPage(() => import('@/modules/settings/keyboard-page').then((m) => m.KeyboardSettingsPage));
const MaterializePage = lazyPage(() => import('@/modules/settings/materialize-page').then((m) => m.MaterializePage));
const EncryptionSettingsPage = lazyPage(() => import('@/modules/settings/encryption-page').then((m) => m.EncryptionSettingsPage));
const SecuritySettingsPage = lazyPage(() => import('@/modules/settings/security-page').then((m) => m.SecuritySettingsPage));
const ExtensionsPage = lazyPage(() => import('@/modules/settings/extensions-page').then((m) => m.ExtensionsPage));
const UploadsSettingsPage = lazyPage(() => import('@/modules/settings/uploads-page').then((m) => m.UploadsSettingsPage));
const MarketplacePage = lazyPage(() => import('@/modules/settings/marketplace-page').then((m) => m.MarketplacePage));
const UpdatesPage = lazyPage(() => import('@/modules/settings/updates-page').then((m) => m.UpdatesPage));
const AgentHarnessPage = lazyPage(() => import('@/modules/settings/agent-harness-page').then((m) => m.AgentHarnessPage));

function PageLoader() {
  return (
    <div role="status" className="flex h-full items-center justify-center p-12">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
    </div>
  );
}

/** A lazy page, in the standard frame unless it brings its own. */
function page(Component: ComponentType, frame: 'page' | 'wide' | 'bare' = 'page'): ComponentType {
  return function RoutePage() {
    const body = (
      <Suspense fallback={<PageLoader />}>
        <Component />
      </Suspense>
    );
    return frame === 'bare' ? body : <Page wide={frame === 'wide'}>{body}</Page>;
  };
}

function layout(groups: NavGroup[] | (() => NavGroup[]), wrap?: (children: ReactNode) => ReactNode): ComponentType {
  return function RouteLayout() {
    const resolved = typeof groups === 'function' ? groups() : groups;
    return <ModuleLayout groups={resolved}>{wrap ? wrap(<Outlet />) : undefined}</ModuleLayout>;
  };
}

/** Old address → new one; otherwise a 404 (task 2.4). */
function legacyRedirect({ location }: { location: { pathname: string; searchStr: string } }): never {
  const adminBase = getAdminBase(location.pathname);
  const appPath = adminBase ? location.pathname.slice(adminBase.length) || '/' : location.pathname;
  const target = legacyTarget(appPath, location.searchStr);
  if (!target) throw notFound();
  throw redirect({ href: `${adminBase}${target}`, replace: true });
}

interface RouteSpec {
  path: string;
  component?: ComponentType;
  beforeLoad?: (ctx: { location: { pathname: string; searchStr: string } }) => never;
  children?: RouteSpec[];
}

const ADVANCED_PAGES: Array<[string, ComponentType]> = [
  ['branding', SiteSettingsPage],
  ['users', UsersPage],
  ['keyboard', KeyboardSettingsPage],
  ['editorial-profile', EditorialProfilePage],
  ['storage', StorageSettingsPage],
  ['models', ModelsSettingsPage],
  ['uploads', UploadsSettingsPage],
  ['teams', TeamsPage],
  ['integrations/git', GitIntegrationsPage],
  ['webhooks', WebhooksPage],
  ['change-feed', ChangeFeedPage],
  ['deployments', DeploymentsPage],
  ['email', EmailSettingsPage],
  ['extensions', ExtensionsPage],
  ['marketplace', MarketplacePage],
  ['developer/types', DeveloperTypesPage],
  ['agent-harness', AgentHarnessPage],
  ['materialize', MaterializePage],
  ['security', SecuritySettingsPage],
  ['encryption', EncryptionSettingsPage],
  ['updates', UpdatesPage],
];

/** Labels of Settings › Advanced, in panel order (keys of `nav:settings.legacy`). */
export const ADVANCED_NAV = ['access', 'data-model', 'automation/flows', ...ADVANCED_PAGES.map(([p]) => p)];

const SPEC: RouteSpec[] = [
  {
    path: '/overview',
    component: layout([{ items: [{ to: '/overview', label: 'overview.home', exact: true }, { to: '/overview/dashboards', label: 'overview.dashboards' }] }]),
    children: [
      { path: '/', component: page(OverviewPage, 'bare') },
      { path: 'dashboards', component: page(InsightsListPage) },
      { path: 'dashboards/$dashboardId', component: page(InsightsDashboardPage, 'wide') },
    ],
  },
  {
    path: '/content',
    component: layout([
      {
        items: [
          { to: '/content', label: 'content.workspace', exact: true },
          // A collection's list and its items count as "Content types" too.
          { to: '/content/collections', label: 'content.collections', also: /^\/content\/(?!new$|media|translations|translation-memory|sources$)[^/]+/ },
        ],
      },
      { items: [{ to: '/content/media', label: 'content.media' }, { to: '/content/translations', label: 'content.translations' }, { to: '/content/translation-memory', label: 'content.translationMemory' }] },
      { items: [{ to: '/content/sources', label: 'content.sources' }] },
    ]),
    children: [
      { path: '/', component: page(ReviewPage, 'bare') },
      { path: 'new', component: page(NewArticlePage, 'bare') },
      { path: 'collections', component: page(ContentTypesPage) },
      { path: 'media', component: page(FilesPage, 'wide') },
      { path: 'translations', component: page(TranslationsPage) },
      { path: 'translation-memory', component: page(TranslationMemoryPage) },
      { path: 'sources', component: page(SourcesPage, 'wide') },
      { path: '$collection', component: page(ItemsListPage, 'wide') },
      { path: '$collection/reviews', beforeLoad: legacyRedirect },
      { path: '$collection/$id', component: page(ItemRoute, 'bare') },
    ],
  },
  {
    path: '/sites',
    component: layout([{ items: [{ to: '/sites', label: 'sites.topology', exact: true }, { to: '/sites/list', label: 'sites.list' }, { to: '/sites/domains', label: 'sites.domains' }] }]),
    children: [
      { path: '/', component: page(SitesTopologyPage, 'bare') },
      { path: 'list', component: page(SitesListPage) },
      { path: 'domains', component: page(DomainsSettingsPage) },
    ],
  },
  {
    path: '/seo',
    component: layout([
      {
        items: [
          { to: '/seo', label: 'seo.appearance', exact: true },
          { to: '/seo/crawlers', label: 'seo.crawlers' },
          { to: '/seo/machine', label: 'seo.machine' },
          { to: '/seo/canonical', label: 'seo.canonical' },
          { to: '/seo/identity', label: 'seo.identity' },
          { to: '/seo/root-files', label: 'seo.rootFiles' },
          { to: '/seo/redirects', label: 'seo.redirects' },
          { to: '/seo/content', label: 'seo.settings' },
        ],
      },
    ]),
    children: [
      { path: '/', component: page(AppearanceSection) },
      { path: 'crawlers', component: page(CrawlersSection) },
      { path: 'machine', component: page(MachineSection) },
      { path: 'canonical', component: page(CanonicalSection) },
      { path: 'identity', component: page(IdentitySection) },
      { path: 'root-files', component: page(RootFilesSection) },
      { path: 'redirects', component: page(RedirectsSection) },
      { path: 'content', component: page(ContentSettingsPage) },
    ],
  },
  {
    path: '/ai-traffic',
    component: layout([{ items: [{ to: '/ai-traffic', label: 'aiTraffic.report', exact: true }] }]),
    children: [{ path: '/', component: page(AiTrafficWorkspacePage, 'bare') }],
  },
  {
    path: '/audit',
    component: layout([{ items: [{ to: '/audit', label: 'audit.issues', exact: true }, { to: '/audit/links', label: 'audit.links' }] }]),
    children: [
      { path: '/', component: page(AuditWorkspacePage, 'bare') },
      { path: 'links', component: page(LinkReportPage, 'wide') },
    ],
  },
  {
    path: '/monitoring',
    component: layout([
      {
        items: [
          { to: '/monitoring', label: 'monitoring.events', exact: true },
          { to: '/monitoring/reachability', label: 'monitoring.reachability' },
          { to: '/monitoring/activity', label: 'monitoring.activity' },
          { to: '/monitoring/agents', label: 'monitoring.agents' },
        ],
      },
    ]),
    children: [
      { path: '/', component: page(MonitoringPage, 'bare') },
      { path: 'reachability', component: page(ReachabilityPage) },
      { path: 'activity', component: page(ActivityPage, 'wide') },
      { path: 'agents', component: page(AgentsPage, 'bare') },
      { path: 'agents/inbox', component: page(MissionControlInboxPage, 'wide') },
      { path: 'agents/intents', component: page(MissionControlIntentsPage, 'wide') },
      { path: 'agents/intents/$intentId', component: page(MissionControlIntentDetailPage, 'wide') },
      { path: 'agents/goals', component: page(MissionControlGoalsPage, 'wide') },
      { path: 'agents/agents', component: page(MissionControlAgentsPage, 'wide') },
      { path: 'agents/trust', component: page(MissionControlTrustPage, 'wide') },
      { path: 'agents/constitution', component: page(MissionControlConstitutionPage, 'wide') },
    ],
  },
  {
    path: '/settings',
    component: settingsLayout(ADVANCED_NAV),
    children: [
      { path: '/', component: SettingsHome },
      { path: 'general', component: page(adminOnly(GeneralPage)) },
      { path: 'appearance', component: page(AppearancePage) },
      { path: 'members', component: page(adminOnly(MembersPage), 'wide') },
      { path: 'api-keys', component: page(adminOnly(ApiKeysSettingsPage), 'wide') },
      { path: 'license', component: page(adminOnly(LicensePage)) },
      {
        path: 'advanced/access',
        component: () => (
          <Page wide>
            <Suspense fallback={<PageLoader />}>
              <AccessLayout>
                <Outlet />
              </AccessLayout>
            </Suspense>
          </Page>
        ),
        children: [
          { path: '/', component: page(adminOnly(RolesListPage), 'bare') },
          { path: 'roles', component: page(adminOnly(RolesListPage), 'bare') },
          { path: 'roles/$id', component: page(adminOnly(RoleDetailPage), 'bare') },
          { path: 'policies', component: page(adminOnly(PoliciesListPage), 'bare') },
          { path: 'policies/$id', component: page(adminOnly(PolicyDetailPage), 'bare') },
          { path: 'public', component: page(adminOnly(PublicAccessPage), 'bare') },
          { path: 'api-keys', component: page(adminOnly(ApiKeysPage), 'bare') },
          { path: 'import-export', component: page(adminOnly(AccessImportExportPage), 'bare') },
          { path: 'matrix', component: page(adminOnly(PermissionMatrixPage), 'bare') },
          { path: 'sandbox', component: page(adminOnly(TestSandboxPage), 'bare') },
        ],
      },
      { path: 'advanced/data-model', component: page(adminOnly(CollectionsListPage), 'wide') },
      { path: 'advanced/data-model/new', component: page(adminOnly(CollectionWizardPage), 'wide') },
      { path: 'advanced/data-model/$name', component: page(adminOnly(CollectionDetailPage), 'wide') },
      { path: 'advanced/automation/flows', component: page(adminOnly(FlowsListPage), 'wide') },
      { path: 'advanced/automation/flows/new', component: page(adminOnly(FlowEditor), 'bare') },
      { path: 'advanced/automation/flows/$id', component: page(adminOnly(FlowEditor), 'bare') },
      ...ADVANCED_PAGES.map(([path, Component]): RouteSpec => ({ path: `advanced/${path}`, component: page(adminOnly(Component), 'wide') })),
      { path: '$', beforeLoad: legacyRedirect },
    ],
  },
  // Old address families (task 2.4).
  ...['/files', '/insights', '/users', '/teams', '/access', '/data-model', '/automation', '/mission-control'].flatMap((p): RouteSpec[] => [
    { path: p, beforeLoad: legacyRedirect },
    { path: `${p}/$`, beforeLoad: legacyRedirect },
  ]),
];

function instantiate(parent: AnyRoute, spec: RouteSpec, prefix: string): AnyRoute {
  const route = createRoute({
    getParentRoute: () => parent,
    path: prefix ? `${prefix}${spec.path === '/' ? '' : spec.path}` || '/' : spec.path,
    ...(spec.component ? { component: spec.component } : {}),
    ...(spec.beforeLoad ? { beforeLoad: spec.beforeLoad as never } : {}),
  } as never) as AnyRoute;
  if (!spec.children) return route;
  return route.addChildren(spec.children.map((child) => instantiate(route, child, ''))) as AnyRoute;
}

/** The workspace routes, at the root and under `/$adminPath`. */
export function buildWorkspaceRoutes(parent: AnyRoute): AnyRoute[] {
  return [...SPEC.map((s) => instantiate(parent, s, '')), ...SPEC.map((s) => instantiate(parent, s, '/$adminPath'))];
}

/** `/$adminPath` itself opens the overview. */
export function adminHomeRedirect({ location }: { location: { pathname: string } }): never {
  throw redirect({ href: `${location.pathname.replace(/\/$/, '')}/overview`, replace: true });
}

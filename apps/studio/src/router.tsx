// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useNavigate,
} from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { WorkspaceShell } from './workspace/shell/workspace-shell';
import { adminHomeRedirect, buildWorkspaceRoutes } from './workspace/routes';
import { adminBaseRewrite } from './lib/admin-base';
import { BareLayout } from './components/bare-layout';
import { AdminReadyGate } from './modules/setup/admin-ready-gate';
import { shouldAutoRedirectToAdmin } from './modules/setup/setup-environment';
import { SetupLayout } from './modules/setup/setup-layout';
import { SetupStateGate } from './modules/setup/setup-state-gate';
import { useCompleteSetup } from './modules/setup/hooks/use-complete-setup';
import {
  getEarliestUnsatisfiedStep,
  useSetupStore,
} from './modules/setup/setup-store';

// ---------------------------------------------------------------------------
// The signed-in workspace routes live in `workspace/routes.tsx` (P07a,
// ADR-0019); this file keeps the setup wizard, recovery and sign-in.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Setup Wizard step components — lazy-loaded so the bootstrap chunk stays
// small for the (vastly more common) post-setup case where the operator
// loads the AppShell instead. The wizard is single-shot per instance, so
// shipping its bundle on the critical path would be wasted bytes for
// every authenticated admin page load.
// ---------------------------------------------------------------------------
const StepAccount = lazy(() => import('./modules/setup/steps/step-account').then((m) => ({ default: m.StepAccount })));
const StepPath = lazy(() => import('./modules/setup/steps/step-path').then((m) => ({ default: m.StepPath })));
const StepSecurity = lazy(() => import('./modules/setup/steps/step-security').then((m) => ({ default: m.StepSecurity })));
const StepProject = lazy(() => import('./modules/setup/steps/step-project').then((m) => ({ default: m.StepProject })));
const StepRecovery = lazy(() => import('./modules/setup/steps/step-recovery').then((m) => ({ default: m.StepRecovery })));
const StepDone = lazy(() => import('./modules/setup/steps/step-done').then((m) => ({ default: m.StepDone })));
const SimpleSetupWizard = lazy(() => import('./modules/setup/simple-setup-wizard').then((m) => ({ default: m.SimpleSetupWizard })));
const AdminLoginPage = lazy(() => import('./modules/auth/admin-login-page').then((m) => ({ default: m.AdminLoginPage })));

let setupBackupCodes: readonly string[] = [];

// ---------------------------------------------------------------------------
// Recovery pages — public, pre-auth UIs that call the CMS recovery endpoints
// (task 10.7). Lazy-loaded like the wizard steps so they stay off the
// critical path for the (far more common) authenticated AppShell load.
//
// Mounted as DIRECT children of `publicLayoutRoute` (siblings of
// `setupShellRoute`), NOT under the setup shell: recovery is for an
// ALREADY-initialized instance, so it must get `<BareLayout>` but must NOT
// run `SetupStateGate` (which 404s an initialized instance). See design §5.1.
// ---------------------------------------------------------------------------
const BackupCodePage = lazy(() => import('./modules/recovery/backup-code-page').then((m) => ({ default: m.BackupCodePage })));
const ForgotPathPage = lazy(() => import('./modules/recovery/forgot-path-page').then((m) => ({ default: m.ForgotPathPage })));

// ---------------------------------------------------------------------------
// Shared suspense boundary — shows a lightweight spinner while chunks load.
// ---------------------------------------------------------------------------
function PageLoader() {
  return (
    <div
      role="status"
      aria-label="Loading page"
      className="flex h-full items-center justify-center p-12"
    >
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

function withSuspense(Component: React.ComponentType) {
  return function SuspenseWrapper(props: Record<string, unknown>) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Component {...props} />
      </Suspense>
    );
  };
}

function SetupProjectWithComplete() {
  const navigate = useNavigate();
  const completeSetup = useCompleteSetup();

  return (
    <StepProject
      onSubmitted={() => {
        completeSetup.mutate(
          {},
          {
            onSuccess: (data) => {
              setupBackupCodes = data.backupCodes;
              navigate({ to: '/setup/recovery' });
            },
          },
        );
      }}
    />
  );
}

function AdminRootRedirect() {
  const navigate = useNavigate();
  const adminPath = useSetupStore((s) => s.adminPath);

  useEffect(() => {
    if (adminPath && shouldAutoRedirectToAdmin()) {
      navigate({ to: adminPath });
    }
  }, [adminPath, navigate]);

  if (adminPath && shouldAutoRedirectToAdmin()) {
    return <PageLoader />;
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div role="alert" className="w-full max-w-md rounded-md border bg-background p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Use the admin URL saved at the end of setup.
        </p>
      </div>
    </div>
  );
}

function AdminLoginRouteComponent() {
  const { adminPath } = adminLoginRoute.useParams();
  return (
    <Suspense fallback={<PageLoader />}>
      <AdminLoginPage adminPath={adminPath} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Route tree
//
// The root route renders only an <Outlet /> so the choice of chrome is
// delegated to two pathless layout routes:
//
//   • adminLayoutRoute — wraps children in <AppShell>, used by every existing
//     admin module (content, files, users, access, …).
//   • publicLayoutRoute — wraps children in <BareLayout> (no AppShell), used
//     by the first-time `/setup` wizard and `/recovery` flows. Children for
//     these are wired in subsequent tasks; the layout route is added now so
//     wizard pages can never accidentally inherit AppShell.
//
// See spec admin-setup-wizard, Req 2.5 and design §5.1.
// ---------------------------------------------------------------------------

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const adminLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'admin-layout',
  component: () => (
    <AdminReadyGate>
      <WorkspaceShell>
        <Outlet />
      </WorkspaceShell>
    </AdminReadyGate>
  ),
});

const publicLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'public-layout',
  component: BareLayout,
});

// ---------------------------------------------------------------------------
// Setup Wizard routes
//
// All four wizard routes live under a pathless parent (`setupShellRoute`)
// whose component wraps children in
//
//   <SetupStateGate>            ← talks to GET /setup/state, renders 404 /
//                                 retry / token prompt outside the chrome
//     <SetupLayout>             ← progress indicator + centered card
//       <Outlet />              ← active step
//     </SetupLayout>
//   </SetupStateGate>
//
// `SetupStateGate` is intentionally OUTSIDE `SetupLayout` so the gate's
// failure screens (already-initialized 404, retry UI, token prompt) never
// inherit the progress chrome — see design.md §5.1 / setup-state-gate.tsx.
//
// Deep-link guards live in each child's `beforeLoad`. They consult the
// Zustand store synchronously via `useSetupStore.getState()` and throw a
// `redirect(...)` to the earliest unsatisfied step — the helper
// `getEarliestUnsatisfiedStep` keeps the redirect target consistent with
// the state machine in design.md §5.4 / §11.2.
//
// Spec refs: Req 3.11; design.md §5.1, §5.4, §11.2.
// ---------------------------------------------------------------------------

const setupShellRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  id: 'setup-shell',
  component: () => (
    <SetupStateGate>
      <SetupLayout>
        <Outlet />
      </SetupLayout>
    </SetupStateGate>
  ),
});

/**
 * Index route for `/setup`. New operators land on the 3-step quick
 * setup by default. The full six-step flow remains available through
 * `/setup/advance` for advanced security/project tuning.
 */
const setupIndexRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup',
  beforeLoad: () => {
    throw redirect({ to: '/setup/account' });
  },
  // Component is unreachable because beforeLoad always redirects; kept
  // as a safety net so a future router quirk that bypasses beforeLoad
  // still renders a well-formed page.
  component: withSuspense(StepAccount),
});

const setupSimpleRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/setup/account',
  component: () => (
    <SetupStateGate>
      <Suspense fallback={<PageLoader />}>
        <SimpleSetupWizard />
      </Suspense>
    </SetupStateGate>
  ),
});

const setupAccountRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/advance',
  component: () => {
    const navigate = useNavigate();
    return (
      <Suspense fallback={<PageLoader />}>
        <StepAccount onSubmitted={() => navigate({ to: '/setup/path' })} />
      </Suspense>
    );
  },
});

const setupPathRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/path',
  beforeLoad: () => {
    // Operators must complete the Account step before they can pick
    // an admin path; deep-linking past Account redirects back.
    if (!useSetupStore.getState().accountValid) {
      throw redirect({ to: '/setup/advance' });
    }
  },
  component: () => {
    const navigate = useNavigate();
    return (
      <Suspense fallback={<PageLoader />}>
        <StepPath onSubmitted={() => navigate({ to: '/setup/security' })} />
      </Suspense>
    );
  },
});

/**
 * Security step — Phase C surface (Failed Attempts + Notifications)
 * lives in `step-security.tsx` (task 6.5). The route is wired here so
 * the Path step can navigate to it after submit, and so a deep-link
 * to `/setup/security` falls back to the earliest unsatisfied step
 * when prior gates (`accountValid`, `pathValid`) aren't met.
 *
 * Spec refs: requirements §3.11; design.md §5.1, §5.4, §11.2.
 */
const setupSecurityRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/security',
  beforeLoad: () => {
    // Earliest-unsatisfied-step guard: a deep-link to Security while
    // either Account or Path is still incomplete redirects back to
    // whichever step is missing. The helper is the single source of
    // truth for the redirect chain (design §5.4 / §11.2).
    const state = useSetupStore.getState();
    if (!state.accountValid || !state.pathValid) {
      throw redirect({ to: getEarliestUnsatisfiedStep(state) });
    }
  },
  component: () => {
    const navigate = useNavigate();
    return (
      <Suspense fallback={<PageLoader />}>
        <StepSecurity onSubmitted={() => navigate({ to: '/setup/project' })} />
      </Suspense>
    );
  },
});

const setupProjectRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/project',
  beforeLoad: () => {
    const state = useSetupStore.getState();
    if (!state.accountValid || !state.pathValid || !state.policyValid) {
      throw redirect({ to: getEarliestUnsatisfiedStep(state) });
    }
  },
  component: () => {
    return (
      <Suspense fallback={<PageLoader />}>
        <SetupProjectWithComplete />
      </Suspense>
    );
  },
});

const setupRecoveryRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/recovery',
  beforeLoad: () => {
    const state = useSetupStore.getState();
    if (
      !state.accountValid ||
      !state.pathValid ||
      !state.policyValid ||
      !state.projectValid ||
      !state.completed
    ) {
      throw redirect({ to: getEarliestUnsatisfiedStep(state) });
    }
  },
  component: () => {
    const navigate = useNavigate();
    return (
      <Suspense fallback={<PageLoader />}>
        <StepRecovery
          backupCodes={setupBackupCodes}
          onFinish={() => navigate({ to: '/setup/done' })}
        />
      </Suspense>
    );
  },
});

const setupDoneRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/done',
  beforeLoad: () => {
    // The Done step is the wizard's terminal state. If the operator
    // hasn't actually completed the flow yet, send them to whatever
    // step is still outstanding so the URL stays honest.
    const state = useSetupStore.getState();
    if (!state.completed || !state.confirmed) {
      throw redirect({ to: getEarliestUnsatisfiedStep(state) });
    }
  },
  component: withSuspense(StepDone),
});

// ---------------------------------------------------------------------------
// Recovery routes
//
// `/recovery/backup-code` and `/recovery/forgot-path` are the public,
// pre-auth recovery UIs (task 10.8; Req 14.4, 14.5). They mount as DIRECT
// children of `publicLayoutRoute` — siblings of `setupShellRoute`, NOT
// children of it — for two reasons (design §5.1):
//
//   1. They need `<BareLayout>` (no AppShell), which `publicLayoutRoute`
//      provides.
//   2. They must NOT run `SetupStateGate`. The gate renders a hard 404 on an
//      `initialized` instance, but recovery is specifically FOR an already-
//      initialized instance whose operator is locked out. Nesting under
//      `setupShellRoute` would make recovery permanently unreachable.
//
// No `beforeLoad` guard: recovery is reachable at any time (the operator is
// locked out, by definition) and the pages own their own state.
// ---------------------------------------------------------------------------

const recoveryBackupCodeRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/recovery/backup-code',
  component: withSuspense(BackupCodePage),
});

const recoveryForgotPathRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/recovery/forgot-path',
  component: withSuspense(ForgotPathPage),
});

const adminPathRecoveryBackupCodeRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/$adminPath/recovery/backup-code',
  component: withSuspense(BackupCodePage),
});

const adminPathRecoveryForgotPathRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/$adminPath/recovery/forgot-path',
  component: withSuspense(ForgotPathPage),
});

const adminLoginRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/$adminPath/login',
  component: AdminLoginRouteComponent,
});

const indexRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/',
  component: AdminRootRedirect,
});

const adminPathIndexRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath',
  beforeLoad: adminHomeRedirect,
});

const routeTree = rootRoute.addChildren([
  adminLayoutRoute.addChildren([indexRoute, adminPathIndexRoute, ...buildWorkspaceRoutes(adminLayoutRoute)]),
  publicLayoutRoute.addChildren([
    setupSimpleRoute,
    setupShellRoute.addChildren([
      setupIndexRoute,
      setupAccountRoute,
      setupPathRoute,
      setupSecurityRoute,
      setupProjectRoute,
      setupRecoveryRoute,
      setupDoneRoute,
    ]),
    recoveryBackupCodeRoute,
    recoveryForgotPathRoute,
    adminPathRecoveryBackupCodeRoute,
    adminPathRecoveryForgotPathRoute,
    adminLoginRoute,
  ]),
]);

export const router = createRouter({ routeTree, rewrite: adminBaseRewrite });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { router } from './router';
import { initI18n } from './lib/i18n';
import { SiteThemeStyle } from './components/site-theme';
import { getApiBaseUrl } from './lib/api-base';
import { isDesktopShell } from './lib/shell';
import { ServerConnection } from './components/server-connection';
import { hydrateSession, locksSupported } from './lib/session/current';

/**
 * Root component. Hands off to TanStack Router; AppShell + active module
 * detection live inside the router tree.
 *
 * Inside the desktop/mobile shell the bundled SPA has no backend until the
 * user picks a server, so we gate on a resolved API base first.
 */
export function App() {
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(() => !isDesktopShell() || Boolean(getApiBaseUrl()));

  useEffect(() => {
    // Load this tab's session (OS keychain in the shell) before the router
    // reads it, in parallel with i18n init.
    Promise.all([initI18n(), hydrateSession()]).finally(() => setReady(true));
  }, []);

  // Sessions are renewed under a cross-tab lock (P04): without Web Locks two
  // tabs would end each other's login. Every current browser has it.
  if (!locksSupported()) {
    return (
      <div className="flex h-screen items-center justify-center p-6 text-center text-sm text-muted-foreground">
        This browser is not supported by HeoPress Studio: it lacks the Web Locks API. Please use a current version of
        Chrome, Edge, Firefox or Safari.
      </div>
    );
  }

  if (!ready) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading Studio…</div>;
  }

  if (!connected) {
    return <ServerConnection onConnected={() => setConnected(true)} />;
  }

  return (
    <>
      <SiteThemeStyle />
      <RouterProvider router={router} />
    </>
  );
}

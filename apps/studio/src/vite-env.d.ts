// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute origin of the HeoPress CMS API (e.g. `https://api.heopress.example`).
   * Unset in dev/Docker so the Studio uses same-origin requests; set at build
   * time for standalone (Cloudflare Pages) deployments. See `lib/api-base.ts`.
   */
  readonly VITE_API_URL?: string;
  readonly VITE_HEOPRESS_VERSION?: string;
  readonly VITE_HEOPRESS_GIT_SHA?: string;
  readonly VITE_HEOPRESS_BUILD_TIME?: string;
  readonly VITE_HEOPRESS_RELEASE_CHANNEL?: string;
  readonly VITE_HEOPRESS_ALLOW_ADMIN_PATH_REDIRECT?: string;
}

/**
 * Virtual module provided by the dev-only Vite plugin `heopress:dev-extensions`
 * (see `vite-plugins/dev-extensions.ts`). It exposes UI extensions auto-detected
 * from the source `extensions/` folder so Studio can load them in dev without a
 * published bundle. Resolves to an empty list in production builds.
 */
declare module 'virtual:heopress-extensions' {
  export const devExtensions: Array<{
    name: string;
    type: 'interface' | 'display' | 'layout' | 'panel' | 'module';
    load: () => Promise<unknown>;
  }>;
}

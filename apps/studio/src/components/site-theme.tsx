// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getApiClient, hasActiveToken } from '@/lib/api';
import { useAppearance } from '@/theme/appearance';

/**
 * Applies the active site's theme to Studio at runtime:
 *  - injects whitelisted CSS-variable overrides into `:root` (light) and
 *    `.dark` from `themeOverrides`, plus `--primary` from the brand color,
 *  - appends the site's raw `customCss` after the token block,
 *  - hands the site's default appearance to the appearance store
 *    (`theme/appearance.ts`), which paints the root element.
 *
 * Resolution order for appearance: the user's Studio preference → site
 * default → system. Branding/overrides/custom CSS are global to
 * the site. Renders nothing — it only manages a `<style>` element + the
 * root `dark` class.
 */

const STYLE_ID = 'heopress-site-theme';

/** Subset mirroring SiteResource fields this component reads. */
interface SiteThemeData {
  defaultAppearance?: string;
  branding?: { brandColor?: string };
  themeOverrides?: { light?: Record<string, string>; dark?: Record<string, string> };
  customCss?: string | null;
}

const VALID_TOKEN = /^--[a-z-]+$/;
/** shadcn names that Carbon reuses for hex tokens: their HSL overrides go to the alias (ADR-0019). */
const ALIASED: Record<string, string> = { '--muted': '--muted-hsl', '--accent': '--accent-hsl' };
const HSL_TRIPLE = /^\d{1,3}(\.\d+)?\s+\d{1,3}(\.\d+)?%\s+\d{1,3}(\.\d+)?%$/;
const CSS_LENGTH = /^(0|\d{1,3}(\.\d+)?(px|rem|em))$/;

/** Render one `selector { --token: value; … }` rule from an override map. */
function ruleBlock(selector: string, vars: Record<string, string>): string {
  const decls = Object.entries(vars)
    .filter(([token, value]) => {
      if (!VALID_TOKEN.test(token)) return false;
      return token === '--radius' ? CSS_LENGTH.test(value) : HSL_TRIPLE.test(value);
    })
    .map(([token, value]) => `  ${ALIASED[token] ?? token}: ${value};`)
    .join('\n');
  return decls ? `${selector} {\n${decls}\n}` : '';
}

function buildCss(site: SiteThemeData): string {
  const overrides = site.themeOverrides ?? {};
  const light = { ...(overrides.light ?? {}) };
  // Brand color maps onto the primary action token for both modes unless an
  // explicit override already set it.
  const brand = site.branding?.brandColor;
  if (brand && HSL_TRIPLE.test(brand) && !light['--primary']) {
    light['--primary'] = brand;
  }
  const blocks = [
    ruleBlock(':root', light),
    ruleBlock('.dark', overrides.dark ?? {}),
  ].filter(Boolean);

  // Raw custom CSS last so it can win. Defense-in-depth: strip any closing
  // </style> the server validation might have missed.
  const custom = (site.customCss ?? '').replace(/<\/\s*style\s*>/gi, '');
  if (custom.trim()) blocks.push(custom);

  return blocks.join('\n\n');
}

export function SiteThemeStyle() {
  const siteQuery = useQuery({
    queryKey: ['site-config'],
    queryFn: async () => (await getApiClient().site.get()).data,
    enabled: hasActiveToken(),
    staleTime: 60_000,
  });

  const site = siteQuery.data as SiteThemeData | undefined;
  const setSiteDefault = useAppearance((st) => st.setSiteDefault);

  useEffect(() => {
    if (!site) return;
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = buildCss(site);

    // The user's own choice (ADR-0019 §5.8) wins; the site default only fills in.
    setSiteDefault(site.defaultAppearance);
  }, [site, setSiteDefault]);

  return null;
}

export default SiteThemeStyle;

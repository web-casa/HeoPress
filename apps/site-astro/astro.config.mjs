// The Astro engine's build template (HeoPress P11 tasks 3.1, 3.6; spec rendering/astro-engine).
//
// Run by the build runner (`src/builder`) in an isolated child process, with only these variables:
//   HEOPRESS_PAGE_DATA_URL / HEOPRESS_PAGE_DATA_TOKEN  the read-only page data interface and this build's one-time token;
//   HEOPRESS_ASTRO_THEME_DIR                           the theme (official or the operator's own, under ./themes);
//   HEOPRESS_ASTRO_OUT_DIR                             where this build's output goes (a new directory per build);
//   HEOPRESS_ASTRO_INTEGRATIONS                        the integrations the operator approved (comma-separated).
import { defineConfig } from 'astro/config';
import { heopressPageData, themeOf } from './src/integration.mjs';

const theme = themeOf(process.env.HEOPRESS_ASTRO_THEME_DIR);
const approved = (process.env.HEOPRESS_ASTRO_INTEGRATIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const extra = [];
for (const name of theme.integrations) {
  if (!approved.includes(name)) throw new Error(`theme integration not approved by the operator: ${name}`);
  const mod = await import(name);
  extra.push(mod.default());
}

export default defineConfig({
  output: 'static',
  outDir: process.env.HEOPRESS_ASTRO_OUT_DIR || './dist',
  cacheDir: process.env.HEOPRESS_ASTRO_OUT_DIR ? `${process.env.HEOPRESS_ASTRO_OUT_DIR}.cache` : './node_modules/.astro',
  build: { format: 'directory', assets: '_astro' },
  trailingSlash: 'ignore',
  devToolbar: { enabled: false },
  integrations: [heopressPageData({ url: process.env.HEOPRESS_PAGE_DATA_URL, token: process.env.HEOPRESS_PAGE_DATA_TOKEN }), ...extra],
  vite: { resolve: { alias: { 'heopress:theme': theme.entry } } },
});

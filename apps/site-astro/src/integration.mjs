// The page data integration of the build template (HeoPress P11 tasks 3.1, 3.6): reads the pinned snapshot from the
// read-only page data interface once, offers it to the pages as `virtual:heopress/page-data`, and writes the site's
// machine-readable files (robots.txt, sitemaps, feeds, llms.txt, Markdown copies, root files) exactly as served.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPageDataSnapshot } from '@heopress/contracts/page-data';

const VIRTUAL = 'virtual:heopress/page-data';
const RESOLVED = `\0${VIRTUAL}`;
const THEMES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'themes');

/** The theme at `dir` (inside ./themes): its entry component and the integrations it asks for. */
export function themeOf(dir) {
  if (!dir) throw new Error('HEOPRESS_ASTRO_THEME_DIR is not set');
  const real = realpathSync(dir);
  if (!real.startsWith(realpathSync(THEMES) + sep)) throw new Error('the theme must be under the template\'s themes directory');
  const pkg = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
  const manifest = pkg.heopress?.astroTheme;
  if (!manifest || typeof manifest.entry !== 'string') throw new Error('not an Astro theme: package.json has no heopress.astroTheme.entry');
  const entry = resolve(real, manifest.entry);
  if (!entry.startsWith(real + sep)) throw new Error('theme entry outside the theme');
  const integrations = Array.isArray(manifest.integrations) ? manifest.integrations.map(String) : [];
  return { dir: real, entry, integrations };
}

async function load(url, token) {
  if (!url || !token) throw new Error('HEOPRESS_PAGE_DATA_URL and HEOPRESS_PAGE_DATA_TOKEN are required');
  const u = new URL(url);
  const loopback = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost');
  if (!loopback && u.protocol !== 'https:') throw new Error('the page data interface must be https or on the loopback interface');
  const res = await fetch(u, { headers: { authorization: `Bearer ${token}` }, redirect: 'error' });
  if (!res.ok) throw new Error(`page data interface answered ${res.status}`);
  const snapshot = await res.json();
  assertPageDataSnapshot(snapshot);
  return snapshot;
}

export function heopressPageData({ url, token }) {
  let snapshot = null;
  return {
    name: 'heopress:page-data',
    hooks: {
      'astro:config:setup': async ({ updateConfig }) => {
        snapshot = await load(url, token);
        const code = `export default ${JSON.stringify(snapshot)};`;
        updateConfig({
          site: snapshot.origin,
          vite: {
            plugins: [
              {
                name: 'heopress:page-data',
                resolveId: (id) => (id === VIRTUAL ? RESOLVED : null),
                load: (id) => (id === RESOLVED ? code : null),
              },
            ],
          },
        });
      },
      'astro:build:done': async ({ dir }) => {
        const root = fileURLToPath(dir);
        for (const file of snapshot.files) {
          const target = resolve(root, `.${decodeURI(file.path)}`);
          if (!target.startsWith(resolve(root) + sep)) throw new Error(`file outside the output: ${file.path}`);
          const taken = await access(target).then(() => true, () => false);
          if (taken) throw new Error(`a page and a file both claim ${file.path}`);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.body);
        }
      },
    },
  };
}

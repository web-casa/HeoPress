// The page data integration of the build template (HeoPress P11 tasks 3.1, 3.6): reads the pinned snapshot from the
// read-only page data interface once, offers it to the pages as `virtual:heopress/page-data`, and writes the site's
// machine-readable files (robots.txt, sitemaps, feeds, llms.txt, Markdown copies, root files) exactly as served.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPageDataSnapshot } from '@heopress/contracts/page-data';

const VIRTUAL = 'virtual:heopress/page-data';
const RESOLVED = `\0${VIRTUAL}`;
const THEMES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'themes');
const EXT_PREFIX = 'heopress:ext/';
const EXT_TEMPLATES = 'virtual:heopress/ext-templates';
const EXT_TEMPLATES_RESOLVED = `\0${EXT_TEMPLATES}`;
const EXT_STUB = resolve(dirname(fileURLToPath(import.meta.url)), 'ext-stub.astro');
const EXT_KEY = /^[a-z][a-z0-9_]*\/(components\/)?[a-z][a-z0-9_-]*$/;

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
  // The theme's own versions of plugin route templates (P12 task 2.3): `"<namespace>/<template>": "src/X.astro"`.
  const extensionTemplates = {};
  for (const [key, file] of Object.entries(manifest.extensionTemplates ?? {})) {
    if (!EXT_KEY.test(key) || key.includes('/components/') || typeof file !== 'string') throw new Error(`bad extensionTemplates entry: ${key}`);
    const path = resolve(real, file);
    if (!path.startsWith(real + sep) || !path.endsWith('.astro')) throw new Error(`extension template outside the theme: ${key}`);
    extensionTemplates[key] = path;
  }
  return { dir: real, entry, integrations, extensionTemplates };
}

/**
 * The site's plugins in the build (HeoPress P12 tasks 2.3, 2.4). `dir` holds the plugin sources the runner staged
 * (`<namespace>/<template>.astro`, `<namespace>/components/<name>.astro`, under ./themes/.ext).
 *
 *  - `heopress:ext/<namespace>/<name>` is a plugin component; a theme places it where it wants it. While no enabled
 *    plugin provides it, it resolves to a component that renders nothing.
 *  - `virtual:heopress/ext-templates` maps `<namespace>/<template>` to the component a plugin route page renders with:
 *    the theme's override when it has one, else the plugin's default.
 */
export function heopressExtensions({ dir, theme }) {
  let root = null;
  if (dir) {
    const real = realpathSync(dir);
    if (!real.startsWith(realpathSync(THEMES) + sep)) throw new Error('plugin sources must be under the template\'s themes directory');
    root = real;
  }
  const staged = (key) => {
    if (!root || !EXT_KEY.test(key)) return null;
    const file = resolve(root, `${key}.astro`);
    return file.startsWith(root + sep) && existsSync(file) ? file : null;
  };
  const templates = () => {
    const keys = new Set(Object.keys(theme.extensionTemplates));
    if (root) {
      for (const ns of readdirSafe(root)) {
        for (const f of readdirSafe(join(root, ns))) if (f.endsWith('.astro')) keys.add(`${ns}/${f.slice(0, -'.astro'.length)}`);
      }
    }
    const lines = [];
    const entries = [];
    [...keys].filter((k) => EXT_KEY.test(k) && !k.includes('/components/')).sort().forEach((key, i) => {
      const file = theme.extensionTemplates[key] ?? staged(key);
      if (!file) return;
      lines.push(`import T${i} from ${JSON.stringify(file)};`);
      entries.push(`${JSON.stringify(key)}: T${i}`);
    });
    return `${lines.join('\n')}\nexport default { ${entries.join(', ')} };`;
  };
  return {
    name: 'heopress:extensions',
    resolveId(id) {
      if (id === EXT_TEMPLATES) return EXT_TEMPLATES_RESOLVED;
      if (!id.startsWith(EXT_PREFIX)) return null;
      const [ns, name, ...rest] = id.slice(EXT_PREFIX.length).split('/');
      if (!ns || !name || rest.length) throw new Error(`not a plugin component: ${id}`);
      return staged(`${ns}/components/${name}`) ?? EXT_STUB;
    },
    load: (id) => (id === EXT_TEMPLATES_RESOLVED ? templates() : null),
  };
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
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

import { cp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, relative, resolve, sep } from 'node:path';
import { templateDir } from './runner';

/**
 * Astro themes (HeoPress P11 tasks 3.5, 3.6; spec rendering/astro-engine "主题为标准 Astro 组件包"):
 *
 *   - v1 builds only official themes (`official:<name>`, shipped under the template's `themes/`) and the operator's own
 *     (`operator:<name>`, from the operator's theme directory, copied under `themes/.operator/` for the build). Nothing
 *     else is accepted: no marketplace, no URL, no theme an agent uploaded.
 *   - A theme is a standard Astro component package: `package.json` with `heopress.astroTheme.entry` (the component
 *     that receives `page`) and the integrations it needs — each must be on the operator's approved list.
 *   - Its data comes from the page data contract only: a theme's source may not read the environment, fetch, open
 *     files or sockets, or name the CMS's administration or API paths; it writes no canonical and no JSON-LD (the
 *     system head does) and places the system head with the kit.
 */

const OFFICIAL = ['starter'];

/** An official theme's directory (shipped under the template's `themes/`), or null. */
export function officialThemeDir(name: string): string | null {
  return OFFICIAL.includes(name) ? join(templateDir(), 'themes', name) : null;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SOURCE_EXT = new Set(['.astro', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.mts', '.md', '.mdx', '.json', '.css']);
const MAX_THEME_BYTES = 20 * 1024 * 1024;

/** What a theme's code may not do (data only through the page data contract). */
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /\bprocess\s*\.\s*env\b|\bimport\.meta\.env\b|astro:env/, why: 'reads the environment' },
  { re: /\bfetch\s*\(|XMLHttpRequest|\bWebSocket\b|\bEventSource\b/, why: 'makes network requests' },
  { re: /['"](?:node:)?(?:fs|fs\/promises|child_process|net|http|https|dgram|worker_threads|vm|tls|dns)['"]/, why: 'imports a system module' },
  { re: /(?:['"`]|\/\/[^/'"`\s]+)\/(?:api|admin|internal)(?:\/|['"`])/, why: 'names a CMS administration or API path' },
  { re: /application\/ld\+json/, why: 'writes JSON-LD (the system head carries the page\'s one graph)' },
  { re: /rel\s*=\s*["']canonical["']/, why: 'writes a canonical (the system head does)' },
  { re: /\bset:html\b/, why: 'writes raw markup (the kit\'s components place the system\'s content)' },
];

export interface ThemeRef {
  kind: 'official' | 'operator';
  name: string;
}

export function parseThemeRef(ref: string): ThemeRef {
  const m = /^(official|operator):(.+)$/.exec(ref);
  if (!m || !NAME.test(m[2]!)) throw new Error(`not an accepted theme: ${ref} (v1 accepts official:<name> and operator:<name>)`);
  if (m[1] === 'official' && !officialThemeDir(m[2]!)) throw new Error(`no official theme ${m[2]}`);
  return { kind: m[1] as ThemeRef['kind'], name: m[2]! };
}

export interface ThemeIssue {
  file: string;
  message: string;
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isSymbolicLink()) throw new Error(`symbolic link in theme: ${relative(dir, p)}`);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(dir);
  return out.sort();
}

/** Check a theme directory; empty when it may be built. */
export async function checkAstroTheme(dir: string, opts: { approvedIntegrations?: string[] } = {}): Promise<ThemeIssue[]> {
  const issues: ThemeIssue[] = [];
  let pkg: { heopress?: { astroTheme?: { entry?: unknown; integrations?: unknown } }; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    return [{ file: 'package.json', message: 'missing or not JSON' }];
  }
  const manifest = pkg.heopress?.astroTheme;
  if (!manifest || typeof manifest.entry !== 'string') return [{ file: 'package.json', message: 'no heopress.astroTheme.entry' }];
  const entry = resolve(dir, manifest.entry);
  if (!entry.startsWith(resolve(dir) + sep) || extname(entry) !== '.astro') issues.push({ file: 'package.json', message: 'the entry must be an .astro component inside the theme' });
  const integrations = Array.isArray(manifest.integrations) ? manifest.integrations.map(String) : [];
  for (const name of integrations) {
    if (!(opts.approvedIntegrations ?? []).includes(name)) issues.push({ file: 'package.json', message: `integration not approved by the operator: ${name}` });
  }
  let all: string[];
  try {
    all = await files(dir);
  } catch (err) {
    return [...issues, { file: '.', message: (err as Error).message }];
  }
  let bytes = 0;
  let placesHead = false;
  for (const f of all) {
    const rel = relative(dir, f);
    bytes += (await stat(f)).size;
    if (!SOURCE_EXT.has(extname(f))) continue;
    const text = await readFile(f, 'utf8');
    if (rel === 'package.json') continue;
    for (const { re, why } of FORBIDDEN) if (re.test(text)) issues.push({ file: rel, message: why });
    if (/@heopress\/astro-kit\/SeoHead\.astro/.test(text)) placesHead = true;
  }
  if (bytes > MAX_THEME_BYTES) issues.push({ file: '.', message: 'theme too large' });
  if (!placesHead) issues.push({ file: '.', message: 'the theme never places the system head (@heopress/astro-kit/SeoHead.astro)' });
  return issues;
}

/**
 * The directory a build uses for `ref`: an official theme's own, or the operator's theme copied under the template
 * (`themes/.operator/<name>-<hash>`), so it resolves Astro and the kit from the template.
 */
export async function stageTheme(ref: ThemeRef, opts: { operatorThemesDir?: string } = {}): Promise<string> {
  if (ref.kind === 'official') return officialThemeDir(ref.name)!;
  if (!opts.operatorThemesDir) throw new Error('no operator theme directory is configured (HEOPRESS_ASTRO_OPERATOR_THEMES)');
  const source = resolve(opts.operatorThemesDir, ref.name);
  if (!source.startsWith(resolve(opts.operatorThemesDir) + sep)) throw new Error('theme outside the operator theme directory');
  const hash = createHash('sha256');
  for (const f of await files(source)) hash.update(relative(source, f)).update(await readFile(f));
  const target = join(templateDir(), 'themes', '.operator', `${ref.name}-${hash.digest('hex').slice(0, 16)}`);
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true, filter: (p) => !p.split(sep).includes('node_modules') });
  return target;
}

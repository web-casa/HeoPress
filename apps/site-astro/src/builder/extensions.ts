import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { templateSourceProblems } from '@heopress/contracts/extensions';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { templateDir } from './runner';

/**
 * The Astro sources of a site's enabled plugins (HeoPress P12 tasks 2.3, 2.4), staged for one build as `stageTheme`
 * stages an operator theme: written under the template (`themes/.ext/<hash>/`), so they resolve Astro and the kit from
 * it, and named to the build by `HEOPRESS_ASTRO_EXT_DIR`. Each is checked again before it is written (the page data
 * contract only: no environment, network, dynamic code, script, JSON-LD or raw markup); a failing one fails the build
 * at its theme stage, and the live version stays.
 */

const KEY = /^[a-z][a-z0-9_]*\/(components\/)?[a-z][a-z0-9_-]*$/;

export interface ExtensionIssue {
  key: string;
  message: string;
}

/** Problems of the snapshot's plugin sources (empty: they may be built). */
export function checkExtensionSources(snapshot: PageDataSnapshot): ExtensionIssue[] {
  const issues: ExtensionIssue[] = [];
  for (const [key, source] of Object.entries(snapshot.extensions?.astro ?? {})) {
    if (!KEY.test(key)) {
      issues.push({ key, message: 'not a plugin template or component name' });
      continue;
    }
    for (const message of templateSourceProblems(source, 'astro', key.includes('/components/'))) issues.push({ key, message });
  }
  return issues;
}

/** Write the snapshot's plugin sources for a build; null when it has none. */
export async function stageExtensions(snapshot: PageDataSnapshot): Promise<string | null> {
  const ext = snapshot.extensions;
  if (!ext || !ext.hash || Object.keys(ext.astro).length === 0) return null;
  const root = join(templateDir(), 'themes', '.ext', ext.hash.replace(/[^a-z0-9]/gi, '').slice(0, 32) || 'none');
  for (const [key, source] of Object.entries(ext.astro)) {
    if (!KEY.test(key)) continue;
    const file = resolve(root, `${key}.astro`);
    if (!file.startsWith(resolve(root) + sep)) continue;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  return root;
}

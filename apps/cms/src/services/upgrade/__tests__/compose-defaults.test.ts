/**
 * `heopress upgrade`'s defaults against the Compose files they name: `docker compose up` refuses a service name that
 * is not in the project, so a default that drifted from the files makes the switch fail (it once named `worker` and
 * `site` for `cms-worker` and `site-classic`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { DEFAULT_COMPOSE_ARGS, DEFAULT_UPGRADE_SERVICES } from '../adapters/compose-app';

const ROOT = path.resolve(__dirname, '../../../../../..');

/** The compose files the default arguments name, in order (`-f <file>`). */
function composeFiles(args: readonly string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' || args[i] === '--file') files.push(args[++i]!);
  }
  return files;
}

/** Each service of the merged files, with the image it ends up with (a later file overrides an earlier one). */
function services(files: string[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const file of files) {
    // `!reset` / `!override` are Compose's own tags; their values are kept as they are.
    const doc = parseDocument(readFileSync(path.join(ROOT, file), 'utf8'), { merge: true, customTags: [
      { tag: '!reset', resolve: (v: unknown) => v },
      { tag: '!override', resolve: (v: unknown) => v },
      { tag: '!reset', collection: 'seq', resolve: (v: unknown) => v },
      { tag: '!override', collection: 'seq', resolve: (v: unknown) => v },
      { tag: '!override', collection: 'map', resolve: (v: unknown) => v },
    ] });
    expect(doc.errors, file).toEqual([]);
    const parsed = doc.toJS() as { services?: Record<string, { image?: unknown } | null> };
    for (const [name, svc] of Object.entries(parsed.services ?? {})) {
      const image = typeof svc?.image === 'string' ? svc.image : undefined;
      out.set(name, image ?? out.get(name));
    }
  }
  return out;
}

describe('heopress upgrade defaults match the Compose files', () => {
  it('names files that exist and services they define', () => {
    const files = composeFiles(DEFAULT_COMPOSE_ARGS);
    expect(files).toEqual(['docker/docker-compose.yml', 'docker/docker-compose.prod.yml']);
    const defined = [...services(files).keys()];
    for (const svc of DEFAULT_UPGRADE_SERVICES) expect(defined, `service "${svc}"`).toContain(svc);
  });

  it('switches exactly the services whose image is the pinned release (HEOPRESS_VERSION)', () => {
    const pinned = [...services(composeFiles(DEFAULT_COMPOSE_ARGS))]
      .filter(([, image]) => image?.includes('${HEOPRESS_VERSION'))
      .map(([name]) => name);
    expect([...DEFAULT_UPGRADE_SERVICES].sort()).toEqual(pinned.sort());
  });

  it('names services of an installation made by docker/install.sh too (its own Compose files, same service names)', () => {
    const installed = services([
      'docker/docker-compose.yml',
      'docker/docker-compose.prod.yml',
      'docker/docker-compose.tls.yml',
      'docker/docker-compose.domains.yml',
      'docker/docker-compose.install.yml',
    ]);
    for (const svc of DEFAULT_UPGRADE_SERVICES) expect([...installed.keys()], `service "${svc}"`).toContain(svc);
  });
});

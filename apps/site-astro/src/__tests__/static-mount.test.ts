import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyStaticMount } from '../builder/mount';

/**
 * The static directory mount in an Astro artifact (v1.5, spec `publishing/static-directory-mount`): the directory is
 * copied after the build, HeoPress's own output is never replaced, symbolic links are not followed and the metadata file
 * stays out of the deployment.
 */

describe('copying a static mount into a build', () => {
  let base: string;
  let mount: string;
  let out: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'heopress-astro-mount-'));
    mount = join(base, 'mount');
    out = join(base, 'out');
    await mkdir(join(mount, 'legacy'), { recursive: true });
    await mkdir(join(mount, '.well-known'), { recursive: true });
    await mkdir(join(mount, '.git'), { recursive: true });
    await mkdir(join(out, 'legacy'), { recursive: true });
    await writeFile(join(mount, 'legacy', 'about.html'), '<p>archive</p>');
    await writeFile(join(mount, 'legacy', 'taken.html'), '<p>mount</p>');
    await writeFile(join(mount, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
    await writeFile(join(mount, 'static-urls.txt'), '/legacy/about.html\n');
    await writeFile(join(mount, '.well-known', 'security.txt'), 'Contact: mailto:security@example.com\n');
    await writeFile(join(mount, '.git', 'config'), '[core]\n');
    await writeFile(join(base, 'secret.txt'), 'outside');
    await symlink(join(base, 'secret.txt'), join(mount, 'link.txt'));
    // HeoPress's own output: a page and the generated robots.txt.
    await writeFile(join(out, 'legacy', 'taken.html'), '<p>HeoPress</p>');
    await writeFile(join(out, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('copies ordinary files, keeps the engine output, skips links, hidden entries and the metadata file', async () => {
    const report = await copyStaticMount(out, mount);
    expect(await readFile(join(out, 'legacy', 'about.html'), 'utf8')).toBe('<p>archive</p>');
    // HeoPress wins: the page and the generated robots.txt are not replaced.
    expect(await readFile(join(out, 'legacy', 'taken.html'), 'utf8')).toBe('<p>HeoPress</p>');
    expect(await readFile(join(out, 'robots.txt'), 'utf8')).toBe('User-agent: *\nAllow: /\n');
    // `.well-known` is content; other hidden trees and the metadata file are not.
    expect(await readFile(join(out, '.well-known', 'security.txt'), 'utf8')).toBe('Contact: mailto:security@example.com\n');
    expect(existsSync(join(out, '.git', 'config'))).toBe(false);
    expect(existsSync(join(out, 'static-urls.txt'))).toBe(false);
    expect(existsSync(join(out, 'link.txt'))).toBe(false);
    expect(existsSync(join(out, 'secret.txt'))).toBe(false);
    expect(report).toEqual({ copied: 2, kept: 2, skipped: 3 });
  });
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkStaticDirectory, StaticMountUpdateSchema } from '../static-mount-service';

/**
 * The static directory setting's validation (v1.5, spec `rendering/static-directory-mount`): the operator's
 * `HEOPRESS_STATIC_ROOT` bounds every mount, the saved value is the resolved directory, and an invalid path is refused
 * with a code the route can answer. The database side (versions, isolation, the projection) is covered by
 * `static-mount.db.integration.test.ts`.
 */

describe('the static directory setting', () => {
  let base: string;
  let root: string;
  let mount: string;
  let outside: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'heopress-static-check-'));
    root = join(base, 'root');
    mount = join(root, 'site');
    outside = join(base, 'outside');
    await mkdir(mount, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(base, 'file.txt'), 'x');
    await writeFile(join(root, 'file.txt'), 'x');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('accepts an empty value without a root (nothing is mounted)', async () => {
    expect(await checkStaticDirectory(null, '')).toEqual({ ok: true, directory: '' });
    expect(await checkStaticDirectory(root, '   ')).toEqual({ ok: true, directory: '' });
  });

  it('refuses any directory when no root is configured', async () => {
    expect(await checkStaticDirectory(null, mount)).toMatchObject({ ok: false, code: 'ROOT_NOT_CONFIGURED' });
    expect(await checkStaticDirectory('', mount)).toMatchObject({ ok: false, code: 'ROOT_NOT_CONFIGURED' });
  });

  it('refuses a relative path or a control character as invalid before touching the file system', async () => {
    expect(await checkStaticDirectory(root, 'relative/dir')).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    expect(await checkStaticDirectory(root, '/tmp/a\u0000b')).toMatchObject({ ok: false, code: 'INVALID_PATH' });
  });

  it('refuses a directory outside the root, a missing one, and a file', async () => {
    expect(await checkStaticDirectory(root, outside)).toMatchObject({ ok: false, code: 'OUTSIDE_ROOT' });
    expect(await checkStaticDirectory(root, join(root, 'missing'))).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    // A file is not a directory, wherever it sits.
    expect(await checkStaticDirectory(root, join(base, 'file.txt'))).toMatchObject({ ok: false, code: 'NOT_DIRECTORY' });
    expect(await checkStaticDirectory(root, join(root, 'file.txt'))).toMatchObject({ ok: false, code: 'NOT_DIRECTORY' });
    await writeFile(join(root, 'a-file'), 'x');
    expect(await checkStaticDirectory(root, join(root, 'a-file'))).toMatchObject({ ok: false, code: 'NOT_DIRECTORY' });
  });

  it('accepts the root itself and a directory under it, resolving the path it saves', async () => {
    expect(await checkStaticDirectory(root, root)).toMatchObject({ ok: true, directory: root });
    expect(await checkStaticDirectory(root, mount)).toEqual({ ok: true, directory: mount });
    // `..` segments are resolved before the containment check, not trusted as written.
    expect(await checkStaticDirectory(root, join(root, 'site', '..', 'site'))).toEqual({ ok: true, directory: mount });
    expect(await checkStaticDirectory(root, join(root, '..', 'outside'))).toMatchObject({ ok: false, code: 'OUTSIDE_ROOT' });
  });

  it('parses the write against its version and nothing else', () => {
    expect(StaticMountUpdateSchema.safeParse({ directory: '/x', version: 3 }).success).toBe(true);
    expect(StaticMountUpdateSchema.safeParse({ directory: '/x' }).success).toBe(false);
    expect(StaticMountUpdateSchema.safeParse({ directory: '/x', version: -1 }).success).toBe(false);
  });
});

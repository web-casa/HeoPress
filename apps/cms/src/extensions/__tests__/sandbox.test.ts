// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityError, ExtensionSandbox, type CapabilityDeniedEvent, type ExtensionActorDataAccess } from '../sandbox';

/** The sandbox context as a plugin sees it. */
interface Ctx {
  items: {
    list(collection: string, params?: Record<string, unknown>): Promise<unknown>;
    detail(collection: string, id: string, fields?: string[]): Promise<unknown>;
    create(collection: string, payload: { data: Record<string, unknown>; status?: string }): Promise<unknown>;
    patch(collection: string, id: string, patch: { data?: Record<string, unknown>; status?: string; expectedVersion?: number }): Promise<unknown>;
    delete(collection: string, id: string): Promise<unknown>;
  };
  fetch(url: string): Promise<Response>;
  secrets: { get(name: string): Promise<string | null> };
  extensionPoints: { register(point: string, definition: unknown): void };
  db?: unknown;
  env?: unknown;
}
type Trusted = { isTrustedBundleUrl(url: string): boolean };

declare global {
  // eslint-disable-next-line no-var
  var __heopressExtensionCtx: Record<string, unknown> | undefined;
}

function bundleUrl(name: string, exports = '{}'): string {
  const source = `export default (ctx) => { globalThis.__heopressExtensionCtx = ctx; return ${exports}; }`;
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source + `\n//# sourceURL=${name}.js`)}`;
}

async function loadCtx(
  capabilities: string[],
  deps: {
    actorDataAccess?: ExtensionActorDataAccess;
    onDenied?: (event: CapabilityDeniedEvent) => void;
    secrets?: (extension: string, name: string) => Promise<string | null>;
  } = {},
) {
  globalThis.__heopressExtensionCtx = undefined;
  const sandbox = new ExtensionSandbox({}, deps);
  vi.spyOn(sandbox as unknown as Trusted, 'isTrustedBundleUrl').mockReturnValue(true);
  await sandbox.load({
    name: `test_${capabilities.join('_') || 'actor'}`,
    bundleUrl: bundleUrl(`test_${capabilities.join('_') || 'actor'}`),
    capabilities,
  });
  return globalThis.__heopressExtensionCtx as unknown as Ctx;
}

describe('ExtensionSandbox data access', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('blocks actor-scoped item helpers without item capabilities', async () => {
    const actorDataAccess = {
      list: vi.fn().mockResolvedValue({ data: [{ id: 'post_1' }] }),
      detail: vi.fn(),
      create: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };
    const ctx = await loadCtx([], { actorDataAccess });

    await expect(ctx.items.list('posts', { limit: 1 })).rejects.toBeInstanceOf(CapabilityError);
    await expect(ctx.items.detail('posts', 'post_1')).rejects.toBeInstanceOf(CapabilityError);
    await expect(ctx.items.create('posts', { data: { title: 'Draft' } })).rejects.toBeInstanceOf(CapabilityError);
    await expect(ctx.items.patch('posts', 'post_1', { data: { title: 'Updated' } })).rejects.toBeInstanceOf(CapabilityError);
    await expect(ctx.items.delete('posts', 'post_1')).rejects.toBeInstanceOf(CapabilityError);
    expect(actorDataAccess.list).not.toHaveBeenCalled();
    expect(actorDataAccess.detail).not.toHaveBeenCalled();
    expect(actorDataAccess.create).not.toHaveBeenCalled();
    expect(actorDataAccess.patch).not.toHaveBeenCalled();
    expect(actorDataAccess.delete).not.toHaveBeenCalled();
  });

  it('allows actor-scoped item reads with a collection-scoped read capability', async () => {
    const actorDataAccess = {
      list: vi.fn().mockResolvedValue({ data: [{ id: 'post_1' }] }),
      detail: vi.fn().mockResolvedValue({ id: 'post_1' }),
      create: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };
    const ctx = await loadCtx(['items:read:posts'], { actorDataAccess });

    await expect(ctx.items.list('posts', { limit: 1 })).resolves.toEqual({
      data: [{ id: 'post_1' }],
    });
    await expect(ctx.items.detail('posts', 'post_1', ['title'])).resolves.toEqual({ id: 'post_1' });
    await expect(ctx.items.list('secrets')).rejects.toBeInstanceOf(CapabilityError);
    expect(actorDataAccess.list).toHaveBeenCalledWith('posts', { limit: 1 });
    expect(actorDataAccess.detail).toHaveBeenCalledWith('posts', 'post_1', ['title']);
  });

  it('allows actor-scoped item writes with a wildcard write capability', async () => {
    const actorDataAccess = {
      list: vi.fn(),
      // The host reads the item's state (a draft) to decide whether the change is a publish (P12 task 1.4).
      detail: vi.fn().mockResolvedValue({ id: 'post_1', status: 'draft', version: 4 }),
      create: vi.fn().mockResolvedValue({ id: 'post_1' }),
      patch: vi.fn().mockResolvedValue({ id: 'post_1', title: 'Updated' }),
      delete: vi.fn().mockResolvedValue({ id: 'post_1', deleted: true }),
    };
    const ctx = await loadCtx(['items:write:*'], { actorDataAccess });

    await expect(ctx.items.create('posts', { data: { title: 'Draft' } })).resolves.toEqual({ id: 'post_1' });
    // The version is forwarded as given (P04): ItemService refuses a patch without it.
    await expect(ctx.items.patch('posts', 'post_1', { data: { title: 'Updated' }, expectedVersion: 4 })).resolves.toEqual({
      id: 'post_1',
      title: 'Updated',
    });
    await expect(ctx.items.delete('posts', 'post_1')).resolves.toEqual({ id: 'post_1', deleted: true });
    await expect(ctx.items.detail('posts', 'post_1')).rejects.toBeInstanceOf(CapabilityError);
    expect(actorDataAccess.create).toHaveBeenCalledWith('posts', { data: { title: 'Draft' } });
    expect(actorDataAccess.patch).toHaveBeenCalledWith('posts', 'post_1', { data: { title: 'Updated' }, expectedVersion: 4 });
    expect(actorDataAccess.delete).toHaveBeenCalledWith('posts', 'post_1');
  });

  it('offers no raw database or environment access, whatever the capabilities say', async () => {
    const ctx = await loadCtx(['db:read', 'db:write', 'service-account', 'env:read']);
    expect(ctx.db).toBeUndefined();
    expect(ctx.env).toBeUndefined();
  });

  it('refuses and records a request to a host that was not declared (P12 task 1.1)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const onDenied = vi.fn();
    const ctx = await loadCtx(['http:fetch:api.example.com'], { onDenied });

    await expect(ctx.fetch('https://other.example.com/x')).rejects.toBeInstanceOf(CapabilityError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ capability: 'http:fetch:other.example.com', operation: 'fetch' }));
  });

  it('allows a declared host through the outbound boundary', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const ctx = await loadCtx(['http:fetch:example.com']);

    await expect(ctx.fetch('https://example.com/api')).resolves.toBeInstanceOf(Response);
    // Through the outbound boundary (P03): redirects are followed by hand and
    // every connection goes through the guarded dispatcher.
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/api', expect.objectContaining({ redirect: 'manual' }));
  });

  it('a declared host still cannot reach private network targets', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const ctx = await loadCtx(['http:fetch:169.254.169.254']);
    await expect(ctx.fetch('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/blocked/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses and records access to a collection that was not declared', async () => {
    const actorDataAccess = { list: vi.fn(), detail: vi.fn(), create: vi.fn(), patch: vi.fn(), delete: vi.fn() };
    const onDenied = vi.fn();
    const ctx = await loadCtx(['items:read:posts', 'items:write:posts'], { actorDataAccess, onDenied });
    await expect(ctx.items.list('pages')).rejects.toBeInstanceOf(CapabilityError);
    await expect(ctx.items.create('pages', { data: {} })).rejects.toBeInstanceOf(CapabilityError);
    expect(actorDataAccess.list).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ capability: 'items:read:pages' }));
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ capability: 'items:write:pages' }));
  });

  it('collection write does not imply publish (P12 task 1.4)', async () => {
    const actorDataAccess = { list: vi.fn(), detail: vi.fn().mockResolvedValue({ id: 'p1', status: 'draft', version: 1 }), create: vi.fn().mockResolvedValue({}), patch: vi.fn().mockResolvedValue({}), delete: vi.fn() };
    const writer = await loadCtx(['items:write:posts'], { actorDataAccess });
    await expect(writer.items.patch('posts', 'p1', { status: 'published', expectedVersion: 1 })).rejects.toBeInstanceOf(CapabilityError);
    await expect(writer.items.create('posts', { data: {}, status: 'scheduled' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(writer.items.patch('posts', 'p1', { status: 'draft', expectedVersion: 1 })).resolves.toEqual({});
    expect(actorDataAccess.patch).toHaveBeenCalledTimes(1);

    const publisher = await loadCtx(['items:write:posts', 'items:publish:posts'], { actorDataAccess });
    await expect(publisher.items.patch('posts', 'p1', { status: 'published', expectedVersion: 1 })).resolves.toEqual({});
  });

  it('collection write does not change or delete a published or scheduled item: that needs items:publish (P12 task 1.4)', async () => {
    const rows: Record<string, { id: string; status: string; version: number }> = {
      live: { id: 'live', status: 'published', version: 3 },
      soon: { id: 'soon', status: 'scheduled', version: 2 },
      draft: { id: 'draft', status: 'draft', version: 5 },
    };
    const actorDataAccess = {
      list: vi.fn(),
      detail: vi.fn(async (_c: string, id: string) => rows[id]),
      create: vi.fn(),
      patch: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
    };
    const onDenied = vi.fn();
    const writer = await loadCtx(['items:write:posts'], { actorDataAccess, onDenied });
    // A data-only edit keeps the status but changes the live page: refused, nothing written.
    await expect(writer.items.patch('posts', 'live', { data: { title: 'x' }, expectedVersion: 3 })).rejects.toBeInstanceOf(CapabilityError);
    await expect(writer.items.patch('posts', 'soon', { data: { title: 'x' }, expectedVersion: 2 })).rejects.toBeInstanceOf(CapabilityError);
    await expect(writer.items.patch('posts', 'live', { status: 'draft', expectedVersion: 3 })).rejects.toBeInstanceOf(CapabilityError);
    await expect(writer.items.patch('posts', 'live', { data: { title: 'x' } })).rejects.toBeInstanceOf(CapabilityError);
    await expect(writer.items.delete('posts', 'live')).rejects.toBeInstanceOf(CapabilityError);
    expect(actorDataAccess.patch).not.toHaveBeenCalled();
    expect(actorDataAccess.delete).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ capability: 'items:publish:posts', operation: 'items.patch' }));
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ capability: 'items:publish:posts', operation: 'items.delete' }));
    // An item whose state cannot be read is treated as live.
    actorDataAccess.detail.mockResolvedValueOnce(undefined as never);
    await expect(writer.items.patch('posts', 'gone', { data: {}, expectedVersion: 1 })).rejects.toBeInstanceOf(CapabilityError);
    // The check is at the version the change is based on: a stale version is a conflict, not a pass.
    await expect(writer.items.patch('posts', 'draft', { data: { title: 'x' }, expectedVersion: 4 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    expect(actorDataAccess.patch).not.toHaveBeenCalled();
    // Drafts stay the writer's.
    await expect(writer.items.patch('posts', 'draft', { data: { title: 'x' }, expectedVersion: 5 })).resolves.toEqual({ ok: true });
    await expect(writer.items.delete('posts', 'draft')).resolves.toEqual({ ok: true });

    // With items:publish the live item is the plugin's to change; no lookup is needed.
    actorDataAccess.detail.mockClear();
    const publisher = await loadCtx(['items:write:posts', 'items:publish:posts'], { actorDataAccess });
    await expect(publisher.items.patch('posts', 'live', { data: { title: 'x' }, expectedVersion: 3 })).resolves.toEqual({ ok: true });
    await expect(publisher.items.delete('posts', 'soon')).resolves.toEqual({ ok: true });
    expect(actorDataAccess.detail).not.toHaveBeenCalled();
  });

  it('secrets: only declared names, resolved by the host', async () => {
    const secrets = vi.fn().mockResolvedValue('value-1');
    const ctx = await loadCtx(['secrets:api-token'], { secrets });
    await expect(ctx.secrets.get('api-token')).resolves.toBe('value-1');
    await expect(ctx.secrets.get('other')).rejects.toBeInstanceOf(CapabilityError);
    expect(secrets).toHaveBeenCalledTimes(1);
  });

  it('refuses registering on an undeclared extension point; declared ones still work', async () => {
    const onDenied = vi.fn();
    const ctx = await loadCtx(['ext:jobs'], { onDenied });
    const points = ctx.extensionPoints;
    expect(() => points.register('endpoints', { path: '/x' })).toThrow(CapabilityError);
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ capability: 'ext:endpoints', operation: 'register' }));
    expect(() => points.register('jobs', { name: 'nightly' })).not.toThrow();
    expect(() => points.register('nope', {})).toThrow(/Unknown extension point/);
  });

  it('a factory that never finishes fails the load within the load limit (P12 task 9.1)', async () => {
    const sandbox = new ExtensionSandbox({});
    vi.spyOn(sandbox as unknown as Trusted, 'isTrustedBundleUrl').mockReturnValue(true);
    const source = 'export default () => new Promise(() => {});';
    const started = Date.now();
    const mod = await sandbox.load({ name: 'stuck', bundleUrl: `data:text/javascript,${encodeURIComponent(source)}`, capabilities: [], timeoutMs: 100 });
    expect(mod).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('drops an exported handler without ext:endpoints but keeps the declared hooks', async () => {
    const onDenied = vi.fn();
    const sandbox = new ExtensionSandbox({}, { onDenied });
    vi.spyOn(sandbox as unknown as Trusted, 'isTrustedBundleUrl').mockReturnValue(true);
    const mod = await sandbox.load({
      name: 'mixed',
      bundleUrl: bundleUrl('mixed', '{ handler() {}, hooks: { "items.create.after": async () => {} } }'),
      capabilities: ['ext:events'],
    });
    expect(mod?.handler).toBeUndefined();
    expect(mod?.hooks?.['items.create.after']).toBeTypeOf('function');
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ capability: 'ext:endpoints', operation: 'export:handler' }));
  });
});

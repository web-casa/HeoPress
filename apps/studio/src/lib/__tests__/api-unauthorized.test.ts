// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSessionJwt } from '@/test/session';

/**
 * B99: a Studio served at the root reloaded itself forever. Anonymous requests
 * made before sign-in answer 401, and the global handler answered each one with
 * `location.assign('/')` — the page it was already on.
 */
describe('handleUnauthorized', () => {
  let assign: ReturnType<typeof vi.fn>;

  async function load(pathname: string) {
    vi.resetModules();
    window.history.replaceState(null, '', pathname);
    assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, pathname, assign },
    });
    return import('@/lib/api');
  }

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('does not navigate when there is no token to clear', async () => {
    const api = await load('/');
    api.handleUnauthorized();
    expect(assign).not.toHaveBeenCalled();
  });

  it('reloads the root once for a stale session, and the reload does not loop', async () => {
    let api = await load('/');
    await api.setActiveLogin({ token: fakeSessionJwt(), refreshToken: 'stale' });
    api.handleUnauthorized();
    expect(assign).toHaveBeenCalledWith('/');
    expect(api.hasActiveToken()).toBe(false);

    // The reloaded page: no token, so its anonymous 401s must not navigate.
    api = await load('/');
    api.handleUnauthorized();
    expect(assign).not.toHaveBeenCalled();
  });

  it('still sends a stale session on a module page back to the root gate', async () => {
    const api = await load('/content/posts');
    await api.setActiveLogin({ token: fakeSessionJwt(), refreshToken: 'stale' });
    api.handleUnauthorized();
    expect(assign).toHaveBeenCalledWith('/');
    expect(api.hasActiveToken()).toBe(false);
  });

  it('sends a stale session under a private prefix to that prefix login', async () => {
    const api = await load('/admin-a7f3c1/content/posts');
    await api.setActiveLogin({ token: fakeSessionJwt(), refreshToken: 'stale' });
    api.handleUnauthorized();
    api.handleUnauthorized();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/admin-a7f3c1/login');
  });
});

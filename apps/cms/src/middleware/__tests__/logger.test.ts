import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { loggedPath, withLogger } from '../logger';

/**
 * The request log never carries a secret that travels in the path (v1 security review finding S-6,
 * docs/reviews/v1-security.md): the private admin path and public share tokens.
 */
describe('request logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('masks the private admin path and share tokens, and keeps other paths', () => {
    expect(loggedPath('/studio-x7q2/settings', 'STUDIO_HTML', 'info')).toBe('/<admin_path>');
    expect(loggedPath('/studio-x7q2/settings', 'STUDIO_HTML', 'debug')).toBe('/studio-x7q2/settings');
    expect(loggedPath('/api/v1/shares/shr_abc123')).toBe('/api/v1/shares/<token>');
    expect(loggedPath('/api/v1/shares/shr_abc123/extra')).toBe('/api/v1/shares/<token>/extra');
    expect(loggedPath('/api/v1/items/posts')).toBe('/api/v1/items/posts');
    expect(loggedPath('/api/v1/shares')).toBe('/api/v1/shares');
  });

  it('writes the masked path to the log line', async () => {
    vi.stubEnv('LOG_LEVEL', 'info');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    const app = new Hono<AppEnv>();
    app.use('*', withLogger());
    app.get('/console-k9/*', (c) => {
      c.set('responseType', 'STUDIO_HTML');
      return c.text('studio');
    });
    app.get('/api/v1/shares/:token', (c) => c.json({ ok: true }));

    await app.request('/console-k9/assets/app.js');
    await app.request('/api/v1/shares/shr_abc123');

    expect(lines.join('\n')).not.toMatch(/console-k9|shr_abc123/);
    expect(lines.map((l) => JSON.parse(l).path)).toEqual(['/<admin_path>', '/api/v1/shares/<token>']);
  });
});

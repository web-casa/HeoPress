import { describe, expect, it } from 'vitest';
import { GitCommandError, pinnedHttpClient, redact } from '../git';

describe('Git snapshots — in-process git transport', () => {
  it('refuses a request outside the configured https host (another host, http, user info)', async () => {
    const http = pinnedHttpClient('git.example.com', ['203.0.113.10'], 1000);
    for (const url of ['https://evil.example.com/r.git/info/refs', 'http://git.example.com/r.git/info/refs', 'https://u:p@git.example.com/r.git/info/refs']) {
      await expect(http.request({ url, method: 'GET' })).rejects.toBeInstanceOf(GitCommandError);
    }
  });

  it('needs at least one vetted address', () => {
    expect(() => pinnedHttpClient('git.example.com', [])).toThrow(/vetted/);
  });

  it('redacts the token, its Basic form and URL user info', () => {
    const auth = { username: 'x-access-token', token: 'tok-secret-1' };
    const basic = Buffer.from('x-access-token:tok-secret-1').toString('base64');
    const out = redact(`fail tok-secret-1 ${basic} https://a:b@git.example.com/r.git`, auth);
    expect(out).not.toContain('tok-secret-1');
    expect(out).not.toContain(basic);
    expect(out).toContain('https://***@git.example.com');
  });
});

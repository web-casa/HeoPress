import { describe, expect, it } from 'vitest';
import { hostMemo } from '../host-memo';

type Row = { siteId: string; hostname: string; isPrimary: boolean; entryLocale: string | null; primaryHostname: string | null };
const row = (hostname: string, siteId = 's1'): Row => ({ siteId, hostname, isPrimary: true, entryLocale: null, primaryHostname: null });

function fakePort(answer: (host: string) => Promise<Row | null>) {
  const reads: string[] = [];
  return { reads, port: { host: (h: string) => (reads.push(h), answer(h)) } };
}

/** The in-process memory of host rows (HeoPress P13 task 3.2). */
describe('host memory', () => {
  it('0 ms: every request reads the host', async () => {
    const { reads, port } = fakePort(async (h) => row(h));
    const of = hostMemo(port, 0);
    await of('a.test');
    await of('a.test');
    expect(reads).toEqual(['a.test', 'a.test']);
  });

  it('remembers a row (and an unknown host) for the window, then reads it again', async () => {
    let t = 0;
    let site = 's1';
    const { reads, port } = fakePort(async (h) => (h === 'a.test' ? row(h, site) : null));
    const of = hostMemo(port, 1000, () => t);
    expect((await of('a.test'))?.siteId).toBe('s1');
    expect(await of('nope.test')).toBeNull();
    site = 's2';
    t = 999;
    expect((await of('a.test'))?.siteId).toBe('s1');
    expect(await of('nope.test')).toBeNull();
    expect(reads).toEqual(['a.test', 'nope.test']);
    t = 1000;
    expect((await of('a.test'))?.siteId).toBe('s2');
    expect(reads).toEqual(['a.test', 'nope.test', 'a.test']);
  });

  it('never remembers a failed read', async () => {
    let fail = true;
    const { reads, port } = fakePort(async (h) => {
      if (fail) throw new Error('down');
      return row(h);
    });
    const of = hostMemo(port, 1000, () => 0);
    await expect(of('a.test')).rejects.toThrow('down');
    fail = false;
    expect((await of('a.test'))?.hostname).toBe('a.test');
    expect(reads).toEqual(['a.test', 'a.test']);
  });

  it('keeps at most 10,000 names, dropping the oldest', async () => {
    const { reads, port } = fakePort(async (h) => row(h));
    const of = hostMemo(port, 1000, () => 0);
    for (let i = 0; i <= 10_000; i++) await of(`h${i}.test`);
    await of('h10000.test');
    await of('h1.test');
    await of('h0.test');
    expect(reads.slice(10_001)).toEqual(['h0.test']);
  });
});

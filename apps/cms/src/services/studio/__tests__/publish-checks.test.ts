import { describe, expect, it, vi } from 'vitest';
import { effectiveSeoSettings } from '@heopress/contracts/schemas';
import { descriptionCheck, imagesCheck, indexingCheck, linksCheck, titleCheck } from '../publish-checks';

const all = () => true;
const settings = effectiveSeoSettings(undefined);

describe('pre-publish checks (p07a task 5.4)', () => {
  it('title: the SEO title first, lengths 30–60', () => {
    expect(titleCheck({ title: 'Short' }, all)).toMatchObject({ status: 'warn', reason: 'too_short', value: 5 });
    expect(titleCheck({ title: 'x'.repeat(40) }, all)).toMatchObject({ status: 'pass', value: 40 });
    expect(titleCheck({ title: 'x'.repeat(40), seo_title: 'y'.repeat(70) }, all)).toMatchObject({ status: 'warn', reason: 'too_long', value: 70 });
    expect(titleCheck({}, all)).toMatchObject({ status: 'fail', reason: 'missing' });
    expect(titleCheck({ title: 'secret' }, () => false)).toEqual({ id: 'title', status: 'no_permission' });
  });

  it('description: 70–160; a hidden field is no_permission and its text never returned', () => {
    expect(descriptionCheck({ seo_description: 'too short' }, all)).toMatchObject({ status: 'warn', reason: 'too_short' });
    expect(descriptionCheck({ excerpt: 'e'.repeat(100) }, all)).toMatchObject({ status: 'pass', value: 100 });
    const hidden = descriptionCheck({}, (f) => f !== 'seo_description' && f !== 'excerpt' && f !== 'description');
    expect(hidden).toEqual({ id: 'description', status: 'no_permission' });
    expect(descriptionCheck({}, (f) => f === 'excerpt')).toEqual({ id: 'description', status: 'no_permission' });
  });

  it('indexing: noindex on the item is a warning with its reason', () => {
    expect(indexingCheck({}, all, settings, 'articles')).toMatchObject({ status: 'pass' });
    expect(indexingCheck({ seo_robots: 'noindex' }, all, settings, 'articles')).toMatchObject({ status: 'warn', reason: 'noindex_by_item' });
  });

  it('images: an <img> without alt text', () => {
    expect(imagesCheck(['<p><img src="/a.jpg" alt="A cat"><img src="/b.jpg"><img src="/c.jpg" alt=" "></p>'])).toMatchObject({ status: 'warn', value: 2 });
    expect(imagesCheck(['<p>no images</p>'])).toMatchObject({ status: 'pass' });
  });

  it('links: internal resolved in the database (an offline page fails), external not checked, no fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const resolve = vi.fn(async (_host: string, path: string) =>
      path === '/live/' ? ({ kind: 'item' } as never) : path === '/moved/' ? ({ kind: 'redirect' } as never) : ({ kind: 'not_found' } as never),
    );
    const check = await linksCheck(
      ['<a href="/live/">a</a><a href="https://www.example.com/gone/">b</a><a href="/moved/">c</a><a href="https://other.example.org/x">d</a>'],
      'https://www.example.com/',
      new Set(['www.example.com']),
      resolve,
    );
    expect(check.status).toBe('fail');
    expect(check.items).toEqual([
      { url: 'https://www.example.com/live/', status: 'ok' },
      { url: 'https://www.example.com/gone/', status: 'broken' },
      { url: 'https://www.example.com/moved/', status: 'redirected' },
      { url: 'https://other.example.org/x', status: 'not_checked' },
    ]);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('links: with no domain, relative links cannot be resolved and are not checked', async () => {
    const resolve = vi.fn();
    const check = await linksCheck(['<a href="/a/">a</a>'], null, new Set(), resolve);
    expect(check.items).toEqual([{ url: '/a/', status: 'not_checked' }]);
    expect(resolve).not.toHaveBeenCalled();
  });
});

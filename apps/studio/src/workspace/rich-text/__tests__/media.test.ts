import { describe, expect, it } from 'vitest';
import { keyFor, kindOf, refusalOf, type UploadTarget } from '../media';

const target: UploadTarget = { available: true, reason: null, prefix: 'editor/', types: ['image/png', 'image/jpeg', 'video/mp4'], maxBytes: 10, videoMaxBytes: 50 };
const file = (type: string, size: number, name = 'f') => new File([new Uint8Array(size)], name, { type });

describe('uploads into rich text', () => {
  it('take the types the site accepts, images up to the general cap and videos up to the video cap', () => {
    expect(refusalOf(file('image/png', 10), target)).toBeNull();
    expect(refusalOf(file('image/png', 11), target)).toEqual({ key: 'size', limit: 10 });
    expect(refusalOf(file('video/mp4', 50), target)).toBeNull();
    expect(refusalOf(file('video/mp4', 51), target)).toEqual({ key: 'size', limit: 50 });
    expect(refusalOf(file('image/svg+xml', 1), target)).toEqual({ key: 'type' });
    expect(refusalOf(file('application/pdf', 1), target)).toEqual({ key: 'type' });
  });

  it('get an unguessable key under the editor prefix, by year and month, with the type extension', () => {
    expect(keyFor(file('image/jpeg', 1), target, new Date(2026, 9, 25), () => 'x7k2q9')).toBe('editor/2026/10/x7k2q9.jpg');
    expect(keyFor(file('video/mp4', 1), target, new Date(2026, 0, 3), () => 'abc')).toBe('editor/2026/01/abc.mp4');
    const a = keyFor(file('image/png', 1), target);
    const b = keyFor(file('image/png', 1), target);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^editor\/\d{4}\/\d{2}\/[0-9a-z]{20}\.png$/);
  });

  it('are images or videos only', () => {
    expect([kindOf('image/webp'), kindOf('video/webm'), kindOf('text/plain')]).toEqual(['image', 'video', null]);
  });
});

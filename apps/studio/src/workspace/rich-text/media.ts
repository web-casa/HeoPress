import { MIME_EXTENSIONS } from '@heopress/contracts/schemas';
import { siteFetch } from '@/lib/http';

/**
 * Uploads into rich text (ADR-0020): images and short videos go to the site's object storage (S3, R2 or OSS) under
 * `editor/<year>/<month>/<random>.<ext>`, through the guarded media upload; the address put into the text is the
 * storage's public one. `GET /api/v1/editor-media/target` says beforehand whether that is possible here.
 */
export interface UploadTarget {
  available: boolean;
  reason: 'OBJECT_STORAGE_REQUIRED' | 'PUBLIC_URL_REQUIRED' | null;
  prefix: string;
  types: string[];
  maxBytes: number;
  videoMaxBytes: number;
}

export async function fetchUploadTarget(): Promise<UploadTarget | null> {
  const res = await siteFetch('/api/v1/editor-media/target');
  if (!res.ok) return null; // no permission to upload, or storage unavailable: no uploads offered
  return ((await res.json()) as { data: UploadTarget }).data;
}

export type MediaKind = 'image' | 'video';

export const kindOf = (mime: string): MediaKind | null => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : null);

/** Why a file cannot go up here (a key of `editor:media.*`), or null. */
export function refusalOf(file: File, target: UploadTarget): { key: 'type' | 'size'; limit?: number } | null {
  const type = file.type.toLowerCase();
  if (!target.types.includes(type)) return { key: 'type' };
  const limit = type.startsWith('video/') ? target.videoMaxBytes : target.maxBytes;
  return file.size > limit ? { key: 'size', limit } : null;
}

/** A fresh, unguessable key for a file: `editor/2026/10/x7k…q.jpg`. */
export function keyFor(file: File, target: UploadTarget, now: Date = new Date(), random: () => string = randomId): string {
  const ext = MIME_EXTENSIONS[file.type.toLowerCase()]?.[0] ?? '';
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${target.prefix}${now.getFullYear()}/${month}/${random()}${ext}`;
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

export class UploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Uploads the file; returns its public address and key. */
export async function uploadMedia(file: File, target: UploadTarget): Promise<{ url: string; key: string }> {
  const key = keyFor(file, target);
  const res = await siteFetch(`/api/v1/media/${key.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  });
  const body = (await res.json().catch(() => null)) as { data?: { url?: string | null }; errors?: Array<{ code?: string; message?: string }> } | null;
  if (!res.ok || !body?.data?.url) {
    const first = body?.errors?.[0];
    throw new UploadError(first?.code ?? `HTTP_${res.status}`, first?.message ?? 'Upload failed.');
  }
  return { url: body.data.url, key };
}

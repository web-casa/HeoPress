import sharp from 'sharp';
import type { MediaProcessor, TransformOptions } from '../../interfaces';

/**
 * In-process image transforms with sharp (HeoPress P03 task 4.3), replacing
 * imgproxy. The media route decides *whether* a transform is allowed
 * (presets, or a signed DSL) and caches derivatives in storage; this class
 * does the pixel work and enforces resource limits:
 *   - requested width/height capped at `maxDimension`
 *     (HEOPRESS_IMAGE_MAX_DIMENSION, default 4096), and so is the image
 *     actually produced: a dimension that follows from the aspect ratio, a
 *     format-only conversion or `fit: 'outside'` can exceed what was asked
 *     for, and such a result is refused (Codex review 3, #7) — larger
 *     requests are rejected, not silently clamped;
 *   - decoded input capped at `maxInputPixels` (default 50 megapixels) so a
 *     small file that decodes to a huge bitmap cannot exhaust memory;
 *   - metadata (EXIF, GPS) is not copied to the output.
 */

class ImageTransformLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageTransformLimitError';
  }
}

export interface SharpMediaOptions {
  maxDimension?: number;
  maxInputPixels?: number;
  /** URL prefix of the media route, for `getUrl` (default `/api/v1/media`). */
  routePrefix?: string;
}

export class SharpMediaProcessor implements MediaProcessor {
  readonly maxDimension: number;
  private readonly maxInputPixels: number;
  private readonly routePrefix: string;

  constructor(options: SharpMediaOptions = {}) {
    this.maxDimension = options.maxDimension ?? 4096;
    this.maxInputPixels = options.maxInputPixels ?? 50_000_000;
    this.routePrefix = options.routePrefix ?? '/api/v1/media';
  }

  /** The media route's own transform URL (the route signs/validates it). */
  getUrl(key: string, options?: TransformOptions): string {
    const params = new URLSearchParams();
    if (options?.width) params.set('width', String(options.width));
    if (options?.height) params.set('height', String(options.height));
    if (options?.format) params.set('format', options.format);
    if (options?.quality) params.set('quality', String(options.quality));
    if (options?.fit) params.set('fit', options.fit);
    const query = params.toString();
    return `${this.routePrefix}/${key.split('/').map(encodeURIComponent).join('/')}${query ? `?${query}` : ''}`;
  }

  async generateThumbnails(key: string, sizes: Array<{ width: number; height: number }>): Promise<string[]> {
    return sizes.map((size) => this.getUrl(key, { ...size, format: 'webp', quality: 80 }));
  }

  /** Reject options outside the configured limits. */
  checkLimits(options: TransformOptions): void {
    for (const [name, v] of [['width', options.width], ['height', options.height]] as const) {
      if (v === undefined) continue;
      if (!Number.isInteger(v) || v < 1 || v > this.maxDimension) {
        throw new ImageTransformLimitError(`${name} must be an integer between 1 and ${this.maxDimension}`);
      }
    }
    if (options.quality !== undefined && (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100)) {
      throw new ImageTransformLimitError('quality must be an integer between 1 and 100');
    }
  }

  async transform(
    input: ArrayBuffer | Uint8Array,
    options: TransformOptions,
  ): Promise<{ body: Uint8Array; contentType: string }> {
    this.checkLimits(options);
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let pipeline = sharp(bytes, { limitInputPixels: this.maxInputPixels, failOn: 'error' }).rotate();
    if (options.width || options.height) {
      pipeline = pipeline.resize({
        width: options.width,
        height: options.height,
        fit: options.fit ?? 'cover',
        withoutEnlargement: true,
      });
    }
    const format = options.format ?? 'webp';
    pipeline = pipeline.toFormat(format, options.quality ? { quality: options.quality } : undefined);
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    if (info.width > this.maxDimension || info.height > this.maxDimension) {
      throw new ImageTransformLimitError(
        `the result would be ${info.width}×${info.height}, larger than ${this.maxDimension} on a side`,
      );
    }
    return { body: new Uint8Array(data), contentType: `image/${format}` };
  }
}

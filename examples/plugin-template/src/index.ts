/**
 * A HeoPress plugin built only against @heopress/extension-sdk (Apache-2.0).
 *
 * Only types come from the SDK (`import type`), so the built `dist/index.js` has no runtime import and the
 * host loads it as is. The hook refuses a post update whose body is shorter than the `minWords` setting
 * declared in `heopress-extension.json`.
 */
import type { HookContext, HookDefinition } from '@heopress/extension-sdk';

interface PostPayload {
  body?: string;
}

const DEFAULT_MIN_WORDS = 100;

/** Words in a body: runs of non-space characters; each CJK character counts as one word. */
export function countWords(body: string): number {
  const cjk = body.match(/[㐀-鿿豈-﫿]/g)?.length ?? 0;
  const other = body.replace(/[㐀-鿿豈-﫿]/g, ' ').split(/\s+/).filter(Boolean).length;
  return cjk + other;
}

function minWords(ctx: HookContext): number {
  const value = ctx.config.minWords;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : DEFAULT_MIN_WORDS;
}

const wordCount: HookDefinition<PostPayload> = {
  on: 'items.posts.update.before',
  handler({ payload, ctx }) {
    if (typeof payload.body !== 'string') return;
    const words = countWords(payload.body);
    const min = minWords(ctx);
    if (words < min) throw new ctx.errors.ValidationError(`The body has ${words} words; at least ${min} are required`);
    ctx.logger.info('word count ok', { words, siteId: ctx.siteId });
  },
};

export default wordCount;

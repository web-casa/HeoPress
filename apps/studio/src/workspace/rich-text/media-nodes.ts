import { mergeAttributes, Node } from '@tiptap/core';
import Image from '@tiptap/extension-image';

/**
 * The storage key of an uploaded image or video, kept beside its address (`data-media-key`) so the address can be
 * rewritten if the site's storage changes (spec platform/storage-profiles: history stays reachable).
 */
const mediaKey = {
  mediaKey: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-media-key'),
    renderHTML: (attrs: Record<string, unknown>) => (attrs.mediaKey ? { 'data-media-key': attrs.mediaKey as string } : {}),
  },
};

export const MediaImage = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), ...mediaKey };
  },
}).configure({ inline: false });

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    video: {
      /** Inserts a video block. */
      setVideo: (attrs: { src: string; mediaKey?: string | null; title?: string | null }) => ReturnType;
    };
  }
}

/** A short video block (ADR-0020): plays with its controls, on request only (no autoplay). */
export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      title: { default: null },
      ...mediaKey,
    };
  },
  parseHTML() {
    return [{ tag: 'video[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(HTMLAttributes, { controls: '', preload: 'metadata' })];
  },
  addCommands() {
    return {
      setVideo:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

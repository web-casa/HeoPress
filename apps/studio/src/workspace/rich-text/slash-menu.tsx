import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { Clapperboard, Code, Heading2, Heading3, Image, List, ListOrdered, Minus, Pilcrow, Quote, Table, type LucideIcon } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { cn } from '@/lib/cn';
import { filterBlocks, type BlockItem } from './blocks';

const ICONS: Record<string, LucideIcon> = { text: Pilcrow, h2: Heading2, h3: Heading3, bullet: List, ordered: ListOrdered, quote: Quote, code: Code, divider: Minus, table: Table, image: Image, video: Clapperboard };

interface MenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

interface MenuProps {
  items: BlockItem[];
  command: (item: BlockItem) => void;
}

/** The "/" menu: blocks to insert, moved through with the arrow keys and chosen with Enter. */
const SlashList = forwardRef<MenuHandle, MenuProps>(function SlashList({ items, command }, ref) {
  const { t } = useTranslation('editor');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setIndex(0), [items]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === 'ArrowDown') {
        setIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setIndex((i) => (i + items.length - 1) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        const item = items[index];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));
  return (
    <div ref={listRef} role="listbox" aria-label={t('blocks.menu')} className="max-h-[320px] w-[260px] overflow-y-auto rounded-card border border-line bg-panel p-1 shadow-lg">
      {items.length === 0 ? (
        <p className="px-2 py-2 t-aux">{t('blocks.none')}</p>
      ) : (
        items.map((item, i) => {
          const Icon = ICONS[item.id] ?? Pilcrow;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={i === index}
              data-index={i}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                command(item);
              }}
              className={cn('flex w-full items-center gap-2.5 rounded-ctl px-2 py-1.5 text-left', i === index ? 'bg-panel-2' : '')}
            >
              <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl border border-line bg-bg text-icon">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">{t(`blocks.${item.id}`)}</span>
                <span className="block truncate t-aux">{t(`blocks.${item.id}Hint`)}</span>
              </span>
            </button>
          );
        })
      )}
    </div>
  );
});

/** Where the menu sits: under the caret, kept inside the window. */
function place(el: HTMLElement, rect: DOMRect | null | undefined) {
  if (!rect) return;
  const height = el.offsetHeight || 320;
  const below = rect.bottom + 6;
  const top = below + height > window.innerHeight ? Math.max(8, rect.top - height - 6) : below;
  Object.assign(el.style, { position: 'fixed', top: `${top}px`, left: `${Math.min(rect.left, window.innerWidth - 268)}px`, zIndex: '60' });
}

/**
 * Typing "/" at the start of a line, or after a space, opens the block menu (ADR-0020: Notion-style editing from
 * MIT parts). `onAsk` receives blocks that need a form first (an image's address).
 */
export function slashCommand(onAsk: (kind: 'image' | 'video', editor: Editor) => void) {
  return Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      return [
        Suggestion<BlockItem>({
          editor: this.editor,
          pluginKey: new PluginKey('slashCommand'),
          char: '/',
          startOfLine: false,
          allowSpaces: false,
          items: ({ query }) => filterBlocks(query, (b) => i18n.t(`editor:blocks.${b.id}`)),
          command: ({ editor, range, props }: { editor: Editor; range: Range; props: BlockItem }) => {
            props.run(editor, range);
            if (props.ask) onAsk(props.ask, editor);
          },
          render: () => {
            let renderer: ReactRenderer<MenuHandle, MenuProps> | null = null;
            return {
              onStart: (props: SuggestionProps<BlockItem>) => {
                renderer = new ReactRenderer(SlashList, { props: { items: props.items, command: props.command }, editor: props.editor });
                document.body.appendChild(renderer.element);
                place(renderer.element as HTMLElement, props.clientRect?.());
              },
              onUpdate: (props: SuggestionProps<BlockItem>) => {
                renderer?.updateProps({ items: props.items, command: props.command });
                if (renderer) place(renderer.element as HTMLElement, props.clientRect?.());
              },
              onKeyDown: (props: SuggestionKeyDownProps) => {
                if (props.event.key === 'Escape') {
                  renderer?.destroy();
                  renderer?.element.remove();
                  renderer = null;
                  return true;
                }
                return renderer?.ref?.onKeyDown(props) ?? false;
              },
              onExit: () => {
                renderer?.destroy();
                renderer?.element.remove();
                renderer = null;
              },
            };
          },
        }),
      ];
    },
  });
}


import type { Editor } from '@tiptap/core';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Code, GripVertical, Italic, Link as LinkIcon, Strikethrough, Underline } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { sanitizeHtml } from '@/lib/sanitize-html';
import { adoptBlockIds, BlockIds } from './block-ids';
import { slashCommand } from './slash-menu';

/**
 * The rich-text editor (ADR-0020): Tiptap 3 with MIT extensions only, in Notion's manner — "/" inserts a block, a
 * handle beside each block drags it, selecting text shows the formatting bar — styled with the Carbon tokens.
 * The value is HTML, as stored; it is sanitised on the way in and out.
 */
export interface RichTextEditorProps {
  value: string | null | undefined;
  onChange: (html: string) => void;
  disabled?: boolean;
  /** The accessible name of the editing area. */
  label: string;
  /** `article`: the article editor's body, larger type and no frame. */
  variant?: 'article' | 'field';
}

/** What the editor holds, as stored: '' when empty, sanitised HTML otherwise. */
export function htmlOf(editor: Editor): string {
  return editor.isEmpty ? '' : sanitizeHtml(editor.getHTML());
}

export function RichTextEditor({ value, onChange, disabled, label, variant = 'field' }: RichTextEditorProps) {
  const { t } = useTranslation('editor');
  const [asking, setAsking] = useState<'image' | null>(null);
  const emitted = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const extensions = useMemo(
    () => [
      StarterKit.configure({ heading: { levels: [2, 3, 4] }, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
      Image.configure({ inline: false }),
      TableKit.configure({ table: { resizable: false } }),
      // Read at each render, so a language loaded later or switched applies without rebuilding the editor.
      Placeholder.configure({
        placeholder: ({ node }) => i18n.t(node.type.name === 'heading' ? 'editor:rich.headingPlaceholder' : 'editor:rich.placeholder'),
      }),
      BlockIds,
      slashCommand((kind) => setAsking(kind)),
    ],
    [],
  );

  // Built once: changing the options of a live editor would reset its content and move the caret.
  const editor = useEditor({
    extensions,
    content: sanitizeHtml(value ?? ''),
    editable: !disabled,
    editorProps: { attributes: { 'aria-label': label, 'aria-multiline': 'true', role: 'textbox', class: 'rt-content' } },
    onUpdate: ({ editor: e, transaction }) => {
      // Block IDs set from a save are not an edit.
      if (transaction.getMeta('blockIds')) {
        emitted.current = htmlOf(e);
        return;
      }
      const html = htmlOf(e);
      emitted.current = html;
      onChangeRef.current(html);
    },
  }, []);

  // A value from outside (load, discard, a colleague's version) replaces the content; my own edits coming back do not.
  useEffect(() => {
    // A destroyed editor (React re-mounting it) has no schema left to read.
    if (!editor || editor.isDestroyed) return;
    const next = sanitizeHtml(value ?? '');
    const current = htmlOf(editor);
    if (next === emitted.current || next === current) return;
    if (!adoptBlockIds(editor, next, current)) editor.commands.setContent(next, { emitUpdate: false });
    emitted.current = htmlOf(editor);
  }, [editor, value]);
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!disabled);
  }, [editor, disabled]);

  if (!editor) return null;
  return (
    <div className={cn('rt relative', variant === 'article' ? 'rt-article' : 'rounded-ctl border border-line bg-bg px-3 py-2', disabled && 'opacity-60')}>
      {disabled ? null : (
        <DragHandle editor={editor} className="rt-handle">
          <span title={t('rich.drag')} className="flex h-6 w-5 cursor-grab items-center justify-center rounded text-icon hover:bg-panel-2">
            <GripVertical className="h-4 w-4" aria-hidden="true" />
          </span>
        </DragHandle>
      )}
      <FormatBar editor={editor} />
      <EditorContent editor={editor} />
      {asking === 'image' ? <ImageForm editor={editor} onClose={() => setAsking(null)} /> : null}
    </div>
  );
}

/** Selecting text shows the formatting bar: bold, italic, underline, strike, code and link. */
function FormatBar({ editor }: { editor: Editor }) {
  const { t } = useTranslation('editor');
  const [linking, setLinking] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      href: (e.getAttributes('link').href as string | undefined) ?? '',
    }),
  });
  // A new selection closes an open link form.
  useEffect(() => {
    const close = () => setLinking(false);
    editor.on('selectionUpdate', close);
    return () => {
      editor.off('selectionUpdate', close);
    };
  }, [editor]);
  return (
    <BubbleMenu editor={editor} shouldShow={({ editor: e, state: s }) => e.isEditable && !s.selection.empty && !e.isActive('image') && !e.isActive('codeBlock')}>
      <div role="toolbar" aria-label={t('rich.format')} className="flex items-center gap-0.5 rounded-ctl border border-line bg-panel p-1 shadow-lg">
        {linking ? (
          <LinkForm
            initial={state.href}
            onDone={(href) => {
              const chain = editor.chain().focus().extendMarkRange('link');
              if (href) chain.setLink({ href }).run();
              else chain.unsetLink().run();
              setLinking(false);
            }}
            onCancel={() => setLinking(false)}
          />
        ) : (
          <>
            <Mark label={t('rich.bold')} active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
              <Bold className="h-4 w-4" />
            </Mark>
            <Mark label={t('rich.italic')} active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
              <Italic className="h-4 w-4" />
            </Mark>
            <Mark label={t('rich.underline')} active={state.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}>
              <Underline className="h-4 w-4" />
            </Mark>
            <Mark label={t('rich.strike')} active={state.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
              <Strikethrough className="h-4 w-4" />
            </Mark>
            <Mark label={t('rich.code')} active={state.code} onClick={() => editor.chain().focus().toggleCode().run()}>
              <Code className="h-4 w-4" />
            </Mark>
            <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
            <Mark label={t('rich.link')} active={state.link} onClick={() => setLinking(true)}>
              <LinkIcon className="h-4 w-4" />
            </Mark>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}

function Mark({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} onClick={onClick} className={cn('flex h-7 w-7 items-center justify-center rounded text-icon hover:bg-panel-2', active && 'bg-brand-soft text-brand')}>
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

function LinkForm({ initial, onDone, onCancel }: { initial: string; onDone: (href: string) => void; onCancel: () => void }) {
  const { t } = useTranslation('editor');
  const id = useId();
  const [href, setHref] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onDone(href.trim());
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-1" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <label htmlFor={id} className="sr-only">
        {t('rich.linkAddress')}
      </label>
      <input id={id} autoFocus value={href} onChange={(e) => setHref(e.target.value)} placeholder={t('rich.linkPlaceholder')} className="h-7 w-56 rounded border border-line bg-bg px-2 text-[12.5px] outline-none focus:border-brand" />
      <button type="submit" className="h-7 rounded bg-brand px-2 text-[12px] text-brand-fg">
        {href.trim() ? t('rich.apply') : t('rich.removeLink')}
      </button>
    </form>
  );
}

/** An image block: its address and alternative text (media library picking comes with the media work). */
function ImageForm({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const { t } = useTranslation('editor');
  const id = useId();
  const [src, setSrc] = useState('');
  const [alt, setAlt] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (src.trim()) editor.chain().focus().setImage({ src: src.trim(), alt: alt.trim() }).run();
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onSubmit={submit} className="w-full max-w-md rounded-card border border-line bg-panel shadow-xl">
        <h2 id={`${id}-title`} className="border-b border-line px-5 py-4 t-section">
          {t('rich.imageTitle')}
        </h2>
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-src`} className="text-[13px] font-medium">
              {t('rich.imageAddress')}
            </label>
            <input id={`${id}-src`} autoFocus required type="url" value={src} onChange={(e) => setSrc(e.target.value)} className="h-9 rounded-ctl border border-line bg-bg px-2.5 text-[13px] outline-none focus:border-brand" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-alt`} className="text-[13px] font-medium">
              {t('rich.imageAlt')}
            </label>
            <input id={`${id}-alt`} value={alt} onChange={(e) => setAlt(e.target.value)} className="h-9 rounded-ctl border border-line bg-bg px-2.5 text-[13px] outline-none focus:border-brand" />
            <p className="t-aux">{t('rich.imageAltHint')}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-ctl border border-line px-3 py-1.5 text-[13px] hover:bg-panel-2">
            {t('rich.cancel')}
          </button>
          <button type="submit" className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg">
            {t('rich.insert')}
          </button>
        </div>
      </form>
    </div>
  );
}

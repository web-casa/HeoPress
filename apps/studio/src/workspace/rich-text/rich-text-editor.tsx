import type { Editor } from '@tiptap/core';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { useQuery } from '@tanstack/react-query';
import { Bold, Code, GripVertical, Italic, Link as LinkIcon, Loader2, Strikethrough, Underline, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { sanitizeHtml } from '@/lib/sanitize-html';
import { getAdminBase } from '@/lib/admin-base';
import { siteKey } from '../api';
import { adoptBlockIds, BlockIds } from './block-ids';
import { fetchUploadTarget, kindOf, refusalOf, uploadMedia, UploadError, type MediaKind, type UploadTarget } from './media';
import { MediaImage, Video } from './media-nodes';
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
  const [asking, setAsking] = useState<MediaKind | null>(null);
  const target = useQuery({ queryKey: siteKey('editor-media-target'), queryFn: fetchUploadTarget, staleTime: 60_000 });
  const uploads = useUploads();
  // Paste and drop reach the editor's own handlers, which are built once: they call the latest upload through a ref.
  const uploadRef = useRef<(files: File[], at?: number) => boolean>(() => false);
  const emitted = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;

  const extensions = useMemo(
    () => [
      StarterKit.configure({ heading: { levels: [2, 3, 4] }, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
      MediaImage,
      Video,
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
    editorProps: {
      attributes: { 'aria-label': label, 'aria-multiline': 'true', role: 'textbox', class: 'rt-content' },
      // Pasted or dropped images and videos are uploaded and put where they landed (ADR-0020).
      handlePaste: (_view, event) => uploadRef.current([...(event.clipboardData?.files ?? [])]),
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        return uploadRef.current([...(event.dataTransfer?.files ?? [])], at);
      },
    },
    onUpdate: ({ editor: e, transaction }) => {
      // Block IDs set from a save are not an edit.
      if (transaction.getMeta('blockIds')) {
        emitted.current = htmlOf(e);
        return;
      }
      const html = htmlOf(e);
      emitted.current = html;
      // The same content as the value is no change: an empty body stored as null is '' here, not an edit.
      if (html === sanitizeHtml(valueRef.current ?? '')) return;
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

  uploadRef.current = (files, at) => {
    const media = files.filter((f) => kindOf(f.type));
    if (!media.length || !editor || !target.data) return false;
    for (const file of media) void uploads.run(editor, target.data, file, at);
    return true;
  };

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
      <UploadStatus items={uploads.items} onDismiss={uploads.dismiss} />
      {asking ? (
        <MediaForm
          kind={asking}
          target={target.data ?? null}
          onUpload={(file) => void uploads.run(editor, target.data!, file)}
          onAddress={(src, alt) => {
            if (asking === 'video') editor.chain().focus().setVideo({ src }).run();
            else editor.chain().focus().setImage({ src, alt }).run();
          }}
          onClose={() => {
            setAsking(null);
            // Back to writing where the "/" was, once the dialog (which holds the focus) is gone.
            requestAnimationFrame(() => {
              if (!editor.isDestroyed) editor.commands.focus();
            });
          }}
        />
      ) : null}
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

interface UploadItem {
  id: string;
  name: string;
  error: string | null;
}

/** Uploads in flight and failed ones, with the reason; a finished upload puts its block where it was asked for. */
function useUploads() {
  const { t } = useTranslation('editor');
  const [items, setItems] = useState<UploadItem[]>([]);
  const dismiss = useCallback((id: string) => setItems((list) => list.filter((i) => i.id !== id)), []);
  const run = useCallback(
    async (editor: Editor, target: UploadTarget, file: File, at?: number) => {
      const id = `${Date.now()}-${Math.random()}`;
      const refusal = refusalOf(file, target);
      if (!target.available || refusal) {
        const error = !target.available
          ? t(`media.${target.reason === 'PUBLIC_URL_REQUIRED' ? 'needPublicUrl' : 'needObjectStorage'}`)
          : refusal!.key === 'size'
            ? t('media.tooLarge', { size: `${Math.round(refusal!.limit! / 1024 / 1024)} MB` })
            : t('media.wrongType');
        setItems((list) => [...list, { id, name: file.name, error }]);
        return;
      }
      setItems((list) => [...list, { id, name: file.name, error: null }]);
      try {
        const { url, key } = await uploadMedia(file, target);
        if (editor.isDestroyed) return;
        const node = kindOf(file.type) === 'video' ? { type: 'video', attrs: { src: url, mediaKey: key } } : { type: 'image', attrs: { src: url, alt: '', mediaKey: key } };
        const pos = at !== undefined && at <= editor.state.doc.content.size ? at : editor.state.selection.to;
        editor.chain().focus().insertContentAt(pos, node).run();
        dismiss(id);
      } catch (err) {
        const message = err instanceof UploadError ? t(`media.failed.${err.code}`, { defaultValue: err.message }) : t('media.failedGeneric');
        setItems((list) => list.map((i) => (i.id === id ? { ...i, error: message } : i)));
      }
    },
    [t, dismiss],
  );
  return { items, run, dismiss };
}

function UploadStatus({ items, onDismiss }: { items: UploadItem[]; onDismiss: (id: string) => void }) {
  const { t } = useTranslation('editor');
  if (!items.length) return null;
  return (
    <ul className="mt-3 flex flex-col gap-1.5">
      {items.map((i) => (
        <li key={i.id} role={i.error ? 'alert' : 'status'} className={cn('flex items-center gap-2 rounded-ctl px-3 py-2 text-[12.5px]', i.error ? 'bg-bad-soft text-bad' : 'bg-panel-2 text-dim')}>
          {i.error ? null : <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          <span className="min-w-0 flex-1 truncate">{i.error ? t('media.failedFor', { name: i.name, reason: i.error }) : t('media.uploading', { name: i.name })}</span>
          {i.error ? (
            <button type="button" onClick={() => onDismiss(i.id)} aria-label={t('rich.cancel')} className="rounded p-0.5 hover:bg-panel">
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Adding an image or a video: upload a file to the site's object storage, or give an address. Without object storage
 * the upload is not offered and the reason points to the storage settings (maintainer decision 2026-10-25).
 */
function MediaForm({ kind, target, onUpload, onAddress, onClose }: { kind: MediaKind; target: UploadTarget | null; onUpload: (file: File) => void; onAddress: (src: string, alt: string) => void; onClose: () => void }) {
  const { t } = useTranslation('editor');
  const id = useId();
  const adminBase = getAdminBase(window.location.pathname);
  const [src, setSrc] = useState('');
  const [alt, setAlt] = useState('');
  const accept = (target?.types ?? []).filter((m) => kindOf(m) === kind);
  const canUpload = !!target?.available && accept.length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (src.trim()) onAddress(src.trim(), alt.trim());
    onClose();
  };
  const input = 'h-9 rounded-ctl border border-line bg-bg px-2.5 text-[13px] outline-none focus:border-brand';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onSubmit={submit} className="w-full max-w-md rounded-card border border-line bg-panel shadow-xl">
        <h2 id={`${id}-title`} className="border-b border-line px-5 py-4 t-section">
          {t(kind === 'video' ? 'media.videoTitle' : 'rich.imageTitle')}
        </h2>
        <div className="flex flex-col gap-4 px-5 py-4">
          {canUpload ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-file`} className="text-[13px] font-medium">
                {t('media.upload')}
              </label>
              <input
                id={`${id}-file`}
                type="file"
                accept={accept.join(',')}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    onUpload(file);
                    onClose();
                  }
                }}
                className="text-[13px] file:mr-3 file:rounded-ctl file:border file:border-line file:bg-panel-2 file:px-3 file:py-1.5 file:text-[13px]"
              />
              <p className="t-aux">{t(kind === 'video' ? 'media.videoHint' : 'media.imageHint', { size: `${Math.round((kind === 'video' ? target!.videoMaxBytes : target!.maxBytes) / 1024 / 1024)} MB` })}</p>
            </div>
          ) : target ? (
            <p role="note" className="rounded-ctl border border-line bg-panel-2 px-3 py-2 text-[12.5px]">
              {t(target.reason === 'PUBLIC_URL_REQUIRED' ? 'media.needPublicUrl' : 'media.needObjectStorage')}{' '}
              <a href={`${adminBase}/settings/advanced/storage`} className="text-brand underline">
                {t('media.storageSettings')}
              </a>
            </p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-src`} className="text-[13px] font-medium">
              {t(kind === 'video' ? 'media.videoAddress' : 'rich.imageAddress')}
            </label>
            <input id={`${id}-src`} autoFocus={!canUpload} type="url" value={src} onChange={(e) => setSrc(e.target.value)} className={input} />
          </div>
          {kind === 'image' ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-alt`} className="text-[13px] font-medium">
                {t('rich.imageAlt')}
              </label>
              <input id={`${id}-alt`} value={alt} onChange={(e) => setAlt(e.target.value)} className={input} />
              <p className="t-aux">{t('rich.imageAltHint')}</p>
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-ctl border border-line px-3 py-1.5 text-[13px] hover:bg-panel-2">
            {t('rich.cancel')}
          </button>
          <button type="submit" disabled={!src.trim()} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
            {t('rich.insert')}
          </button>
        </div>
      </form>
    </div>
  );
}

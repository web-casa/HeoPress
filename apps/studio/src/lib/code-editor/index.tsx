import type { EditorProps } from '@monaco-editor/react';
import { lazy, Suspense } from 'react';

/**
 * The code editor, loaded on first use as its own chunk (HeoPress P07a task 13.6): Monaco is configured with the bundled
 * copy before the editor mounts, so `@monaco-editor/react` never fetches it from a CDN.
 */
const LazyEditor = lazy(async () => {
  const [{ default: Editor, loader }, { monaco }] = await Promise.all([import('@monaco-editor/react'), import('./monaco')]);
  loader.config({ monaco });
  return { default: Editor };
});

export default function CodeEditor(props: EditorProps) {
  return (
    <Suspense fallback={<div className="animate-pulse bg-muted" style={{ height: props.height ?? '100%', width: props.width ?? '100%' }} />}>
      <LazyEditor {...props} />
    </Suspense>
  );
}

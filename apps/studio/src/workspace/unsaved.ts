/**
 * Unsaved edits on this page (ADR-0019 §5.4): an editor registers while it has changes; leaving the page and switching
 * site ask first.
 */
const dirty = new Set<string>();

export function setUnsaved(key: string, unsaved: boolean): void {
  if (unsaved) dirty.add(key);
  else dirty.delete(key);
}

export function hasUnsaved(): boolean {
  return dirty.size > 0;
}

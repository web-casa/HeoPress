/**
 * The correction block in an article body (pure: no host, no I/O).
 *
 * A published correction notice writes one block at the end of the corrected article's body:
 *
 *     <aside data-heopress-correction="<report id>"><p><strong>Correction</strong> (2026-11-14): …</p>…</aside>
 *
 * The marker attribute — the report id, not the notice id — is how the plugin finds its own block again: it is kept in
 * the stored body (the public sanitizer drops the attribute, as it drops the glossary's `data-heopress-glossary`), and
 * before writing the plugin first asks whether a block with that id is already there. So:
 *
 *   - writing twice changes nothing (the second write is not attempted);
 *   - an operator who edits the wording inside the block keeps it: an existing block is never rewritten or duplicated;
 *   - when a notice is unpublished or deleted, exactly that block is removed and the rest of the article is untouched.
 *
 * The block is plain text escaped into markup: the quoted excerpt and the correction are never interpreted as HTML.
 */

/** The attribute that marks a block as the plugin's own; its value is the report id. */
const MARKER_ATTRIBUTE = 'data-heopress-correction';

const REPORT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A report id may carry only letters, digits, `_` and `-` (id-shaped text, safe in an attribute and a regex). The first
 * character may be `-` or `_`: the ids are nanoids, whose alphabet is exactly this set and whose first character is not
 * special. Only the plugin writes these ids into a body, so anything outside the grammar means a hand-edited block.
 */
export function isMarkerId(value: string): boolean {
  return REPORT_ID.test(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The report ids a body already carries a block for, once each, in document order. */
export function markerIds(html: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`${MARKER_ATTRIBUTE}="([^"]*)"`, 'g');
  for (const match of html.matchAll(pattern)) {
    const id = match[1] ?? '';
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Whether the body already holds a block for this report. */
export function hasMarker(html: string, reportId: string): boolean {
  return markerIds(html).includes(reportId);
}

export interface MarkerBlockInput {
  /** The report the block records; its id is the marker. */
  reportId: string;
  /** The word the block starts with, e.g. "Correction" (the plugin's `marker_label` setting). */
  label: string;
  /** The quoted passage, already validated plain text; '' leaves the quote out. */
  excerpt: string;
  /** The correction, already validated plain text. */
  correction: string;
  /** The day the notice went public, `YYYY-MM-DD`. */
  date: string;
}

/** The block itself: the label and day, the correction, then the quote it corrects. */
export function markerBlock(input: MarkerBlockInput): string {
  const quote = input.excerpt ? `<blockquote><p>${escapeHtml(input.excerpt)}</p></blockquote>` : '';
  return (
    `<aside ${MARKER_ATTRIBUTE}="${escapeHtml(input.reportId)}">` +
    `<p><strong>${escapeHtml(input.label)}</strong> (${escapeHtml(input.date)}): ${escapeHtml(input.correction)}</p>` +
    quote +
    '</aside>'
  );
}

/** Append the block at the end of the body, on its own line. */
export function appendMarker(html: string, block: string): string {
  const base = html.replace(/\s+$/, '');
  return base ? `${base}\n${block}` : block;
}

/**
 * Remove the block of one report, if the body has one. The opening tag is found by its marker attribute and the block
 * ends at the next `</aside>`; a block whose closing tag an operator removed loses only its opening tag (the rest of
 * the body is never swallowed). The single newline the writer added is removed with it.
 */
export function withoutMarker(html: string, reportId: string): string {
  if (!isMarkerId(reportId)) return html;
  const opening = new RegExp(`<aside\\b[^>]*\\s${MARKER_ATTRIBUTE}="${escapeRegExp(reportId)}"[^>]*>`, 'i');
  let current = html;
  for (;;) {
    const match = opening.exec(current);
    if (!match) return current;
    const start = match.index;
    const innerEnd = start + match[0].length;
    const closing = current.indexOf('</aside>', innerEnd);
    const end = closing === -1 ? innerEnd : closing + '</aside>'.length;
    const from = start > 0 && current[start - 1] === '\n' ? start - 1 : start;
    current = current.slice(0, from) + current.slice(end);
  }
}

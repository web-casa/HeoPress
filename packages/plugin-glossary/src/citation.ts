/**
 * The glossary's quality-gate check (pure): a term's definition has to cite its source. A term without a source URL, or
 * with one that is not an http(s) address, needs a person to look at it (`needs_review`); the gate never lets the
 * plugin lift a core verdict, it can only add this one.
 */
import type { GateCheckVerdict } from '@heopress/extension-sdk';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function citationVerdict(fields: Readonly<Record<string, unknown>>): GateCheckVerdict {
  const url = str(fields.source_url);
  if (!url) {
    return {
      verdict: 'needs_review',
      evidence: { missing: 'source_url' },
      suggestions: ['Cite the source of the definition: add its address under "Source URL".'],
    };
  }
  let ok = false;
  try {
    const parsed = new URL(url);
    ok = (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname.length > 0;
  } catch {
    ok = false;
  }
  if (!ok) {
    return {
      verdict: 'needs_review',
      evidence: { invalid: 'source_url', value: url.slice(0, 200) },
      suggestions: ['The source must be an http(s) address.'],
    };
  }
  return { verdict: 'passed', evidence: { source: url.slice(0, 500), ...(str(fields.source_title) ? { title: str(fields.source_title).slice(0, 200) } : {}) } };
}

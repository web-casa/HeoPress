/**
 * Single-key and two-key shortcuts of the workspace (ADR-0019 §5.7):
 * `G` then a module letter, `?` for help, `J` / `K` in lists. Never fired
 * while typing in a field or with a modifier held; `G` waits at most
 * `SEQUENCE_TIMEOUT_MS` for its second key.
 */
export const SEQUENCE_TIMEOUT_MS = 1200;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true;
}

export type SequenceResult = { kind: 'jump'; key: string } | { kind: 'help' } | { kind: 'pending' } | null;

export interface KeyLike {
  key: string;
  target: EventTarget | null;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  timeStamp: number;
}

/** A stateful matcher: feed it key events, it answers what (if anything) they mean. */
export function createSequenceMatcher(jumpKeys: Pick<ReadonlySet<string>, 'has'>) {
  let pendingSince: number | null = null;
  return (event: KeyLike): SequenceResult => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
      pendingSince = null;
      return null;
    }
    const key = event.key.toLowerCase();
    if (pendingSince !== null) {
      const fresh = event.timeStamp - pendingSince <= SEQUENCE_TIMEOUT_MS;
      pendingSince = null;
      if (fresh && jumpKeys.has(key)) return { kind: 'jump', key };
      if (fresh) return null;
    }
    if (key === 'g') {
      pendingSince = event.timeStamp;
      return { kind: 'pending' };
    }
    if (event.key === '?') return { kind: 'help' };
    return null;
  };
}

/** `J` / `K` (and arrow keys) as next / previous, outside fields. */
export function listStep(event: KeyLike): 1 | -1 | 0 {
  if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return 0;
  if (event.key === 'j' || event.key === 'J') return 1;
  if (event.key === 'k' || event.key === 'K') return -1;
  return 0;
}

import { describe, expect, it } from 'vitest';
import { createSequenceMatcher, listStep, SEQUENCE_TIMEOUT_MS, type KeyLike } from '../sequences';

const body = { tagName: 'BODY' } as unknown as EventTarget;
const input = { tagName: 'INPUT' } as unknown as EventTarget;
const editable = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget;
const key = (k: string, timeStamp: number, target: EventTarget = body, extra: Partial<KeyLike> = {}): KeyLike => ({ key: k, target, timeStamp, ...extra });

describe('G + letter (p07a task 2.7)', () => {
  it('jumps with G then a module letter', () => {
    const match = createSequenceMatcher(new Set(['a', 'o']));
    expect(match(key('g', 0))).toEqual({ kind: 'pending' });
    expect(match(key('a', 300))).toEqual({ kind: 'jump', key: 'a' });
  });

  it('the second key must come within the timeout', () => {
    const match = createSequenceMatcher(new Set(['a']));
    match(key('g', 0));
    expect(match(key('a', SEQUENCE_TIMEOUT_MS + 1))).toBeNull();
    // …and a late key starts nothing by itself.
    expect(match(key('a', SEQUENCE_TIMEOUT_MS + 2))).toBeNull();
  });

  it('never fires while typing in a field, or with a modifier', () => {
    const match = createSequenceMatcher(new Set(['a']));
    expect(match(key('g', 0, input))).toBeNull();
    expect(match(key('a', 10, input))).toBeNull();
    expect(match(key('g', 20, editable))).toBeNull();
    expect(match(key('?', 30, input))).toBeNull();
    expect(match(key('g', 40, body, { metaKey: true }))).toBeNull();
  });

  it('G followed by typing in a field cancels the sequence', () => {
    const match = createSequenceMatcher(new Set(['a']));
    match(key('g', 0));
    expect(match(key('a', 100, input))).toBeNull();
    expect(match(key('a', 200))).toBeNull();
  });

  it('? asks for help; an unknown second key does nothing', () => {
    const match = createSequenceMatcher(new Set(['a']));
    expect(match(key('?', 0))).toEqual({ kind: 'help' });
    match(key('g', 10));
    expect(match(key('z', 20))).toBeNull();
  });
});

describe('J / K', () => {
  it('next and previous outside fields only', () => {
    expect(listStep(key('j', 0))).toBe(1);
    expect(listStep(key('K', 0))).toBe(-1);
    expect(listStep(key('j', 0, input))).toBe(0);
    expect(listStep(key('x', 0))).toBe(0);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { FieldResource } from '@heopress/sdk';

// Each sub-field's own editor is out of scope here (and the registry loads the extensions).
vi.mock('../registry', () => ({ resolveInterface: () => () => null }));

import { RepeaterInterface } from '../repeater';

/** The repeater shows its sub-fields by their labels (HeoPress P07: the preset's questions-and-answers field), names as a fallback. */
afterEach(cleanup);

describe('RepeaterInterface', () => {
  it('labels each sub-field with its label, or its name when it has none', () => {
    const field = {
      name: 'faq',
      type: 'json',
      interface: 'repeater',
      options: {
        fields: [
          { name: 'question', type: 'string', interface: 'input', label: 'Question' },
          { name: 'answer', type: 'text', interface: 'textarea' },
        ],
      },
    } as unknown as FieldResource;
    render(<RepeaterInterface field={field} value={[{ question: 'Why?', answer: 'Because.' }]} onChange={vi.fn()} />);
    const labels = [...document.querySelectorAll('label')].map((l) => l.firstChild?.textContent);
    expect(labels).toEqual(['Question', 'answer']);
    expect(screen.queryByText(/^question$/)).toBeNull();
  });

  it('reads its sub-fields from `options` (the API) or, when that is empty, from `meta.options` (older callers)', () => {
    const subFields = [{ name: 'question', type: 'string', interface: 'input', label: 'Question' }];
    for (const field of [
      { name: 'faq', type: 'json', interface: 'repeater', options: { fields: subFields } },
      { name: 'faq', type: 'json', interface: 'repeater', options: {}, meta: { options: { fields: subFields } } },
    ]) {
      render(<RepeaterInterface field={field as unknown as FieldResource} value={[{ question: 'Why?' }]} onChange={vi.fn()} />);
      expect([...document.querySelectorAll('label')].map((l) => l.firstChild?.textContent)).toEqual(['Question']);
      cleanup();
    }
  });
});

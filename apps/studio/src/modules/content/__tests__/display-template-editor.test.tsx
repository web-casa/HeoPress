// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { DisplayTemplateEditor } from '../display-template-editor';
import { emptyComponentTemplate } from '../block-template-types';

/** Mode re-detection when the value is loaded from or reset to null (P02 task 8.5). */

const hint = () => screen.getByText(/Simple text template|Visual component DSL/).textContent;
const BLOCK = JSON.stringify(emptyComponentTemplate());

afterEach(cleanup);

describe('DisplayTemplateEditor mode detection', () => {
  it('detects block mode when a block template loads after null, and resets on null', () => {
    const { rerender } = render(<DisplayTemplateEditor value={null} onChange={() => {}} />);
    expect(hint()).toMatch(/Simple text template/);
    rerender(<DisplayTemplateEditor value={BLOCK} onChange={() => {}} />);
    expect(hint()).toMatch(/Visual component DSL/);
    rerender(<DisplayTemplateEditor value={null} onChange={() => {}} />);
    expect(hint()).toMatch(/Simple text template/);
  });
});

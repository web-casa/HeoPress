// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

import { visibleModules } from '../modules';
import { useModuleJumps } from '../shortcuts';

/**
 * `G` then a module letter, mounted in the shell (HeoPress P07a task 2.7): the shell rendering again between the two
 * keys — a query settling is enough — keeps the pending `G`. (One matcher made per render forgot it, since the module
 * list is a new array on every render; the Studio keyboard scenario then stayed on the overview on a slow runner.)
 */

let rerender: () => void = () => undefined;
function Shell({ onHelp }: { onHelp: () => void }) {
  const [, setTick] = useState(0);
  rerender = () => setTick((n) => n + 1);
  useModuleJumps(visibleModules(true), '/admin', onHelp);
  return null;
}

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

describe('useModuleJumps', () => {
  it('a render between G and the letter keeps the G', () => {
    render(<Shell onHelp={() => undefined} />);
    fireEvent.keyDown(window, { key: 'g' });
    act(() => rerender());
    fireEvent.keyDown(window, { key: 'u' });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ to: '/admin/audit' });
  });

  it('follows the modules of the latest render: a module that is no longer visible is not jumped to', () => {
    function Member() {
      const [admin, setAdmin] = useState(true);
      rerender = () => setAdmin(false);
      useModuleJumps(visibleModules(admin), '/admin', () => undefined);
      return null;
    }
    render(<Member />);
    act(() => rerender());
    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'l' });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'o' });
    expect(navigate).toHaveBeenCalledWith({ to: '/admin/overview' });
  });

  it('`?` opens the help, and typing in a field jumps nowhere', () => {
    const onHelp = vi.fn();
    const { container } = render(
      <>
        <Shell onHelp={onHelp} />
        <input aria-label="field" />
      </>,
    );
    fireEvent.keyDown(window, { key: '?' });
    expect(onHelp).toHaveBeenCalledTimes(1);
    const field = container.ownerDocument.querySelector('input')!;
    fireEvent.keyDown(field, { key: 'g' });
    fireEvent.keyDown(field, { key: 'u' });
    expect(navigate).not.toHaveBeenCalled();
  });
});

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The id of the context panel's slot in the workspace shell. */
export const PANEL_SLOT_ID = 'ws-panel-slot';

/**
 * A module's second-level panel (views, filters, sections — ADR-0019 §1).
 * Rendered into the shell's context panel, which is the drawer on narrow
 * screens, so each module owns its panel without the shell knowing it.
 */
export function ModulePanel({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(PANEL_SLOT_ID)), []);
  return slot ? createPortal(children, slot) : null;
}

/** A titled group of links or controls inside a module panel. */
export function PanelSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      {title ? <h2 className="mb-1 px-2 text-[11.5px] font-semibold uppercase tracking-wide text-dim">{title}</h2> : null}
      <div className="flex flex-col gap-px">{children}</div>
    </section>
  );
}

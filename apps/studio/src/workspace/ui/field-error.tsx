import type { ReactNode } from 'react';

/** An in-place field error, tied to its input by `id` (ADR-0019 §5.4). */
export function FieldError({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-[12.5px] text-bad">
      {children}
    </p>
  );
}

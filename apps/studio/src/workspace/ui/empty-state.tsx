import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** Says why there is nothing and what to do next (ADR-0019 §5.5). */
export function EmptyState({ icon: Icon, title, body, action }: { icon?: LucideIcon; title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line px-6 py-10 text-center">
      {Icon ? <Icon className="h-6 w-6 text-icon" strokeWidth={1.8} aria-hidden="true" /> : null}
      <p className="t-section">{title}</p>
      {body ? <p className="max-w-md t-aux">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

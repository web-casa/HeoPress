import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** A titled panel: the overview's cards (the briefing's three sections, the week and the setup checklist). */
export function Card({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-card border border-line bg-panel p-4', className)} aria-label={title}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="t-section">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

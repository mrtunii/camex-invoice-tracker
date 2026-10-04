import { Spinner, Table, cn } from '@heroui/react';
import type { ReactNode } from 'react';

/**
 * Every table: HeroUI's flat Table in a surface panel (10 px corners, a 1 px line, no shadow).
 * Wide tables scroll inside the panel, never the page.
 */
export function TablePanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Table
      variant="secondary"
      className={cn('overflow-hidden rounded-panel border border-line bg-surface', className)}
    >
      <Table.ScrollContainer>{children}</Table.ScrollContainer>
    </Table>
  );
}

/** What a table body shows without rows: a spinner while loading, else a sentence on what to do. */
export function TableEmpty({ loading, children }: { loading: boolean; children: ReactNode }) {
  return (
    <div className="px-6 py-12 text-center text-muted">
      {loading ? (
        <Spinner size="sm" color="current" aria-label="Loading" className="mx-auto" />
      ) : (
        children
      )}
    </div>
  );
}

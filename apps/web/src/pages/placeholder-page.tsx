import type { ReactNode } from 'react';
import { PageHeader } from '@/components/page-header';

/** Stand-in for screens built in later tasks (Invoices T05/T06, Vendors T04). */
export function PlaceholderPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} />
      <div className="rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
        <p className="mx-auto max-w-md text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

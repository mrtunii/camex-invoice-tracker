import type { ReactNode } from 'react';
import { useDocumentTitle } from '@/lib/document-title';

/** The page title (20 px) and at most one primary action on the right. */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl font-semibold">{title}</h1>
        {description !== undefined && <p className="max-w-prose text-muted">{description}</p>}
      </div>
      {action !== undefined && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </header>
  );
}

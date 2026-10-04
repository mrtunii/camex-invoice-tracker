import type { ReactNode } from 'react';

/** Login and the forced password change: a centred form on the canvas, the wordmark in type. */
export function AuthScreen({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="grid min-h-svh place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-8">
        <p className="flex items-baseline gap-2">
          <span className="text-xl font-bold">Camex</span>
          <span className="text-xl text-muted">Invoices</span>
        </p>
        <div className="space-y-6 rounded-panel border border-line bg-surface p-6">
          <div className="space-y-1">
            <h1 className="text-base font-semibold">{title}</h1>
            <p className="text-muted">{description}</p>
          </div>
          {children}
        </div>
        {footer}
      </div>
    </main>
  );
}

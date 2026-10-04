import { cn } from '@heroui/react';
import { Fragment } from 'react';

/**
 * An identifier (invoice number, file name) that wraps instead of being cut: the end of
 * "PFSG-CAM-00000000510" is what tells invoices apart. Lines break after - / _ . first (Unicode
 * line breaking forbids a break between a hyphen and digits), anywhere as a last resort.
 */
export function WrappingIdentifier({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(?<=[-/_.])/);
  return (
    <span className={cn('block min-w-0 [overflow-wrap:anywhere]', className)}>
      {parts.map((part, i) => (
        <Fragment key={`${String(i)}-${part}`}>
          {i > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

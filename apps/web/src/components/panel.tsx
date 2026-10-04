import { cn } from '@heroui/react';
import type { ReactNode } from 'react';

/**
 * A surface on the canvas: 10 px corners and a 1 px line, never a shadow. Tables, Home panels
 * and the month ledger sit in one.
 */
export function Panel({
  children,
  className,
  as: Container = 'div',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article';
  'aria-labelledby'?: string;
  'aria-label'?: string;
}) {
  return (
    <Container className={cn('rounded-panel border border-line bg-surface', className)} {...rest}>
      {children}
    </Container>
  );
}

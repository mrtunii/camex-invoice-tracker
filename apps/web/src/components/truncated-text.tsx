import { cn } from '@heroui/react';
import { useState } from 'react';

/**
 * Text cut to fit its container (one line with an ellipsis, or `lines={2}`). Hovering shows the
 * full value as the native title, only when it is actually cut; it adds no tab stop to dense
 * tables. Screen readers always get the full text.
 */
export function TruncatedText({
  text,
  lines = 1,
  className,
}: {
  text: string;
  lines?: 1 | 2;
  className?: string;
}) {
  const [cut, setCut] = useState(false);
  return (
    <span
      title={cut ? text : undefined}
      onPointerEnter={(e) => {
        const el = e.currentTarget;
        setCut(el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
      }}
      className={cn(
        'block min-w-0',
        lines === 1 ? 'truncate' : 'line-clamp-2 break-words',
        className,
      )}
    >
      {text}
    </span>
  );
}

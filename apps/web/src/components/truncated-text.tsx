import { useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Text cut to fit its container (one line with an ellipsis, or `lines={2}`); hovering shows the
 * full value in a tooltip, but only when it is actually cut. Screen readers always get the full
 * text.
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
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const el = ref.current;
        const cut =
          el !== null && (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
        setOpen(next && cut);
      }}
    >
      <TooltipTrigger asChild>
        <span
          ref={ref}
          className={cn(
            'block min-w-0',
            lines === 1 ? 'truncate' : 'line-clamp-2 break-words',
            className,
          )}
        >
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="break-words">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

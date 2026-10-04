import { cn } from '@heroui/react';
import type { Tone } from '@/lib/format';
import { toneClass } from '@/lib/tone';

/** Coloured text for a date or reason; the colour is repeated in words for screen readers. */
export function ToneText({
  text,
  tone,
  srHint,
  className,
}: {
  text: string;
  tone: Tone;
  /** Extra words for screen readers, e.g. the full date behind "Overdue 3 days". */
  srHint?: string;
  className?: string;
}) {
  return (
    <span className={cn(toneClass(tone), tone !== null && 'font-medium', className)}>
      {text}
      {srHint !== undefined && <span className="sr-only"> ({srHint})</span>}
    </span>
  );
}

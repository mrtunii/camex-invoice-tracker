import { Link, cn } from '@heroui/react';
import { Fragment } from 'react';
import { toneClass } from '@/lib/tone';
import type { Sentence } from '@/lib/attention';

/**
 * The one bold element on Home (30 px, weight 500): what needs attention, in plain words.
 * Numbers link to the matching list; the rest of the page stays quiet.
 */
export function StatusSentence({ sentences }: { sentences: Sentence[] }) {
  return (
    <h1 className="max-w-3xl text-3xl font-medium tracking-tight text-balance">
      {sentences.map((parts, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          {parts.map((part, j) =>
            part.href === undefined ? (
              <Fragment key={j}>{part.text}</Fragment>
            ) : (
              <Link
                key={j}
                href={part.href}
                className={cn(
                  'text-3xl font-medium underline decoration-1 underline-offset-[5px] hover:decoration-2',
                  toneClass(part.tone ?? null) ?? 'text-primary',
                )}
              >
                {part.text}
              </Link>
            ),
          )}
        </Fragment>
      ))}
    </h1>
  );
}

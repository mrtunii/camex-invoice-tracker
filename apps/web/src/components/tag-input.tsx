import { X } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { cn } from '@/lib/utils';

interface TagInputProps {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** Called with a message when typed text is refused, and with null once it is fine again. */
  onError: (message: string | null) => void;
  /** Returns why a value can't be added, or null. Runs on the normalized value. */
  validate?: (value: string, current: string[]) => string | null;
  normalize?: (raw: string) => string;
  /** Characters that also add the typed value (Enter always does). */
  separators?: string[];
  placeholder?: string;
  invalid?: boolean;
  mono?: boolean;
  'aria-describedby'?: string;
}

/**
 * A list of short values edited as chips: type and press Enter (or a separator) to add, ×
 * or Backspace on an empty input to remove. Typed text is also added on blur, so a value isn't
 * lost when the user goes straight to Save.
 */
export function TagInput({
  id,
  value,
  onChange,
  onError,
  validate,
  normalize = (raw) => raw.trim(),
  separators = [],
  placeholder,
  invalid,
  mono,
  ...aria
}: TagInputProps) {
  const [text, setText] = useState('');

  /** Adds the typed text; returns false (and keeps it) when it is refused. */
  function commit(raw: string): boolean {
    const next = normalize(raw);
    if (next === '') {
      setText('');
      return true;
    }
    const error = validate?.(next, value) ?? null;
    onError(error);
    if (error !== null) return false;
    if (!value.includes(next)) onChange([...value, next]);
    setText('');
    return true;
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || separators.includes(e.key)) {
      e.preventDefault();
      commit(text);
    } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div
      className={cn(
        'flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg border border-input px-1.5 py-1 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
        invalid && 'border-destructive ring-3 ring-destructive/20',
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className={cn(
            'inline-flex max-w-full items-center gap-0.5 rounded-md bg-secondary py-0.5 pr-0.5 pl-2 text-xs text-secondary-foreground',
            mono && 'font-mono',
          )}
        >
          <span className="truncate">{tag}</span>
          <button
            type="button"
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label={`Remove ${tag}`}
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (invalid) onError(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commit(text)}
        placeholder={value.length === 0 ? placeholder : undefined}
        aria-invalid={invalid}
        className={cn(
          'h-6 min-w-32 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground md:text-sm',
          mono && 'font-mono',
        )}
        {...aria}
      />
    </div>
  );
}

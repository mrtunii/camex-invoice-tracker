import { Description, ErrorMessage, Label, Tag, TagGroup, cn } from '@heroui/react';
import { type KeyboardEvent, useId, useState } from 'react';

interface TagInputProps {
  label: string;
  /** Accessible name of the text box, e.g. "Add an alias". */
  addLabel: string;
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
  description?: string;
  /** The message to show (a refused value or a server error), or null. */
  error: string | null;
}

/**
 * A list of short values edited as removable tags (the one place the UI shows chips): type and
 * press Enter (or a separator) to add, the tag's × or Backspace on an empty box to remove. Typed
 * text is also added on blur, so a value isn't lost when the user goes straight to Save.
 */
export function TagInput({
  label,
  addLabel,
  value,
  onChange,
  onError,
  validate,
  normalize = (raw) => raw.trim(),
  separators = [],
  placeholder,
  description,
  error,
}: TagInputProps) {
  const inputId = useId();
  const [text, setText] = useState('');

  /** Adds the typed text; keeps it (and reports why) when it is refused. */
  function commit(raw: string) {
    const next = normalize(raw);
    if (next === '') {
      setText('');
      return;
    }
    const refused = validate?.(next, value) ?? null;
    onError(refused);
    if (refused !== null) return;
    if (!value.includes(next)) onChange([...value, next]);
    setText('');
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
    <TagGroup
      size="sm"
      onRemove={(keys) => onChange(value.filter((tag) => !keys.has(tag)))}
      className="flex flex-col gap-1.5"
    >
      <Label>{label}</Label>
      <div
        className={cn(
          'flex min-h-9 w-full flex-wrap items-center gap-1 rounded-field border border-field-border bg-field px-1.5 py-1 transition-colors focus-within:border-field-border-focus',
          error !== null && 'border-danger',
        )}
      >
        {value.length > 0 && (
          <TagGroup.List className="contents">
            {value.map((tag) => (
              <Tag key={tag} id={tag} textValue={tag}>
                {tag}
              </Tag>
            ))}
          </TagGroup.List>
        )}
        <input
          id={inputId}
          value={text}
          aria-label={addLabel}
          aria-invalid={error !== null}
          onChange={(e) => {
            setText(e.target.value);
            if (error !== null) onError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => commit(text)}
          placeholder={value.length === 0 ? placeholder : undefined}
          className="h-7 min-w-32 flex-1 bg-transparent px-1.5 text-sm text-field-foreground outline-none placeholder:text-field-placeholder"
        />
      </div>
      {description !== undefined && <Description>{description}</Description>}
      <ErrorMessage>{error}</ErrorMessage>
    </TagGroup>
  );
}

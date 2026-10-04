import { Check, ChevronDown, X } from 'lucide-react';
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Extra text the search matches (e.g. a currency's name). */
  keywords?: string;
}

/**
 * A select with a search box: type to narrow the options, arrows + Enter to pick. `value` null
 * shows the placeholder; the clear button sets it back to null.
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder = 'Search…',
  emptyText = 'No matches',
  label,
  className,
}: {
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Accessible name, e.g. "Vendor". */
  label: string;
  className?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((option) => option.value === value) ?? null;
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return options;
    return options.filter((option) =>
      `${option.label} ${option.keywords ?? ''}`.toLowerCase().includes(needle),
    );
  }, [options, query]);

  function openChange(next: boolean) {
    setOpen(next);
    if (next) {
      setQuery('');
      setActive(
        Math.max(
          0,
          options.findIndex((option) => option.value === value),
        ),
      );
    }
  }

  function pick(option: ComboboxOption) {
    onChange(option.value);
    setOpen(false);
  }

  function moveTo(index: number) {
    setActive(index);
    listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveTo(Math.min(active + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveTo(Math.max(active - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = matches[active];
      if (option) pick(option);
    }
  }

  return (
    <div className={cn('relative flex', className)}>
      <Popover open={open} onOpenChange={openChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label={selected ? `${label}: ${selected.label}` : label}
            className={cn(
              'w-full justify-between gap-1.5 px-2.5 font-normal',
              selected === null && 'text-muted-foreground',
              selected !== null && 'pr-8',
            )}
          >
            <span className="truncate">{selected?.label ?? placeholder}</span>
            {selected === null && <ChevronDown className="opacity-60" aria-hidden />}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 gap-1.5 p-1.5">
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={matches[active] ? `${listId}-${String(active)}` : undefined}
            aria-label={`Search ${label.toLowerCase()}`}
            value={query}
            placeholder={searchPlaceholder}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            className="max-h-64 overflow-y-auto"
          >
            {matches.length === 0 && (
              <li className="px-2 py-1.5 text-sm text-muted-foreground">{emptyText}</li>
            )}
            {matches.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${String(index)}`}
                role="option"
                aria-selected={option.value === value}
                onMouseMove={() => setActive(index)}
                onClick={() => pick(option)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                  index === active && 'bg-muted',
                )}
              >
                <Check
                  className={cn('size-3.5 shrink-0', option.value !== value && 'invisible')}
                  aria-hidden
                />
                <span className="min-w-0 truncate">{option.label}</span>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
      {selected !== null && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => onChange(null)}
          className="absolute top-1/2 right-1.5 -translate-y-1/2"
        >
          <X aria-hidden />
        </Button>
      )}
    </div>
  );
}

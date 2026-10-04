import { type InvoiceCategory, invoiceCategorySchema } from '@camex/shared';
import { AlertCircle, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type ComboboxOption, Combobox } from '@/components/combobox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CATEGORY_LABELS } from '@/lib/invoice-labels';
import { cn } from '@/lib/utils';
import { useVendors } from '@/pages/vendors/vendors-query';
import { type ListFilters, NO_FILTERS, hasActiveFilters } from './list-params';

export type SetFilters = (patch: Partial<ListFilters>, options?: { replace?: boolean }) => void;

const SEARCH_DEBOUNCE_MS = 300;

/** Search box; the URL follows the text after a pause in typing (replacing, not pushing, history). */
function SearchBox({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const [text, setText] = useState(value);
  // Follow the URL when it changes from elsewhere (Clear filters, back/forward).
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setText(value);
  }

  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => onChange(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, value, onChange]);

  const tooShort = text.trim().length === 1;
  return (
    <div className="relative w-full sm:w-60">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Vendor, invoice #, flight, reg."
        aria-label="Search invoices"
        aria-describedby={tooShort ? 'invoice-search-hint' : undefined}
        className="pl-8"
      />
      {tooShort && (
        <p
          id="invoice-search-hint"
          className="absolute top-full left-0 mt-0.5 text-xs text-muted-foreground"
        >
          Type at least 2 characters
        </p>
      )}
    </div>
  );
}

let currencyOptionsCache: ComboboxOption[] | null = null;

/** ISO 4217 codes from the browser, the usual ones first. */
function currencyOptions(): ComboboxOption[] {
  if (currencyOptionsCache) return currencyOptionsCache;
  const names = new Intl.DisplayNames(['en'], { type: 'currency' });
  const first = ['GEL', 'USD', 'EUR'];
  const codes = [
    ...first,
    ...Intl.supportedValuesOf('currency').filter((code) => !first.includes(code)),
  ];
  currencyOptionsCache = codes.map((code) => ({
    value: code,
    label: code,
    keywords: names.of(code) ?? '',
  }));
  return currencyOptionsCache;
}

const selectClass =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

export function InvoiceFilters({
  filters,
  onChange,
}: {
  filters: ListFilters;
  onChange: SetFilters;
}) {
  const vendors = useVendors('');
  const vendorOptions = useMemo(
    () => (vendors.data ?? []).map((vendor) => ({ value: vendor.id, label: vendor.name })),
    [vendors.data],
  );
  const onSearch = useCallback((q: string) => onChange({ q }, { replace: true }), [onChange]);

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-3" role="search">
      <SearchBox value={filters.q} onChange={onSearch} />
      <Combobox
        label="Vendor"
        placeholder="All vendors"
        searchPlaceholder="Search vendors…"
        emptyText={vendors.isPending ? 'Loading…' : 'No vendor found'}
        options={vendorOptions}
        value={filters.vendorId}
        onChange={(vendorId) => onChange({ vendorId })}
        className="w-44"
      />
      <select
        aria-label="Category"
        value={filters.category ?? ''}
        onChange={(e) => {
          const parsed = invoiceCategorySchema.safeParse(e.target.value);
          onChange({ category: parsed.success ? parsed.data : null });
        }}
        className={cn(selectClass, 'w-40', filters.category === null && 'text-muted-foreground')}
      >
        <option value="">All categories</option>
        {(Object.keys(CATEGORY_LABELS) as InvoiceCategory[]).map((category) => (
          <option key={category} value={category} className="text-foreground">
            {CATEGORY_LABELS[category]}
          </option>
        ))}
      </select>
      <Combobox
        label="Currency"
        placeholder="Any currency"
        searchPlaceholder="Code or name…"
        options={currencyOptions()}
        value={filters.currency}
        onChange={(currency) => onChange({ currency })}
        className="w-36"
      />
      <fieldset className="flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:w-auto sm:flex-nowrap">
        <legend className="sr-only">Invoice date</legend>
        <span className="w-full shrink-0 text-sm text-muted-foreground sm:w-auto" aria-hidden>
          Invoice date
        </span>
        <Input
          type="date"
          aria-label="Invoice date from"
          value={filters.invoiceDateFrom ?? ''}
          max={filters.invoiceDateTo ?? undefined}
          onChange={(e) => onChange({ invoiceDateFrom: e.target.value || null })}
          className="min-w-0 flex-1 sm:w-36 sm:flex-none"
        />
        <span className="text-muted-foreground" aria-hidden>
          –
        </span>
        <Input
          type="date"
          aria-label="Invoice date to"
          value={filters.invoiceDateTo ?? ''}
          min={filters.invoiceDateFrom ?? undefined}
          onChange={(e) => onChange({ invoiceDateTo: e.target.value || null })}
          className="min-w-0 flex-1 sm:w-36 sm:flex-none"
        />
      </fieldset>
      <Button
        type="button"
        variant="outline"
        aria-pressed={filters.hasErrors}
        onClick={() => onChange({ hasErrors: !filters.hasErrors })}
        className={cn(
          'font-normal',
          filters.hasErrors &&
            'border-destructive/50 bg-destructive/8 text-destructive hover:bg-destructive/12 hover:text-destructive',
        )}
      >
        <AlertCircle aria-hidden />
        Has errors
      </Button>
      {filters.due !== null && (
        <span className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-muted pr-1 pl-2.5 text-sm">
          {filters.due === 'overdue' ? 'Overdue' : 'Due in 7 days'}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Remove due filter"
            onClick={() => onChange({ due: null })}
          >
            <X aria-hidden />
          </Button>
        </span>
      )}
      {hasActiveFilters(filters) && (
        <Button type="button" variant="ghost" onClick={() => onChange(NO_FILTERS)}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

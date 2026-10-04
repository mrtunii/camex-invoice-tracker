import { type InvoiceCategory, invoiceCategorySchema } from '@camex/shared';
import {
  Button,
  ComboBox,
  DateField,
  DateRangePicker,
  Input,
  ListBox,
  Popover,
  RangeCalendar,
  SearchField,
  Select,
  Switch,
  cn,
} from '@heroui/react';
import { parseDate } from '@internationalized/date';
import { SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CATEGORY_LABELS } from '@/lib/invoice-labels';
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
      <SearchField value={text} onChange={setText} aria-label="Search invoices" fullWidth>
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input
            placeholder="Vendor, invoice #, flight…"
            aria-describedby={tooShort ? 'invoice-search-hint' : undefined}
          />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>
      {tooShort && (
        <p id="invoice-search-hint" className="absolute top-full left-0 mt-0.5 text-xs text-muted">
          Type at least 2 characters
        </p>
      )}
    </div>
  );
}

interface Option {
  id: string;
  label: string;
}

let currencyCache: { options: Option[]; names: Map<string, string> } | null = null;

/** ISO 4217 codes from the browser, the usual ones first; names for search ("lari" → GEL). */
function currencies() {
  if (currencyCache) return currencyCache;
  const display = new Intl.DisplayNames(['en'], { type: 'currency' });
  const first = ['GEL', 'USD', 'EUR'];
  const codes = [
    ...first,
    ...Intl.supportedValuesOf('currency').filter((code) => !first.includes(code)),
  ];
  currencyCache = {
    options: codes.map((code) => ({ id: code, label: code })),
    names: new Map(codes.map((code) => [code, display.of(code) ?? ''])),
  };
  return currencyCache;
}

/**
 * A searchable single choice that can be cleared (vendor, currency). `filter` matches typed text
 * against an option's label (and anything else it knows).
 */
function FilterComboBox({
  label,
  placeholder,
  options,
  value,
  onChange,
  emptyText,
  matches = (text, input) => text.toLowerCase().includes(input.toLowerCase()),
  className,
}: {
  label: string;
  placeholder: string;
  options: Option[];
  value: string | null;
  onChange: (value: string | null) => void;
  emptyText: string;
  matches?: (text: string, input: string) => boolean;
  className?: string;
}) {
  return (
    <ComboBox
      aria-label={label}
      value={value}
      onChange={(key) => onChange(key === null || Array.isArray(key) ? null : String(key))}
      defaultFilter={(text, input) => input === '' || matches(text, input)}
      className={cn('w-40', className)}
    >
      <ComboBox.InputGroup>
        <Input placeholder={placeholder} />
        <ComboBox.Trigger />
      </ComboBox.InputGroup>
      <ComboBox.Popover className="min-w-56">
        <ListBox
          items={options}
          renderEmptyState={() => <p className="px-3 py-2 text-muted">{emptyText}</p>}
        >
          {(option) => (
            <ListBox.Item id={option.id} textValue={option.label}>
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          )}
        </ListBox>
      </ComboBox.Popover>
    </ComboBox>
  );
}

const CATEGORY_OPTIONS = (Object.keys(CATEGORY_LABELS) as InvoiceCategory[]).map((category) => ({
  id: category,
  label: CATEGORY_LABELS[category],
}));

function CategorySelect({
  value,
  onChange,
  className,
}: {
  value: InvoiceCategory | null;
  onChange: (value: InvoiceCategory | null) => void;
  className?: string;
}) {
  return (
    <Select
      aria-label="Category"
      placeholder="All categories"
      value={value}
      onChange={(key) => {
        const parsed = invoiceCategorySchema.safeParse(key);
        onChange(parsed.success ? parsed.data : null);
      }}
      className={cn('w-40', className)}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.ClearButton />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox items={CATEGORY_OPTIONS}>
          {(option) => (
            <ListBox.Item id={option.id} textValue={option.label}>
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          )}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/**
 * Invoice date range. A range has both ends; a URL with only one (typed by hand) still filters,
 * and Clear filters removes it.
 */
function InvoiceDateRange({
  from,
  to,
  onChange,
  className,
}: {
  from: string | null;
  to: string | null;
  onChange: (range: { invoiceDateFrom: string | null; invoiceDateTo: string | null }) => void;
  className?: string;
}) {
  const value =
    from !== null && to !== null ? { start: parseDate(from), end: parseDate(to) } : null;
  return (
    <DateRangePicker
      aria-label="Invoice date"
      value={value}
      onChange={(range) =>
        onChange({
          invoiceDateFrom: range ? range.start.toString() : null,
          invoiceDateTo: range ? range.end.toString() : null,
        })
      }
      className={cn('w-60', className)}
    >
      <DateField.Group fullWidth>
        <DateField.Input slot="start">
          {(segment) => <DateField.Segment segment={segment} />}
        </DateField.Input>
        <DateRangePicker.RangeSeparator />
        <DateField.Input slot="end">
          {(segment) => <DateField.Segment segment={segment} />}
        </DateField.Input>
        <DateField.Suffix>
          <DateRangePicker.Trigger aria-label="Choose invoice dates">
            <DateRangePicker.TriggerIndicator />
          </DateRangePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      <DateRangePicker.Popover>
        <RangeCalendar aria-label="Invoice date">
          <RangeCalendar.Header>
            <RangeCalendar.YearPickerTrigger>
              <RangeCalendar.YearPickerTriggerHeading />
              <RangeCalendar.YearPickerTriggerIndicator />
            </RangeCalendar.YearPickerTrigger>
            <RangeCalendar.NavButton slot="previous" />
            <RangeCalendar.NavButton slot="next" />
          </RangeCalendar.Header>
          <RangeCalendar.Grid>
            <RangeCalendar.GridHeader>
              {(day) => <RangeCalendar.HeaderCell>{day}</RangeCalendar.HeaderCell>}
            </RangeCalendar.GridHeader>
            <RangeCalendar.GridBody>
              {(date) => <RangeCalendar.Cell date={date} />}
            </RangeCalendar.GridBody>
          </RangeCalendar.Grid>
          <RangeCalendar.YearPickerGrid>
            <RangeCalendar.YearPickerGridBody>
              {({ year }) => <RangeCalendar.YearPickerCell year={year} />}
            </RangeCalendar.YearPickerGridBody>
          </RangeCalendar.YearPickerGrid>
        </RangeCalendar>
      </DateRangePicker.Popover>
    </DateRangePicker>
  );
}

/** Vendor, category, currency and date: inline on wide screens, in a popover on narrow ones. */
function MoreFilters({
  filters,
  onChange,
  stacked,
}: {
  filters: ListFilters;
  onChange: SetFilters;
  stacked: boolean;
}) {
  const vendors = useVendors('');
  const vendorOptions = useMemo(
    () => (vendors.data ?? []).map((vendor) => ({ id: vendor.id, label: vendor.name })),
    [vendors.data],
  );
  const { options: currencyOptions, names } = currencies();
  const width = stacked ? 'w-full' : undefined;

  return (
    <>
      <FilterComboBox
        label="Vendor"
        placeholder="All vendors"
        options={vendorOptions}
        value={filters.vendorId}
        onChange={(vendorId) => onChange({ vendorId })}
        emptyText={vendors.isPending ? 'Loading…' : 'No vendor found'}
        className={width}
      />
      <CategorySelect
        value={filters.category}
        onChange={(category) => onChange({ category })}
        className={width}
      />
      <FilterComboBox
        label="Currency"
        placeholder="Any currency"
        options={currencyOptions}
        value={filters.currency}
        onChange={(currency) => onChange({ currency })}
        emptyText="No currency found"
        matches={(code, input) =>
          `${code} ${names.get(code) ?? ''}`.toLowerCase().includes(input.toLowerCase())
        }
        className={cn('w-32', width)}
      />
      <InvoiceDateRange
        from={filters.invoiceDateFrom}
        to={filters.invoiceDateTo}
        onChange={onChange}
        className={width}
      />
    </>
  );
}

function countMoreFilters(filters: ListFilters): number {
  return [
    filters.vendorId,
    filters.category,
    filters.currency,
    filters.invoiceDateFrom ?? filters.invoiceDateTo,
  ].filter((value) => value !== null).length;
}

/** Filters on one row: search, vendor, category, currency, invoice date range, errors only. */
export function InvoiceFilters({
  filters,
  onChange,
}: {
  filters: ListFilters;
  onChange: SetFilters;
}) {
  const onSearch = useCallback((q: string) => onChange({ q }, { replace: true }), [onChange]);
  const more = countMoreFilters(filters);

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-3" role="search">
      <SearchBox value={filters.q} onChange={onSearch} />

      <div className="hidden flex-wrap items-center gap-2 lg:flex">
        <MoreFilters filters={filters} onChange={onChange} stacked={false} />
      </div>
      <Popover>
        <Button variant="outline" className="lg:hidden">
          <SlidersHorizontal aria-hidden />
          {more > 0 ? `Filters (${String(more)})` : 'Filters'}
        </Button>
        <Popover.Content placement="bottom start" className="w-72">
          <Popover.Dialog aria-label="Filters" className="flex flex-col gap-3 p-3">
            <MoreFilters filters={filters} onChange={onChange} stacked />
          </Popover.Dialog>
        </Popover.Content>
      </Popover>

      <Switch
        isSelected={filters.hasErrors}
        onChange={(hasErrors) => onChange({ hasErrors })}
        className="ml-1"
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          Errors only
        </Switch.Content>
      </Switch>

      {/* Only reachable from Home's "couldn't be read" link; shown while it applies, to clear it. */}
      {filters.extraction === 'failed' && (
        <Switch
          isSelected
          onChange={(selected) => !selected && onChange({ extraction: null })}
          className="ml-1"
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            Couldn’t be read
          </Switch.Content>
        </Switch>
      )}

      {hasActiveFilters(filters) && (
        <Button variant="ghost" onPress={() => onChange(NO_FILTERS)}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

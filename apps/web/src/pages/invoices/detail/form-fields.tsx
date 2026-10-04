import {
  Calendar,
  DateField,
  DatePicker,
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  Select,
  TextArea,
  TextField,
  cn,
} from '@heroui/react';
import { type CalendarDate, parseDate } from '@internationalized/date';
import type { ReactNode } from 'react';
import { type Control, Controller, type FieldPathByValue } from 'react-hook-form';
import { fieldDomId } from './field-focus';
import type { InvoiceFormValues } from './form-model';

// The review form's inputs: react-hook-form controllers around HeroUI fields. Each field sits in
// a wrapper with a stable id (field-focus.ts), so an issue can scroll to it and focus it.

type FormControl = Control<InvoiceFormValues>;
type TextPath = FieldPathByValue<InvoiceFormValues, string>;

export function TextInputField({
  control,
  name,
  label,
  hint,
  mono,
  numeric,
  uppercase,
  placeholder,
  className,
}: {
  control: FormControl;
  name: TextPath;
  label: ReactNode;
  hint?: ReactNode;
  mono?: boolean;
  /** Amounts and day counts: tabular figures, a decimal keypad on phones. */
  numeric?: boolean;
  uppercase?: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <TextField
          id={fieldDomId(name)}
          name={field.name}
          value={field.value}
          onChange={field.onChange}
          onBlur={field.onBlur}
          isInvalid={fieldState.invalid}
          validationBehavior="aria"
          className={cn('flex min-w-0 flex-col gap-1.5', className)}
        >
          <Label>{label}</Label>
          <Input
            ref={field.ref}
            inputMode={numeric ? 'decimal' : undefined}
            spellCheck={mono || numeric ? false : undefined}
            placeholder={placeholder}
            className={cn(
              'w-full',
              mono && 'font-mono',
              numeric && 'tabular',
              uppercase && 'uppercase placeholder:normal-case',
            )}
          />
          {hint !== undefined && hint !== null && <Description>{hint}</Description>}
          <FieldError>{fieldState.error?.message}</FieldError>
        </TextField>
      )}
    />
  );
}

export function TextAreaField({
  control,
  name,
  label,
  hint,
  rows = 3,
  className,
}: {
  control: FormControl;
  name: TextPath;
  label: ReactNode;
  hint?: ReactNode;
  rows?: number;
  className?: string;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <TextField
          id={fieldDomId(name)}
          name={field.name}
          value={field.value}
          onChange={field.onChange}
          onBlur={field.onBlur}
          isInvalid={fieldState.invalid}
          validationBehavior="aria"
          className={cn('flex flex-col gap-1.5', className)}
        >
          <Label>{label}</Label>
          <TextArea ref={field.ref} rows={rows} className="w-full" />
          {hint !== undefined && hint !== null && <Description>{hint}</Description>}
          <FieldError>{fieldState.error?.message}</FieldError>
        </TextField>
      )}
    />
  );
}

export interface SelectOption {
  id: string;
  label: string;
}

export function SelectField({
  control,
  name,
  label,
  options,
  hint,
  placeholder = 'Choose…',
  className,
}: {
  control: FormControl;
  name: FieldPathByValue<InvoiceFormValues, string>;
  label: ReactNode;
  options: SelectOption[];
  hint?: ReactNode;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Select
          id={fieldDomId(name)}
          value={field.value === '' ? null : field.value}
          onChange={(key) => field.onChange(key === null ? '' : String(key))}
          onBlur={field.onBlur}
          isInvalid={fieldState.invalid}
          validationBehavior="aria"
          placeholder={placeholder}
          className={cn('flex min-w-0 flex-col gap-1.5', className)}
        >
          <Label>{label}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          {hint !== undefined && hint !== null && <Description>{hint}</Description>}
          <FieldError>{fieldState.error?.message}</FieldError>
          <Select.Popover>
            <ListBox items={options}>
              {(option) => (
                <ListBox.Item id={option.id} textValue={option.label}>
                  {option.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              )}
            </ListBox>
          </Select.Popover>
        </Select>
      )}
    />
  );
}

function toCalendarDate(value: string): CalendarDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  try {
    return parseDate(value);
  } catch {
    return null;
  }
}

/** The calendar inside a DatePicker's popover (same composition everywhere). */
export function CalendarPopover({ label }: { label: string }) {
  return (
    <DatePicker.Popover>
      <Calendar aria-label={label}>
        <Calendar.Header>
          <Calendar.YearPickerTrigger>
            <Calendar.YearPickerTriggerHeading />
            <Calendar.YearPickerTriggerIndicator />
          </Calendar.YearPickerTrigger>
          <Calendar.NavButton slot="previous" />
          <Calendar.NavButton slot="next" />
        </Calendar.Header>
        <Calendar.Grid>
          <Calendar.GridHeader>
            {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
          </Calendar.GridHeader>
          <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
        </Calendar.Grid>
        <Calendar.YearPickerGrid>
          <Calendar.YearPickerGridBody>
            {({ year }) => <Calendar.YearPickerCell year={year} />}
          </Calendar.YearPickerGridBody>
        </Calendar.YearPickerGrid>
      </Calendar>
    </DatePicker.Popover>
  );
}

/** A calendar date as 'YYYY-MM-DD' text ('' when empty), typed or picked. */
export function DateInput({
  id,
  label,
  value,
  onChange,
  onBlur,
  isInvalid,
  error,
  hint,
  maxValue,
  className,
}: {
  id?: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  isInvalid?: boolean;
  error?: string;
  hint?: ReactNode;
  /** 'YYYY-MM-DD'. */
  maxValue?: string;
  className?: string;
}) {
  const max = maxValue === undefined ? undefined : (toCalendarDate(maxValue) ?? undefined);
  return (
    <DatePicker
      id={id}
      value={toCalendarDate(value)}
      onChange={(date) => onChange(date === null ? '' : date.toString())}
      onBlur={onBlur}
      isInvalid={isInvalid}
      maxValue={max}
      validationBehavior="aria"
      className={cn('flex min-w-0 flex-col gap-1.5', className)}
    >
      <Label>{label}</Label>
      <DateField.Group fullWidth>
        <DateField.Input className="tabular">
          {(segment) => <DateField.Segment segment={segment} />}
        </DateField.Input>
        <DateField.Suffix>
          <DatePicker.Trigger>
            <DatePicker.TriggerIndicator />
          </DatePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      {hint !== undefined && hint !== null && <Description>{hint}</Description>}
      <FieldError>{error}</FieldError>
      <CalendarPopover label={typeof label === 'string' ? label : 'Date'} />
    </DatePicker>
  );
}

export function DateInputField({
  control,
  name,
  label,
  hint,
  className,
}: {
  control: FormControl;
  name: 'invoiceDate' | 'serviceDate' | 'dueDate';
  label: string;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <DateInput
          id={fieldDomId(name)}
          label={label}
          value={field.value}
          onChange={field.onChange}
          onBlur={field.onBlur}
          isInvalid={fieldState.invalid}
          error={fieldState.error?.message}
          hint={hint}
          className={className}
        />
      )}
    />
  );
}

/** "Extracted: 6,461.29 · Restore", under a field that differs from the model's reading. */
export function ExtractedHint({
  value,
  onRestore,
  mono,
}: {
  value: string;
  onRestore: () => void;
  mono?: boolean;
}) {
  return (
    <span className="text-xs text-muted">
      Extracted: <span className={cn('tabular', mono && 'font-mono')}>{value}</span> ·{' '}
      <button
        type="button"
        onClick={onRestore}
        className="rounded-control text-primary underline-offset-2 outline-none hover:underline focus-visible:focus-ring"
      >
        Restore
      </button>
    </span>
  );
}

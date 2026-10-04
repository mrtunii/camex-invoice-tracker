import { type InvoiceDetail, lineItemKindSchema } from '@camex/shared';
import { Button, FieldError, Input, ListBox, Select, TextField, cn } from '@heroui/react';
import { Plus, Trash2 } from 'lucide-react';
import { Controller, type UseFormReturn, useFieldArray, useWatch } from 'react-hook-form';
import { formatAmount, plural } from '@/lib/format';
import { LINE_KIND_LABELS } from '@/lib/invoice-labels';
import { lineTotals } from '@/lib/line-items';
import { fieldDomId } from './field-focus';
import { ExtractedHint } from './form-fields';
import {
  type InvoiceFormValues,
  emptyLine,
  readField,
  sameFieldValue,
  toFormValues,
} from './form-model';

const KIND_OPTIONS = lineItemKindSchema.options.map((id) => ({ id, label: LINE_KIND_LABELS[id] }));

type CellName =
  | `lineItems.${number}.description`
  | `lineItems.${number}.quantity`
  | `lineItems.${number}.uom`
  | `lineItems.${number}.unitPrice`
  | `lineItems.${number}.amount`;

function CellInput({
  form,
  name,
  label,
  numeric,
}: {
  form: UseFormReturn<InvoiceFormValues>;
  name: CellName;
  label: string;
  numeric?: boolean;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <TextField
          id={fieldDomId(name)}
          aria-label={label}
          value={field.value}
          onChange={field.onChange}
          onBlur={field.onBlur}
          isInvalid={fieldState.invalid}
          validationBehavior="aria"
          className="flex flex-col gap-1"
        >
          <Input
            ref={field.ref}
            inputMode={numeric ? 'decimal' : undefined}
            className={cn('w-full px-2', numeric && 'tabular text-end')}
          />
          <FieldError className="text-xs">{fieldState.error?.message}</FieldError>
        </TextField>
      )}
    />
  );
}

/** The live sum of the lines and its difference from the total (as TOTAL_MATH checks it). */
export function LineTotalsLine({ values }: { values: InvoiceFormValues }) {
  const currency = values.currency.trim() === '' ? null : values.currency.trim().toUpperCase();
  const totals = lineTotals(
    values.lineItems.map((line) => line.amount),
    values.totalAmount,
    values.taxAmount,
  );
  if (totals.lines === null) {
    return <p className="text-xs text-muted">No line amounts to add up.</p>;
  }
  return (
    <p className="tabular text-xs text-muted" aria-live="polite">
      Lines add up to {formatAmount(totals.lines, currency)}
      {totals.tax !== null && <> + tax {formatAmount(totals.tax, currency)}</>}
      {totals.total === null ? (
        ' · no total to compare'
      ) : (
        <>
          {' · '}Total {formatAmount(totals.total, currency)}
          {' · '}
          <span className={cn(totals.matches === false && 'font-medium text-danger')}>
            Difference {formatAmount(totals.difference, currency)}
          </span>
        </>
      )}
    </p>
  );
}

/** Editable rows (add, remove); empty rows are dropped on save. */
export function LineItemsEditor({
  form,
  invoice,
}: {
  form: UseFormReturn<InvoiceFormValues>;
  invoice: InvoiceDetail;
}) {
  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: 'lineItems',
  });
  const values = useWatch({ control: form.control }) as InvoiceFormValues;
  const { extracted } = invoice;
  const reading = readField('lineItems', values);
  const edited =
    extracted !== null &&
    (!reading.ok || !sameFieldValue('lineItems', reading.value, extracted.lineItems));

  return (
    <section
      aria-labelledby="section-line-items"
      className="space-y-3"
      id={fieldDomId('lineItems')}
    >
      <h3 id="section-line-items" className="text-base font-semibold">
        Line items
      </h3>
      {fields.length === 0 ? (
        <p className="text-muted">No lines. Add the invoice’s items, fees and taxes.</p>
      ) : (
        // Two rows per line, so the amounts stay in view in the narrow right pane: the description,
        // then kind, quantity, unit, unit price and amount.
        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full min-w-[26rem] table-fixed text-sm">
            {/* Fixed layout takes widths from here (the first row only spans): amounts get the room. */}
            <colgroup>
              <col className="w-[19%]" />
              <col className="w-[18%]" />
              <col className="w-[13%]" />
              <col className="w-[21%]" />
              <col />
              <col className="w-10" />
            </colgroup>
            <thead className="bg-surface-secondary text-left text-xs text-muted">
              <tr>
                <th colSpan={5} className="px-2 pt-2 font-medium">
                  Description
                </th>
                <th rowSpan={2} className="px-1">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
              <tr>
                <th className="px-2 pt-1 pb-2 font-medium">Kind</th>
                <th className="px-2 pt-1 pb-2 text-end font-medium">Quantity</th>
                <th className="px-2 pt-1 pb-2 font-medium">Unit</th>
                <th className="px-2 pt-1 pb-2 text-end font-medium">Unit price</th>
                <th className="px-2 pt-1 pb-2 text-end font-medium">Amount</th>
              </tr>
            </thead>
            {fields.map((row, index) => {
              const n = String(index + 1);
              return (
                <tbody key={row.id} className="border-t border-line">
                  <tr className="align-top">
                    <td colSpan={5} className="px-2 pt-2">
                      <CellInput
                        form={form}
                        name={`lineItems.${index}.description`}
                        label={`Line ${n} description`}
                      />
                    </td>
                    <td rowSpan={2} className="px-1 pt-2 align-top">
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove line ${n}`}
                        onPress={() => remove(index)}
                      >
                        <Trash2 className="text-muted" aria-hidden />
                      </Button>
                    </td>
                  </tr>
                  <tr className="align-top">
                    <td className="px-2 pt-1.5 pb-2">
                      <Controller
                        control={form.control}
                        name={`lineItems.${index}.kind`}
                        render={({ field }) => (
                          <Select
                            aria-label={`Line ${n} kind`}
                            value={field.value}
                            onChange={(key) => {
                              const parsed = lineItemKindSchema.safeParse(key);
                              if (parsed.success) field.onChange(parsed.data);
                            }}
                          >
                            <Select.Trigger>
                              <Select.Value />
                              <Select.Indicator />
                            </Select.Trigger>
                            <Select.Popover>
                              <ListBox items={KIND_OPTIONS}>
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
                    </td>
                    <td className="px-2 pt-1.5 pb-2">
                      <CellInput
                        form={form}
                        name={`lineItems.${index}.quantity`}
                        label={`Line ${n} quantity`}
                        numeric
                      />
                    </td>
                    <td className="px-2 pt-1.5 pb-2">
                      <CellInput
                        form={form}
                        name={`lineItems.${index}.uom`}
                        label={`Line ${n} unit`}
                      />
                    </td>
                    <td className="px-2 pt-1.5 pb-2">
                      <CellInput
                        form={form}
                        name={`lineItems.${index}.unitPrice`}
                        label={`Line ${n} unit price`}
                        numeric
                      />
                    </td>
                    <td className="px-2 pt-1.5 pb-2">
                      <CellInput
                        form={form}
                        name={`lineItems.${index}.amount`}
                        label={`Line ${n} amount`}
                        numeric
                      />
                    </td>
                  </tr>
                </tbody>
              );
            })}
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="space-y-1">
          <LineTotalsLine values={values} />
          {edited && (
            <ExtractedHint
              value={plural(extracted.lineItems.length, 'line', 'lines')}
              onRestore={() => replace(toFormValues(extracted).lineItems)}
            />
          )}
        </div>
        <Button size="sm" variant="outline" onPress={() => append(emptyLine())}>
          <Plus aria-hidden />
          Add line
        </Button>
      </div>
    </section>
  );
}

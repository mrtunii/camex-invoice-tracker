import { emailDomainSchema, vendorKey, vendorNameSchema } from '@camex/shared';
import { useState } from 'react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { TagInput } from '@/components/tag-input';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { VendorFormValues } from './vendor-form';

function aliasError(alias: string, current: string[], name: string): string | null {
  const parsed = vendorNameSchema.safeParse(alias);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Invalid alias';
  const key = vendorKey(alias);
  if (key === vendorKey(name)) return 'This is the vendor’s name already';
  if (current.some((existing) => vendorKey(existing) === key)) return 'Already an alias';
  return null;
}

function domainError(domain: string): string | null {
  const parsed = emailDomainSchema.safeParse(domain);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Invalid domain');
}

/** Name, aliases, domains and default terms; used by "Add vendor" and the vendor sheet. */
export function VendorFields({
  form,
  idPrefix,
}: {
  form: UseFormReturn<VendorFormValues>;
  idPrefix: string;
}) {
  const { errors } = form.formState;
  // Text typed into a tag input that can't be added yet (shown until it is fixed).
  const [aliasTyping, setAliasTyping] = useState<string | null>(null);
  const [domainTyping, setDomainTyping] = useState<string | null>(null);
  const id = (field: string) => `${idPrefix}-${field}`;

  return (
    <FieldGroup>
      <Field data-invalid={!!errors.name}>
        <FieldLabel htmlFor={id('name')}>Name</FieldLabel>
        <Input
          id={id('name')}
          autoComplete="off"
          aria-invalid={!!errors.name}
          {...form.register('name')}
        />
        <FieldError errors={[errors.name]} />
      </Field>

      <Field data-invalid={!!errors.aliases || aliasTyping !== null}>
        <FieldLabel htmlFor={id('aliases')}>Aliases</FieldLabel>
        <Controller
          control={form.control}
          name="aliases"
          render={({ field }) => (
            <TagInput
              id={id('aliases')}
              value={field.value}
              onChange={(next) => {
                field.onChange(next);
                form.clearErrors('aliases');
              }}
              onError={setAliasTyping}
              validate={(alias, current) => aliasError(alias, current, form.getValues('name'))}
              normalize={(raw) => raw.trim().replace(/\s+/g, ' ')}
              placeholder="Other names on their invoices; Enter to add"
              invalid={!!errors.aliases || aliasTyping !== null}
              aria-describedby={id('aliases-help')}
            />
          )}
        />
        <FieldDescription id={id('aliases-help')}>
          Case, punctuation and legal forms (LLC, Ltd, FZE…) are ignored when matching.
        </FieldDescription>
        <FieldError
          errors={[errors.aliases, aliasTyping === null ? undefined : { message: aliasTyping }]}
        />
      </Field>

      <Field data-invalid={!!errors.emailDomains || domainTyping !== null}>
        <FieldLabel htmlFor={id('domains')}>Email domains</FieldLabel>
        <Controller
          control={form.control}
          name="emailDomains"
          render={({ field }) => (
            <TagInput
              id={id('domains')}
              value={field.value}
              onChange={(next) => {
                field.onChange(next);
                form.clearErrors('emailDomains');
              }}
              onError={setDomainTyping}
              validate={domainError}
              normalize={(raw) => raw.trim().toLowerCase().replace(/^.*@/, '')}
              separators={[',', ' ']}
              placeholder="aegfuels.com"
              invalid={!!errors.emailDomains || domainTyping !== null}
              mono
              aria-describedby={id('domains-help')}
            />
          )}
        />
        <FieldDescription id={id('domains-help')}>
          Emailed invoices from these domains link to this vendor when the name doesn’t match.
        </FieldDescription>
        <FieldError
          errors={[
            errors.emailDomains,
            domainTyping === null ? undefined : { message: domainTyping },
          ]}
        />
      </Field>

      <Field data-invalid={!!errors.defaultPaymentTermsDays}>
        <FieldLabel htmlFor={id('terms')}>Default payment terms</FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            id={id('terms')}
            inputMode="numeric"
            autoComplete="off"
            className="w-20 font-mono tabular-nums"
            aria-invalid={!!errors.defaultPaymentTermsDays}
            aria-describedby={id('terms-help')}
            {...form.register('defaultPaymentTermsDays')}
          />
          <span className="text-muted-foreground">days</span>
        </div>
        <FieldDescription id={id('terms-help')}>
          Used when an invoice prints neither a due date nor terms.
        </FieldDescription>
        <FieldError errors={[errors.defaultPaymentTermsDays]} />
      </Field>
    </FieldGroup>
  );
}

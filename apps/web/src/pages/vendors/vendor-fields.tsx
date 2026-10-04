import { emailDomainSchema, vendorKey, vendorNameSchema } from '@camex/shared';
import { useState } from 'react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { FormTextField } from '@/components/form-text-field';
import { TagInput } from '@/components/tag-input';
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

/** Name, aliases, domains and default terms; used by "Add vendor" and the vendor drawer. */
export function VendorFields({ form }: { form: UseFormReturn<VendorFormValues> }) {
  const { errors } = form.formState;
  // Text typed into a tag input that can't be added yet (shown until it is fixed).
  const [aliasTyping, setAliasTyping] = useState<string | null>(null);
  const [domainTyping, setDomainTyping] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <FormTextField control={form.control} name="name" label="Name" autoComplete="off" />

      <Controller
        control={form.control}
        name="aliases"
        render={({ field }) => (
          <TagInput
            label="Aliases"
            addLabel="Add an alias"
            value={field.value}
            onChange={(next) => {
              field.onChange(next);
              form.clearErrors('aliases');
            }}
            onError={setAliasTyping}
            validate={(alias, current) => aliasError(alias, current, form.getValues('name'))}
            normalize={(raw) => raw.trim().replace(/\s+/g, ' ')}
            placeholder="Other names on their invoices; Enter to add"
            description="Case, punctuation and legal forms (LLC, Ltd, FZE…) are ignored when matching."
            error={aliasTyping ?? errors.aliases?.message ?? null}
          />
        )}
      />

      <Controller
        control={form.control}
        name="emailDomains"
        render={({ field }) => (
          <TagInput
            label="Email domains"
            addLabel="Add an email domain"
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
            description="Emailed invoices from these domains link to this vendor when the name doesn’t match."
            error={domainTyping ?? errors.emailDomains?.message ?? null}
          />
        )}
      />

      <FormTextField
        control={form.control}
        name="defaultPaymentTermsDays"
        label="Default payment terms"
        description="Used when an invoice prints neither a due date nor terms."
        inputMode="numeric"
        autoComplete="off"
        inputClassName="w-20 tabular"
        suffix={<span className="text-muted">days</span>}
      />
    </div>
  );
}

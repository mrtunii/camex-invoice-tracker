import {
  type CreateVendorRequest,
  MAX_DEFAULT_PAYMENT_TERMS_DAYS,
  type UpdateVendorRequest,
  type VendorDetail,
  vendorConflictSchema,
  vendorNameSchema,
} from '@camex/shared';
import type { UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import { ApiError } from '@/lib/api';

/** Form state: default terms stay text until submit ("" = none). */
export const vendorFormSchema = z.object({
  name: vendorNameSchema,
  aliases: z.array(z.string()),
  emailDomains: z.array(z.string()),
  defaultPaymentTermsDays: z
    .string()
    .trim()
    .regex(/^\d*$/, { error: 'Enter a whole number of days' })
    .refine((value) => value === '' || Number(value) <= MAX_DEFAULT_PAYMENT_TERMS_DAYS, {
      error: `Use 0 to ${MAX_DEFAULT_PAYMENT_TERMS_DAYS} days`,
    }),
});
export type VendorFormValues = z.infer<typeof vendorFormSchema>;

export const emptyVendorForm: VendorFormValues = {
  name: '',
  aliases: [],
  emailDomains: [],
  defaultPaymentTermsDays: '',
};

export function vendorFormValues(vendor: VendorDetail): VendorFormValues {
  return {
    name: vendor.name,
    aliases: vendor.aliases,
    emailDomains: vendor.emailDomains,
    defaultPaymentTermsDays:
      vendor.defaultPaymentTermsDays === null ? '' : String(vendor.defaultPaymentTermsDays),
  };
}

export function vendorRequest(values: VendorFormValues): Required<CreateVendorRequest> {
  const terms = values.defaultPaymentTermsDays.trim();
  return {
    name: values.name.trim(),
    aliases: values.aliases,
    emailDomains: values.emailDomains,
    defaultPaymentTermsDays: terms === '' ? null : Number(terms),
  };
}

const FIELDS = ['name', 'aliases', 'emailDomains', 'defaultPaymentTermsDays'] as const;

function sameRequestValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Only the fields that differ from the vendor as loaded, so a save doesn't overwrite what
 * someone else changed meanwhile (e.g. an alias added by linking an invoice).
 */
export function vendorChanges(values: VendorFormValues, vendor: VendorDetail): UpdateVendorRequest {
  const next = vendorRequest(values);
  const loaded = vendorRequest(vendorFormValues(vendor));
  return Object.fromEntries(
    FIELDS.filter((field) => !sameRequestValue(next[field], loaded[field])).map((field) => [
      field,
      next[field],
    ]),
  );
}

function fieldOf(path: string): (typeof FIELDS)[number] | undefined {
  return FIELDS.find((field) => field === path.split('.')[0]);
}

/**
 * Shows a 409 (name, alias or domain taken by another vendor) or a 400 inline on its field.
 * Returns false when the error isn't about a field, so the caller can toast it.
 */
export function showVendorFieldErrors(
  form: UseFormReturn<VendorFormValues>,
  error: unknown,
): boolean {
  if (!(error instanceof ApiError)) return false;
  const conflict = vendorConflictSchema.safeParse(error.body);
  if (conflict.success) {
    const field = fieldOf(conflict.data.field);
    if (field) form.setError(field, { message: conflict.data.message });
    return field !== undefined;
  }
  const issues = z
    .object({ issues: z.array(z.object({ path: z.string(), message: z.string() })) })
    .safeParse(error.body);
  if (error.status !== 400 || !issues.success) return false;
  let shown = false;
  for (const issue of issues.data.issues) {
    const field = fieldOf(issue.path);
    if (field) {
      form.setError(field, { message: issue.message });
      shown = true;
    }
  }
  return shown;
}

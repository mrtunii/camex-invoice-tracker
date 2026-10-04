import { z } from 'zod';
import { isoTimestampSchema, namedRefSchema, uuidSchema } from './common.js';
import { invoiceVersionSchema } from './invoice-workflow.js';
import { vendorKey } from './keys.js';

/** Free mailbox providers: anyone can send from them, so they never identify a vendor. */
export const PUBLIC_MAILBOX_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'mail.ru',
  'yandex.ru',
  'proton.me',
];

export const MAX_DEFAULT_PAYMENT_TERMS_DAYS = 365;

/** A vendor name or alias. Its vendorKey must keep something besides the legal form. */
export const vendorNameSchema = z
  .string()
  .trim()
  .min(1, { error: 'Enter a name', abort: true })
  .max(200, { error: 'Use at most 200 characters', abort: true })
  .refine((name) => vendorKey(name) !== '', {
    error: 'Enter more than a legal form like "LLC"',
  });

/** Lowercase DNS name with at least two labels (aegfuels.com, mail.petrocas.ge). */
export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    {
      error: 'Enter a domain like aegfuels.com',
    },
  );

/** A vendor's sender domain. Camex's own domains are rejected by the API (they are config). */
export const emailDomainSchema = hostnameSchema.refine(
  (domain) => !PUBLIC_MAILBOX_DOMAINS.includes(domain),
  { error: "A public mailbox domain can't identify a vendor" },
);

export const defaultPaymentTermsDaysSchema = z
  .number({ error: 'Enter a whole number of days' })
  .int({ error: 'Enter a whole number of days' })
  .min(0, { error: 'Use 0 to 365 days' })
  .max(MAX_DEFAULT_PAYMENT_TERMS_DAYS, { error: 'Use 0 to 365 days' })
  .nullable();

const vendorFields = {
  name: vendorNameSchema,
  aliases: z.array(vendorNameSchema).max(50, { error: 'Use at most 50 aliases' }),
  emailDomains: z.array(emailDomainSchema).max(20, { error: 'Use at most 20 domains' }),
  defaultPaymentTermsDays: defaultPaymentTermsDaysSchema,
};

/** POST /api/vendors. Aliases or domains repeated within the vendor are dropped. */
export const createVendorRequestSchema = z.strictObject({
  name: vendorFields.name,
  aliases: vendorFields.aliases.optional(),
  emailDomains: vendorFields.emailDomains.optional(),
  defaultPaymentTermsDays: vendorFields.defaultPaymentTermsDays.optional(),
});
export type CreateVendorRequest = z.infer<typeof createVendorRequestSchema>;

/** PATCH /api/vendors/:id: the same fields, each optional. */
export const updateVendorRequestSchema = z
  .strictObject({
    name: vendorFields.name.optional(),
    aliases: vendorFields.aliases.optional(),
    emailDomains: vendorFields.emailDomains.optional(),
    defaultPaymentTermsDays: vendorFields.defaultPaymentTermsDays.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { error: 'Nothing to update' });
export type UpdateVendorRequest = z.infer<typeof updateVendorRequestSchema>;

export const vendorListQuerySchema = z.object({
  /** Case-insensitive; matches the name, an alias or a domain. */
  search: z.string().trim().max(200).optional(),
});
export type VendorListQuery = z.infer<typeof vendorListQuerySchema>;

export const vendorSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  aliases: z.array(z.string()),
  emailDomains: z.array(z.string()),
  defaultPaymentTermsDays: z.number().int().nullable(),
  activeBankAccountCount: z.number().int().nonnegative(),
  /** needs_review + unpaid. */
  openInvoiceCount: z.number().int().nonnegative(),
});
export type VendorSummary = z.infer<typeof vendorSummarySchema>;

export const vendorListResponseSchema = z.object({ vendors: z.array(vendorSummarySchema) });
export type VendorListResponse = z.infer<typeof vendorListResponseSchema>;

/**
 * A trusted bank account (SPEC §9). Added only from an invoice; removal is soft, so removed
 * accounts stay as the audit trail and are ignored by matching.
 */
export const vendorBankAccountSchema = z.object({
  id: uuidSchema,
  beneficiary: z.string().nullable(),
  bankName: z.string().nullable(),
  iban: z.string().nullable(),
  accountNumber: z.string().nullable(),
  swift: z.string().nullable(),
  routingNumber: z.string().nullable(),
  currency: z.string().nullable(),
  addedAt: isoTimestampSchema,
  addedBy: namedRefSchema.nullable(),
  sourceInvoiceId: uuidSchema.nullable(),
  removedAt: isoTimestampSchema.nullable(),
  removedBy: namedRefSchema.nullable(),
});
export type VendorBankAccount = z.infer<typeof vendorBankAccountSchema>;

/** GET /api/vendors/:id: the list fields plus every bank account, active and removed. */
export const vendorDetailSchema = vendorSummarySchema.extend({
  bankAccounts: z.array(vendorBankAccountSchema),
});
export type VendorDetail = z.infer<typeof vendorDetailSchema>;

/**
 * 409 body when a name, alias or domain is already used by another vendor. `field` is the
 * request path it is about (`name`, `aliases.2`, `emailDomains.0`, `create.name`, `vendorName`).
 */
export const vendorConflictSchema = z.object({
  statusCode: z.literal(409),
  message: z.string(),
  field: z.string(),
  vendor: namedRefSchema,
});
export type VendorConflict = z.infer<typeof vendorConflictSchema>;

/**
 * POST /api/invoices/:id/vendor: link an existing vendor, or create one and link it. A human
 * write on the invoice, so it carries the invoice's `version` (T06) and increments it.
 */
export const linkInvoiceVendorRequestSchema = z.union([
  z.strictObject({ version: invoiceVersionSchema, vendorId: uuidSchema }),
  z.strictObject({
    version: invoiceVersionSchema,
    create: z.strictObject({
      name: vendorNameSchema,
      defaultPaymentTermsDays: defaultPaymentTermsDaysSchema.optional(),
    }),
  }),
]);
export type LinkInvoiceVendorRequest = z.infer<typeof linkInvoiceVendorRequestSchema>;

/**
 * POST /api/invoices/:id/trust-bank-details: `version` makes sure the details trusted are the
 * ones the person looked at (an edit in between is 409 STALE). It increments the version too.
 */
export const trustBankDetailsRequestSchema = z.strictObject({ version: invoiceVersionSchema });
export type TrustBankDetailsRequest = z.infer<typeof trustBankDetailsRequestSchema>;

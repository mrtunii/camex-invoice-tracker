import { z } from 'zod';

/** Emails are compared and stored lowercase (SPEC §5 users.email). */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ error: 'Enter a valid email address' }));

export const uuidSchema = z.uuid();

/** ISO-8601 timestamp as serialized in JSON (e.g. created_at). */
export const isoTimestampSchema = z.iso.datetime({ offset: true });

/** Another record, by id and display name (a vendor, the user who did something). */
export const namedRefSchema = z.object({ id: uuidSchema, name: z.string() });
export type NamedRef = z.infer<typeof namedRefSchema>;

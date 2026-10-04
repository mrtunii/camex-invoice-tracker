import { z } from 'zod';
import { newPasswordSchema } from './auth.js';
import { emailSchema, isoTimestampSchema, uuidSchema } from './common.js';

export const userNameSchema = z.string().trim().min(1, { error: 'Enter a name' }).max(200);

export const userSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  lastLoginAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
});
export type User = z.infer<typeof userSchema>;

export const userListResponseSchema = z.object({ users: z.array(userSchema) });
export type UserListResponse = z.infer<typeof userListResponseSchema>;

export const createUserRequestSchema = z.object({
  email: emailSchema,
  name: userNameSchema,
  password: newPasswordSchema,
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    name: userNameSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.isActive !== undefined, {
    error: 'Nothing to update',
  });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const userIdParamSchema = uuidSchema;

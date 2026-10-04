import { z } from 'zod';
import { emailSchema, uuidSchema } from './common.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Rules for any password a user sets (new users, change-password, create-admin CLI). */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { error: `Use at least ${PASSWORD_MIN_LENGTH} characters` })
  .max(PASSWORD_MAX_LENGTH, { error: `Use at most ${PASSWORD_MAX_LENGTH} characters` });

export const loginRequestSchema = z.object({
  email: emailSchema,
  // Not checked against the policy on login: only bounded so hashing can't be abused.
  password: z.string().min(1, { error: 'Enter your password' }).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z
    .string()
    .min(1, { error: 'Enter your current password' })
    .max(PASSWORD_MAX_LENGTH),
  newPassword: newPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const authUserSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  name: z.string(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const authResponseSchema = z.object({ user: authUserSchema });
export type AuthResponse = z.infer<typeof authResponseSchema>;

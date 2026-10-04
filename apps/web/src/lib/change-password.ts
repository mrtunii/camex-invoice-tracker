import { changePasswordRequestSchema } from '@camex/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError, apiNoContent } from './api';

const formSchema = changePasswordRequestSchema
  .extend({ confirmPassword: z.string() })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    error: "Passwords don't match",
  });
export type ChangePasswordValues = z.infer<typeof formSchema>;

/** Form state + mutation for POST /auth/change-password (dialog and forced screen). */
export function useChangePasswordForm(onChanged: () => void) {
  const form = useForm<ChangePasswordValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const mutation = useMutation({
    mutationFn: ({ currentPassword, newPassword }: ChangePasswordValues) =>
      apiNoContent('/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      }),
    onSuccess: () => {
      form.reset();
      onChanged();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 400) {
        form.setError('currentPassword', { message: error.message });
      } else {
        toast.error(error.message);
      }
    },
  });

  return {
    form,
    pending: mutation.isPending,
    onSubmit: form.handleSubmit((values) => mutation.mutate(values)),
  };
}

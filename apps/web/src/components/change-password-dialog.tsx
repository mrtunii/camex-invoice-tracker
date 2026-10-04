import { changePasswordRequestSchema } from '@camex/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ApiError, apiNoContent } from '@/lib/api';

const formSchema = changePasswordRequestSchema
  .extend({ confirmPassword: z.string() })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    error: "Passwords don't match",
  });
type FormValues = z.infer<typeof formSchema>;

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });
  const { errors } = form.formState;

  const changePassword = useMutation({
    mutationFn: ({ currentPassword, newPassword }: FormValues) =>
      apiNoContent('/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      }),
    onSuccess: () => {
      toast.success('Password changed. Your other sessions were signed out.');
      handleOpenChange(false);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 400) {
        form.setError('currentPassword', { message: error.message });
      } else {
        toast.error(error.message);
      }
    },
  });

  function handleOpenChange(next: boolean) {
    if (!next) form.reset();
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form noValidate onSubmit={form.handleSubmit((values) => changePassword.mutate(values))}>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              You stay signed in here; other sessions are signed out.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="py-4">
            <Field data-invalid={!!errors.currentPassword}>
              <FieldLabel htmlFor="current-password">Current password</FieldLabel>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                aria-invalid={!!errors.currentPassword}
                {...form.register('currentPassword')}
              />
              <FieldError errors={[errors.currentPassword]} />
            </Field>
            <Field data-invalid={!!errors.newPassword}>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                aria-invalid={!!errors.newPassword}
                {...form.register('newPassword')}
              />
              <FieldError errors={[errors.newPassword]} />
            </Field>
            <Field data-invalid={!!errors.confirmPassword}>
              <FieldLabel htmlFor="confirm-password">Repeat new password</FieldLabel>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                aria-invalid={!!errors.confirmPassword}
                {...form.register('confirmPassword')}
              />
              <FieldError errors={[errors.confirmPassword]} />
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={changePassword.isPending}>
              {changePassword.isPending ? 'Changing…' : 'Change password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

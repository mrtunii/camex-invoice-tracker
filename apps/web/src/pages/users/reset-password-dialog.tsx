import { type ResetPasswordRequest, type User, resetPasswordRequestSchema } from '@camex/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useResetPassword } from './users-query';

/** Admin sets a temporary password for another user (SPEC §11). */
export function ResetPasswordDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const resetPassword = useResetPassword();
  const form = useForm<ResetPasswordRequest>({
    resolver: zodResolver(resetPasswordRequestSchema),
    defaultValues: { newPassword: '' },
  });
  const { errors } = form.formState;

  function close() {
    form.reset();
    onClose();
  }

  const onSubmit = form.handleSubmit((values) => {
    if (!user) return;
    resetPassword.mutate(
      { id: user.id, ...values },
      {
        onSuccess: () => {
          toast.success(`Temporary password set for ${user.name}`);
          close();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  });

  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <form noValidate onSubmit={(e) => void onSubmit(e)}>
          <DialogHeader>
            <DialogTitle>Reset password for {user?.name}?</DialogTitle>
            <DialogDescription>
              They are signed out everywhere right away and must choose a new password the next time
              they sign in.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="py-4">
            <Field data-invalid={!!errors.newPassword}>
              <FieldLabel htmlFor="reset-password">Temporary password</FieldLabel>
              <Input
                id="reset-password"
                className="font-mono"
                autoComplete="new-password"
                spellCheck={false}
                aria-invalid={!!errors.newPassword}
                {...form.register('newPassword')}
              />
              <FieldDescription>Share it with them directly, not by email.</FieldDescription>
              <FieldError errors={[errors.newPassword]} />
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={resetPassword.isPending}>
              {resetPassword.isPending ? 'Resetting…' : 'Reset password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

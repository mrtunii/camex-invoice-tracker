import { type ResetPasswordRequest, type User, resetPasswordRequestSchema } from '@camex/shared';
import { Button, Form, Modal, toast } from '@heroui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { FormTextField } from '@/components/form-text-field';
import { useResetPassword } from './users-query';

/** Admin sets a temporary password for another user (SPEC §11). */
export function ResetPasswordDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const resetPassword = useResetPassword();
  const form = useForm<ResetPasswordRequest>({
    resolver: zodResolver(resetPasswordRequestSchema),
    defaultValues: { newPassword: '' },
  });

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
        onError: (error) => toast.danger(error.message),
      },
    );
  });

  return (
    <Modal.Backdrop isOpen={user !== null} onOpenChange={(open) => !open && close()}>
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Form validationBehavior="aria" onSubmit={(e) => void onSubmit(e)}>
            <Modal.Header>
              <Modal.Heading>Reset password for {user?.name}?</Modal.Heading>
              <p className="text-muted">
                They are signed out everywhere right away and must choose a new password the next
                time they sign in.
              </p>
            </Modal.Header>
            <Modal.Body className="py-4">
              <FormTextField
                control={form.control}
                name="newPassword"
                label="Temporary password"
                autoComplete="new-password"
                mono
                description="Share it with them directly, not by email."
              />
            </Modal.Body>
            <Modal.Footer>
              <Button type="button" variant="ghost" onPress={close}>
                Cancel
              </Button>
              <Button type="submit" isPending={resetPassword.isPending}>
                {resetPassword.isPending ? 'Resetting…' : 'Reset password'}
              </Button>
            </Modal.Footer>
          </Form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

import { Button, Form, Modal, toast } from '@heroui/react';
import { ChangePasswordFields } from '@/components/change-password-form';
import { useChangePasswordForm } from '@/lib/change-password';

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { form, pending, onSubmit } = useChangePasswordForm(() => {
    toast.success('Password changed. Your other sessions were signed out.');
    onOpenChange(false);
  });

  function handleOpenChange(next: boolean) {
    if (!next) form.reset();
    onOpenChange(next);
  }

  return (
    <Modal.Backdrop isOpen={open} onOpenChange={handleOpenChange}>
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Form validationBehavior="aria" onSubmit={(e) => void onSubmit(e)}>
            <Modal.Header>
              <Modal.Heading>Change password</Modal.Heading>
              <p className="text-muted">You stay signed in here; other sessions are signed out.</p>
            </Modal.Header>
            <Modal.Body className="py-4">
              <ChangePasswordFields form={form} />
            </Modal.Body>
            <Modal.Footer>
              <Button type="button" variant="ghost" onPress={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" isPending={pending}>
                {pending ? 'Changing…' : 'Change password'}
              </Button>
            </Modal.Footer>
          </Form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

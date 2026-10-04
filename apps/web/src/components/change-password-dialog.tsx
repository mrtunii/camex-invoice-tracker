import { toast } from 'sonner';
import { ChangePasswordFields } from '@/components/change-password-form';
import { useChangePasswordForm } from '@/lib/change-password';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form noValidate onSubmit={(e) => void onSubmit(e)}>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              You stay signed in here; other sessions are signed out.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <ChangePasswordFields form={form} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Changing…' : 'Change password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

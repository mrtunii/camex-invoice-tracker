import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { useState } from 'react';
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
  DialogTrigger,
} from '@/components/ui/dialog';
import { VendorFields } from './vendor-fields';
import {
  type VendorFormValues,
  emptyVendorForm,
  showVendorFieldErrors,
  vendorFormSchema,
  vendorRequest,
} from './vendor-form';
import { useCreateVendor } from './vendors-query';

export function AddVendorDialog() {
  const [open, setOpen] = useState(false);
  const form = useForm<VendorFormValues>({
    resolver: zodResolver(vendorFormSchema),
    defaultValues: emptyVendorForm,
  });
  const createVendor = useCreateVendor();

  function handleOpenChange(next: boolean) {
    if (!next) form.reset(emptyVendorForm);
    setOpen(next);
  }

  function submit(values: VendorFormValues) {
    createVendor.mutate(vendorRequest(values), {
      onSuccess: (vendor) => {
        toast.success(
          vendor.openInvoiceCount > 0
            ? `Added ${vendor.name} and linked ${vendor.openInvoiceCount} invoice${vendor.openInvoiceCount === 1 ? '' : 's'}`
            : `Added ${vendor.name}`,
        );
        handleOpenChange(false);
      },
      onError: (error) => {
        if (!showVendorFieldErrors(form, error)) toast.error(error.message);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          Add vendor
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form noValidate onSubmit={form.handleSubmit(submit)}>
          <DialogHeader>
            <DialogTitle>Add vendor</DialogTitle>
            <DialogDescription>
              Invoices waiting for review are matched against the name, aliases and domains as soon
              as you save.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <VendorFields form={form} idPrefix="new-vendor" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createVendor.isPending}>
              {createVendor.isPending ? 'Adding…' : 'Add vendor'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

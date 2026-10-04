import { Button, Form, Modal, toast } from '@heroui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { plural } from '@/lib/format';
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
            ? `Added ${vendor.name} and linked ${plural(vendor.openInvoiceCount, 'invoice', 'invoices')}`
            : `Added ${vendor.name}`,
        );
        handleOpenChange(false);
      },
      onError: (error) => {
        if (!showVendorFieldErrors(form, error)) toast.danger(error.message);
      },
    });
  }

  return (
    <>
      <Button onPress={() => setOpen(true)}>
        <Plus aria-hidden />
        Add vendor
      </Button>
      <Modal.Backdrop isOpen={open} onOpenChange={handleOpenChange}>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Form validationBehavior="aria" onSubmit={(e) => void form.handleSubmit(submit)(e)}>
              <Modal.Header>
                <Modal.Heading>Add vendor</Modal.Heading>
                <p className="text-muted">
                  Invoices waiting for review are matched against the name, aliases and domains as
                  soon as you save.
                </p>
              </Modal.Header>
              <Modal.Body className="py-4">
                <VendorFields form={form} />
              </Modal.Body>
              <Modal.Footer>
                <Button type="button" variant="ghost" onPress={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" isPending={createVendor.isPending}>
                  {createVendor.isPending ? 'Adding…' : 'Add vendor'}
                </Button>
              </Modal.Footer>
            </Form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}

import type { VendorBankAccount, VendorDetail } from '@camex/shared';
import { AlertDialog, Button, Drawer, Form, Link, cn, toast } from '@heroui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { type ReactNode, useState } from 'react';
import { useForm } from 'react-hook-form';
import { formatTimestamp, plural } from '@/lib/format';
import { VendorFields } from './vendor-fields';
import {
  type VendorFormValues,
  showVendorFieldErrors,
  vendorChanges,
  vendorFormSchema,
  vendorFormValues,
} from './vendor-form';
import { useRemoveBankAccount, useUpdateVendor, useVendor } from './vendors-query';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function EditVendorForm({ vendor }: { vendor: VendorDetail }) {
  const form = useForm<VendorFormValues>({
    resolver: zodResolver(vendorFormSchema),
    // Follows the server copy (refetches after saves), keeping unsaved edits.
    values: vendorFormValues(vendor),
    resetOptions: { keepDirtyValues: true },
  });
  // reset() inherits resetOptions, so explicit resets must drop the edits themselves.
  const resetTo = (values: VendorFormValues) => form.reset(values, { keepDirtyValues: false });
  const updateVendor = useUpdateVendor(vendor.id);

  function submit(values: VendorFormValues) {
    const changes = vendorChanges(values, vendor);
    if (Object.keys(changes).length === 0) {
      resetTo(vendorFormValues(vendor));
      return;
    }
    updateVendor.mutate(changes, {
      onSuccess: (saved) => {
        resetTo(vendorFormValues(saved));
        toast.success(`Saved ${saved.name}`);
      },
      onError: (error) => {
        if (!showVendorFieldErrors(form, error)) toast.danger(error.message);
      },
    });
  }

  const dirty = form.formState.isDirty;
  return (
    <Form
      validationBehavior="aria"
      onSubmit={(e) => void form.handleSubmit(submit)(e)}
      className="flex flex-col gap-5"
    >
      <VendorFields form={form} />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          isDisabled={!dirty || updateVendor.isPending}
          onPress={() => resetTo(vendorFormValues(vendor))}
        >
          Discard
        </Button>
        <Button type="submit" isDisabled={!dirty} isPending={updateVendor.isPending}>
          {updateVendor.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </Form>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-mono break-all">{children ?? '—'}</dd>
    </div>
  );
}

/** One trusted account, numbers in full (they are what a payer checks against), in mono. */
function BankAccount({
  account,
  onRemove,
}: {
  account: VendorBankAccount;
  onRemove?: (account: VendorBankAccount) => void;
}) {
  const removed = account.removedAt !== null;
  return (
    <article
      className={cn(
        'space-y-3 rounded-panel border border-line p-4',
        removed ? 'text-muted' : 'bg-surface',
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{account.beneficiary ?? 'Beneficiary not printed'}</p>
          <p className="text-muted">{account.bankName ?? 'Bank not printed'}</p>
        </div>
        {onRemove && (
          <Button size="sm" variant="ghost" onPress={() => onRemove(account)}>
            Remove
          </Button>
        )}
      </header>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <div className="col-span-2">
          {account.iban !== null ? (
            <Detail label="IBAN">{account.iban}</Detail>
          ) : (
            <Detail label="Account number">{account.accountNumber}</Detail>
          )}
        </div>
        <Detail label="SWIFT / BIC">{account.swift}</Detail>
        <Detail label="Currency">{account.currency}</Detail>
        {account.iban !== null && account.accountNumber !== null && (
          <Detail label="Account number">{account.accountNumber}</Detail>
        )}
        {account.routingNumber !== null && (
          <Detail label="Routing / sort code">{account.routingNumber}</Detail>
        )}
      </dl>
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-xs text-muted">
        <span>
          Trusted by {account.addedBy?.name ?? 'unknown'} · {formatTimestamp(account.addedAt)}
        </span>
        {account.sourceInvoiceId !== null && (
          <Link href={`/invoices/${account.sourceInvoiceId}`} className="text-xs text-primary">
            From invoice
          </Link>
        )}
        {removed && (
          <span className="basis-full">
            Removed by {account.removedBy?.name ?? 'unknown'} · {formatTimestamp(account.removedAt)}
          </span>
        )}
      </footer>
    </article>
  );
}

function RemoveAccountDialog({
  vendor,
  account,
  onClose,
}: {
  vendor: VendorDetail;
  account: VendorBankAccount | null;
  onClose: () => void;
}) {
  const removeAccount = useRemoveBankAccount(vendor.id);

  function remove() {
    if (!account) return;
    removeAccount.mutate(account.id, {
      onSuccess: () => {
        toast.success('Account removed from the trusted list');
        onClose();
      },
      onError: (error) => toast.danger(error.message),
    });
  }

  return (
    <AlertDialog.Backdrop isOpen={account !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Heading>Remove this trusted account?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p>
              Open invoices from {vendor.name} that pay into{' '}
              <span className="font-mono">{account?.iban ?? account?.accountNumber}</span> will be
              flagged again until someone trusts the details from an invoice. The account stays in
              the removed list.
            </p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="ghost" onPress={onClose}>
              Cancel
            </Button>
            <Button variant="danger" onPress={remove} isPending={removeAccount.isPending}>
              {removeAccount.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function VendorBody({ vendor }: { vendor: VendorDetail }) {
  const [removing, setRemoving] = useState<VendorBankAccount | null>(null);
  const active = vendor.bankAccounts.filter((a) => a.removedAt === null);
  const removed = vendor.bankAccounts.filter((a) => a.removedAt !== null);

  return (
    <div className="space-y-8">
      <Section title="Details">
        <EditVendorForm vendor={vendor} />
      </Section>

      <Section title="Trusted bank accounts">
        {active.length === 0 ? (
          <p className="text-muted">
            None yet. Accounts are added by trusting the bank details on one of this vendor’s
            invoices; until then its invoices ask you to check the bank details.
          </p>
        ) : (
          <div className="space-y-2">
            {active.map((account) => (
              <BankAccount key={account.id} account={account} onRemove={setRemoving} />
            ))}
          </div>
        )}
        {removed.length > 0 && (
          <details>
            <summary className="cursor-pointer rounded-control text-muted outline-none hover:text-foreground focus-visible:focus-ring">
              Removed accounts ({removed.length})
            </summary>
            <div className="mt-2 space-y-2">
              {removed.map((account) => (
                <BankAccount key={account.id} account={account} />
              ))}
            </div>
          </details>
        )}
      </Section>

      <RemoveAccountDialog vendor={vendor} account={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}

/** A vendor: edit form, trusted accounts, removed accounts. */
export function VendorDrawer({
  vendorId,
  onClose,
}: {
  vendorId: string | null;
  onClose: () => void;
}) {
  const vendor = useVendor(vendorId);
  const data = vendor.data;

  return (
    <Drawer.Backdrop isOpen={vendorId !== null} onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content placement="right">
        {/* Width on the dialog: Drawer.Content is the full-screen layer that places it. */}
        <Drawer.Dialog className="h-full sm:w-[34rem]">
          <Drawer.CloseTrigger />
          <Drawer.Header className="mb-4">
            <Drawer.Heading>{data?.name ?? 'Vendor'}</Drawer.Heading>
            <p className="text-muted">
              {data
                ? `${plural(data.openInvoiceCount, 'open invoice', 'open invoices')} · ${plural(data.activeBankAccountCount, 'trusted account', 'trusted accounts')}`
                : vendor.isError
                  ? vendor.error.message
                  : 'Loading…'}
            </p>
          </Drawer.Header>
          <Drawer.Body>{data && <VendorBody key={data.id} vendor={data} />}</Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

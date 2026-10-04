import type { VendorBankAccount, VendorDetail } from '@camex/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowUpRight, Landmark } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';
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
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
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
        if (!showVendorFieldErrors(form, error)) toast.error(error.message);
      },
    });
  }

  return (
    <form noValidate onSubmit={form.handleSubmit(submit)} className="space-y-4">
      <VendorFields form={form} idPrefix={`vendor-${vendor.id}`} />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={!form.formState.isDirty || updateVendor.isPending}
          onClick={() => resetTo(vendorFormValues(vendor))}
        >
          Discard
        </Button>
        <Button type="submit" disabled={!form.formState.isDirty || updateVendor.isPending}>
          {updateVendor.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

function Detail({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('break-all', mono && 'font-mono text-[0.8125rem]')}>{children ?? '—'}</dd>
    </div>
  );
}

/** One trusted account, numbers in full (they are what a payer checks against). */
function BankAccountCard({
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
        'space-y-3 rounded-lg border border-border bg-card p-3',
        removed && 'bg-muted/40 text-muted-foreground',
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn('font-medium', !removed && 'text-foreground')}>
            {account.beneficiary ?? 'Beneficiary not printed'}
          </p>
          <p className="text-muted-foreground">{account.bankName ?? 'Bank not printed'}</p>
        </div>
        {onRemove && (
          <Button variant="ghost" size="sm" onClick={() => onRemove(account)}>
            Remove
          </Button>
        )}
      </header>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <div className="col-span-2">
          {account.iban !== null ? (
            <Detail label="IBAN" mono>
              {account.iban}
            </Detail>
          ) : (
            <Detail label="Account number" mono>
              {account.accountNumber}
            </Detail>
          )}
        </div>
        <Detail label="SWIFT / BIC" mono>
          {account.swift}
        </Detail>
        <Detail label="Currency" mono>
          {account.currency}
        </Detail>
        {account.iban !== null && account.accountNumber !== null && (
          <Detail label="Account number" mono>
            {account.accountNumber}
          </Detail>
        )}
        {account.routingNumber !== null && (
          <Detail label="Routing / sort code" mono>
            {account.routingNumber}
          </Detail>
        )}
      </dl>
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
        <span>
          Trusted by {account.addedBy?.name ?? 'unknown'} · {formatTimestamp(account.addedAt)}
        </span>
        {account.sourceInvoiceId !== null && (
          <Link
            to={`/invoices/${account.sourceInvoiceId}`}
            className="inline-flex items-center gap-0.5 font-medium text-ring hover:underline focus-visible:underline focus-visible:outline-none"
          >
            From invoice
            <ArrowUpRight className="size-3" aria-hidden />
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
      onError: (error) => toast.error(error.message),
    });
  }

  return (
    <Dialog open={account !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove this trusted account?</DialogTitle>
          <DialogDescription>
            Open invoices from {vendor.name} that pay into{' '}
            <span className="font-mono">{account?.iban ?? account?.accountNumber}</span> will be
            flagged again until someone trusts the details from an invoice. The account stays in the
            removed list.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={remove} disabled={removeAccount.isPending}>
            {removeAccount.isPending ? 'Removing…' : 'Remove'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VendorBody({ vendor }: { vendor: VendorDetail }) {
  const [removing, setRemoving] = useState<VendorBankAccount | null>(null);
  const active = vendor.bankAccounts.filter((a) => a.removedAt === null);
  const removed = vendor.bankAccounts.filter((a) => a.removedAt !== null);

  return (
    <div className="space-y-8 p-4">
      <Section title="Details">
        <EditVendorForm vendor={vendor} />
      </Section>

      <Section title={`Trusted bank accounts (${active.length})`}>
        {active.length === 0 ? (
          <div className="flex gap-3 rounded-lg border border-dashed border-border p-4 text-muted-foreground">
            <Landmark className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              None yet. Accounts are added by trusting the bank details on one of this vendor’s
              invoices; until then its invoices are flagged “first bank details seen”.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {active.map((account) => (
              <BankAccountCard key={account.id} account={account} onRemove={setRemoving} />
            ))}
          </div>
        )}
        {removed.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
              Removed accounts ({removed.length})
            </summary>
            <div className="mt-2 space-y-2">
              {removed.map((account) => (
                <BankAccountCard key={account.id} account={account} />
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
export function VendorSheet({
  vendorId,
  onClose,
}: {
  vendorId: string | null;
  onClose: () => void;
}) {
  const vendor = useVendor(vendorId);
  const data = vendor.data;

  return (
    <Sheet open={vendorId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle className="text-base">{data?.name ?? 'Vendor'}</SheetTitle>
          <SheetDescription>
            {data
              ? `${plural(data.openInvoiceCount, 'open invoice', 'open invoices')} · ${plural(data.activeBankAccountCount, 'trusted account', 'trusted accounts')}`
              : vendor.isError
                ? vendor.error.message
                : 'Loading…'}
          </SheetDescription>
        </SheetHeader>
        {data && <VendorBody key={data.id} vendor={data} />}
      </SheetContent>
    </Sheet>
  );
}

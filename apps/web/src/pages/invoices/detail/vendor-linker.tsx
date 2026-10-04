import { type InvoiceDetail, vendorConflictSchema } from '@camex/shared';
import {
  Button,
  ComboBox,
  FieldError,
  Input,
  Label,
  ListBox,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from '@heroui/react';
import { useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useVendors } from '@/pages/vendors/vendors-query';
import { conflictOf, useInvoiceAction } from './detail-query';

type Mode = 'existing' | 'new';

/**
 * Link the invoice to a vendor: pick an existing one (searchable), or create one with the
 * extracted name. The link is saved right away (POST …/vendor) and the invoice comes back
 * re-evaluated, so what follows (bank checks) can use the vendor.
 */
export function VendorLinker({
  invoice,
  onLinked,
  onStale,
}: {
  invoice: InvoiceDetail;
  onLinked: (invoice: InvoiceDetail) => void;
  onStale: () => void;
}) {
  const [mode, setMode] = useState<Mode>(invoice.vendorName === null ? 'existing' : 'new');
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [name, setName] = useState(invoice.vendorName ?? '');
  const [error, setError] = useState<string | null>(null);
  const vendors = useVendors('');
  const options = useMemo(
    () => (vendors.data ?? []).map((vendor) => ({ id: vendor.id, label: vendor.name })),
    [vendors.data],
  );
  const action = useInvoiceAction(invoice.id);

  function link() {
    setError(null);
    const body =
      mode === 'existing'
        ? vendorId === null
          ? null
          : { version: invoice.version, vendorId }
        : { version: invoice.version, create: { name: name.trim() } };
    if (body === null) {
      setError('Choose a vendor');
      return;
    }
    if (mode === 'new' && name.trim() === '') {
      setError('Enter the vendor’s name');
      return;
    }
    action.mutate(
      { kind: 'linkVendor', body },
      {
        onSuccess: onLinked,
        onError: (failure) => {
          const conflict = conflictOf(failure);
          if (conflict?.code === 'STALE') {
            onStale();
            return;
          }
          // A name another vendor already uses (SPEC §9 uniqueness).
          if (failure instanceof ApiError && failure.status === 409) {
            const taken = vendorConflictSchema.safeParse(failure.body);
            if (taken.success) {
              setError(taken.data.message);
              return;
            }
          }
          setError(failure.message);
        },
      },
    );
  }

  return (
    <div className="space-y-3">
      <ToggleButtonGroup
        aria-label="Vendor"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[mode]}
        onSelectionChange={(keys) => {
          const [next] = [...keys];
          if (next === 'existing' || next === 'new') {
            setMode(next);
            setError(null);
          }
        }}
        size="sm"
      >
        <ToggleButton id="new">Create a vendor</ToggleButton>
        <ToggleButton id="existing">Link an existing one</ToggleButton>
      </ToggleButtonGroup>

      <div className="flex flex-wrap items-end gap-2">
        {mode === 'existing' ? (
          <ComboBox
            value={vendorId}
            onChange={(key) => setVendorId(key === null || Array.isArray(key) ? null : String(key))}
            isInvalid={error !== null}
            className="flex min-w-56 flex-1 flex-col gap-1.5"
          >
            <Label>Vendor</Label>
            <ComboBox.InputGroup>
              <Input placeholder="Search vendors" />
              <ComboBox.Trigger />
            </ComboBox.InputGroup>
            <FieldError>{error}</FieldError>
            <ComboBox.Popover className="min-w-64">
              <ListBox
                items={options}
                renderEmptyState={() => (
                  <p className="px-3 py-2 text-muted">
                    {vendors.isPending ? 'Loading…' : 'No vendor found'}
                  </p>
                )}
              >
                {(option) => (
                  <ListBox.Item id={option.id} textValue={option.label}>
                    {option.label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                )}
              </ListBox>
            </ComboBox.Popover>
          </ComboBox>
        ) : (
          <TextField
            value={name}
            onChange={setName}
            isInvalid={error !== null}
            validationBehavior="aria"
            className="flex min-w-56 flex-1 flex-col gap-1.5"
          >
            <Label>New vendor’s name</Label>
            <Input />
            <FieldError>{error}</FieldError>
          </TextField>
        )}
        <Button variant="outline" onPress={link} isPending={action.isPending}>
          {mode === 'existing' ? 'Link vendor' : 'Create vendor'}
        </Button>
      </div>
    </div>
  );
}

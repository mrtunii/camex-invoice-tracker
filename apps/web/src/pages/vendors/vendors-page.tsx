import type { VendorSummary } from '@camex/shared';
import { SearchField, Table } from '@heroui/react';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { TableEmpty, TablePanel } from '@/components/table-panel';
import { TruncatedText } from '@/components/truncated-text';
import { formatCount } from '@/lib/format';
import { AddVendorDialog } from './add-vendor-dialog';
import { VendorDrawer } from './vendor-drawer';
import { useVendors } from './vendors-query';

const SEARCH_DEBOUNCE_MS = 250;

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

function terms(days: number | null): string {
  if (days === null) return '—';
  return days === 1 ? '1 day' : `${String(days)} days`;
}

function Count({ value }: { value: number }) {
  return <span className={value === 0 ? 'text-muted' : undefined}>{formatCount(value)}</span>;
}

export function VendorsPage() {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search.trim());
  const vendors = useVendors(debouncedSearch);
  const [openVendorId, setOpenVendorId] = useState<string | null>(null);
  const rows: VendorSummary[] = vendors.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vendors"
        description="Invoices link to a vendor by name or alias, else by the sender’s email domain. Bank details are checked against each vendor’s trusted accounts."
        action={<AddVendorDialog />}
      />

      <SearchField
        value={search}
        onChange={setSearch}
        aria-label="Search vendors"
        className="w-full max-w-sm"
      >
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder="Search name, alias or domain" />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>

      {vendors.isError ? (
        <p className="text-danger">{vendors.error.message}</p>
      ) : (
        <TablePanel>
          <Table.Content
            aria-label="Vendors"
            className="min-w-[48rem]"
            onRowAction={(key) => setOpenVendorId(String(key))}
          >
            <Table.Header>
              <Table.Column isRowHeader>Name</Table.Column>
              <Table.Column>Aliases</Table.Column>
              <Table.Column>Email domains</Table.Column>
              <Table.Column>Default terms</Table.Column>
              <Table.Column className="text-end">Trusted accounts</Table.Column>
              <Table.Column className="text-end">Open invoices</Table.Column>
            </Table.Header>
            <Table.Body
              items={rows}
              renderEmptyState={() => (
                <TableEmpty loading={vendors.isPending}>
                  {debouncedSearch === ''
                    ? 'No vendors yet. Add one, and invoices waiting for review link to it.'
                    : `No vendor matches “${debouncedSearch}”.`}
                </TableEmpty>
              )}
            >
              {(vendor) => (
                <Table.Row id={vendor.id} className="cursor-pointer">
                  <Table.Cell className="max-w-64 font-medium">
                    <TruncatedText text={vendor.name} />
                  </Table.Cell>
                  <Table.Cell className="max-w-64 text-muted">
                    {vendor.aliases.length === 0 ? (
                      '—'
                    ) : (
                      <TruncatedText text={vendor.aliases.join(', ')} lines={2} />
                    )}
                  </Table.Cell>
                  <Table.Cell className="max-w-56">
                    {vendor.emailDomains.length === 0 ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <TruncatedText text={vendor.emailDomains.join(', ')} lines={2} />
                    )}
                  </Table.Cell>
                  <Table.Cell className="tabular whitespace-nowrap">
                    {terms(vendor.defaultPaymentTermsDays)}
                  </Table.Cell>
                  <Table.Cell className="tabular text-end">
                    <Count value={vendor.activeBankAccountCount} />
                  </Table.Cell>
                  <Table.Cell className="tabular text-end">
                    <Count value={vendor.openInvoiceCount} />
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </TablePanel>
      )}

      <VendorDrawer vendorId={openVendorId} onClose={() => setOpenVendorId(null)} />
    </div>
  );
}

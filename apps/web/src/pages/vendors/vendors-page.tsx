import type { VendorSummary } from '@camex/shared';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AddVendorDialog } from './add-vendor-dialog';
import { VendorSheet } from './vendor-sheet';
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
  return days === 1 ? '1 day' : `${days} days`;
}

function VendorRow({ vendor, onOpen }: { vendor: VendorSummary; onOpen: () => void }) {
  return (
    <TableRow className="cursor-pointer align-top" onClick={onOpen}>
      <TableCell className="max-w-64">
        {/* The whole row is clickable; this button makes it reachable by keyboard. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="block max-w-full truncate text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none"
          title={vendor.name}
        >
          {vendor.name}
        </button>
      </TableCell>
      <TableCell className="max-w-64 text-muted-foreground">
        {vendor.aliases.length === 0 ? (
          '—'
        ) : (
          <span className="line-clamp-2" title={vendor.aliases.join(', ')}>
            {vendor.aliases.join(', ')}
          </span>
        )}
      </TableCell>
      <TableCell className="max-w-48">
        {vendor.emailDomains.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <ul className="space-y-0.5 font-mono text-xs">
            {vendor.emailDomains.map((domain) => (
              <li key={domain} className="truncate" title={domain}>
                {domain}
              </li>
            ))}
          </ul>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">
        {terms(vendor.defaultPaymentTermsDays)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {vendor.activeBankAccountCount === 0 ? (
          <span className="text-muted-foreground">0</span>
        ) : (
          vendor.activeBankAccountCount
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {vendor.openInvoiceCount === 0 ? (
          <span className="text-muted-foreground">0</span>
        ) : (
          vendor.openInvoiceCount
        )}
      </TableCell>
    </TableRow>
  );
}

export function VendorsPage() {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search.trim());
  const vendors = useVendors(debouncedSearch);
  const [openVendorId, setOpenVendorId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vendors"
        description="Invoices are linked to a vendor by name or alias, else by the sender’s email domain. Bank details are checked against each vendor’s trusted accounts."
        actions={<AddVendorDialog />}
      />

      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, alias or domain"
          aria-label="Search vendors"
          className="pl-8"
        />
      </div>

      {vendors.isError ? (
        <p className="text-destructive">{vendors.error.message}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Aliases</TableHead>
                <TableHead>Domains</TableHead>
                <TableHead>Default terms</TableHead>
                <TableHead className="text-right">Trusted accounts</TableHead>
                <TableHead className="text-right">Open invoices</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendors.isPending ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    Loading vendors…
                  </TableCell>
                </TableRow>
              ) : vendors.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    {debouncedSearch === ''
                      ? 'No vendors yet. Add one, and invoices waiting for review link to it.'
                      : `No vendor matches “${debouncedSearch}”.`}
                  </TableCell>
                </TableRow>
              ) : (
                vendors.data.map((vendor) => (
                  <VendorRow
                    key={vendor.id}
                    vendor={vendor}
                    onOpen={() => setOpenVendorId(vendor.id)}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <VendorSheet vendorId={openVendorId} onClose={() => setOpenVendorId(null)} />
    </div>
  );
}

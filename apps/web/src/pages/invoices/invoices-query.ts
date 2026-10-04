import {
  type InvoiceListResponse,
  invoiceListResponseSchema,
  invoiceSummarySchema,
} from '@camex/shared';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { toast } from '@heroui/react';
import { api, apiDownload } from '@/lib/api';
import {
  type ListFilters,
  type ListParams,
  exportApiPath,
  listApiPath,
  summaryApiPath,
} from './list-params';

export const invoicesQueryKey = ['invoices'] as const;

/** While a visible row is still being extracted, refresh every 5 s. */
export const PROCESSING_REFETCH_MS = 5000;

export function hasProcessing(data: InvoiceListResponse | undefined): boolean {
  return data?.items.some((item) => item.status === 'processing') ?? false;
}

export function useInvoiceList(params: ListParams) {
  const path = listApiPath(params);
  return useQuery({
    queryKey: [...invoicesQueryKey, 'list', path],
    queryFn: () => api(path, invoiceListResponseSchema),
    // Keep the rows on screen while the next page, sort or filter loads.
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (hasProcessing(query.state.data) ? PROCESSING_REFETCH_MS : false),
  });
}

export function useInvoiceSummary(filters: ListFilters, refetchInterval: number | false) {
  const path = summaryApiPath(filters);
  return useQuery({
    queryKey: [...invoicesQueryKey, 'summary', path],
    queryFn: () => api(path, invoiceSummarySchema),
    placeholderData: keepPreviousData,
    refetchInterval,
  });
}

export function useExportCsv() {
  return useMutation({
    mutationFn: (params: ListParams) => apiDownload(exportApiPath(params)),
    onSuccess: (fileName) => toast.success(`Downloaded ${fileName}`),
    onError: (error) => toast.danger(error.message),
  });
}

import { type Dashboard, dashboardSchema } from '@camex/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PROCESSING_REFETCH_MS, invoicesQueryKey } from '@/pages/invoices/invoices-query';

/** While an invoice to review is still being read, refresh like the list does. */
function hasProcessing(data: Dashboard | undefined): boolean {
  return data?.attention.toReview.items.some((item) => item.status === 'processing') ?? false;
}

/**
 * GET /api/dashboard. Keyed under the invoices so an upload or any invoice change that
 * invalidates the list refreshes Home too.
 */
export function useDashboard(month: string | null, currency: string | null) {
  const search = new URLSearchParams();
  if (month !== null) search.set('month', month);
  if (currency !== null) search.set('currency', currency);
  const query = search.toString();
  return useQuery({
    queryKey: [...invoicesQueryKey, 'dashboard', query],
    queryFn: () => api(`/dashboard${query === '' ? '' : `?${query}`}`, dashboardSchema),
    // Keep the page while another month or currency loads.
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (hasProcessing(q.state.data) ? PROCESSING_REFETCH_MS : false),
  });
}

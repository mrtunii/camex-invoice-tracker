import {
  type CreateVendorRequest,
  type UpdateVendorRequest,
  vendorDetailSchema,
  vendorListResponseSchema,
} from '@camex/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { inboxQueryKey } from '@/pages/inbox/inbox-query';

export const vendorsQueryKey = ['vendors'] as const;

export function useVendors(search: string) {
  return useQuery({
    queryKey: [...vendorsQueryKey, 'list', search],
    queryFn: async () =>
      (
        await api(
          `/vendors${search === '' ? '' : `?search=${encodeURIComponent(search)}`}`,
          vendorListResponseSchema,
        )
      ).vendors,
    // Keep the table while a new search loads, instead of flashing "Loading".
    placeholderData: keepPreviousData,
  });
}

export function useVendor(id: string | null) {
  return useQuery({
    queryKey: [...vendorsQueryKey, 'detail', id],
    queryFn: () => api(`/vendors/${id ?? ''}`, vendorDetailSchema),
    enabled: id !== null,
  });
}

/** Vendor changes re-evaluate invoices, so the Inbox's flag counts change too. */
function useInvalidateAfterVendorChange() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: vendorsQueryKey }),
      queryClient.invalidateQueries({ queryKey: inboxQueryKey }),
    ]);
}

export function useCreateVendor() {
  const invalidate = useInvalidateAfterVendorChange();
  return useMutation({
    mutationFn: (body: CreateVendorRequest) =>
      api('/vendors', vendorDetailSchema, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateVendor(id: string) {
  const invalidate = useInvalidateAfterVendorChange();
  return useMutation({
    mutationFn: (body: UpdateVendorRequest) =>
      api(`/vendors/${id}`, vendorDetailSchema, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useRemoveBankAccount(vendorId: string) {
  const invalidate = useInvalidateAfterVendorChange();
  return useMutation({
    mutationFn: (accountId: string) =>
      api(`/vendors/${vendorId}/bank-accounts/${accountId}`, vendorDetailSchema, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });
}

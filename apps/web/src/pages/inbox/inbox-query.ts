import {
  type InboxEmail,
  type InboxListResponse,
  inboxEmailDetailSchema,
  inboxListResponseSchema,
} from '@camex/shared';
import { type InfiniteData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const inboxQueryKey = ['inbox'] as const;

/** While extraction runs, refresh every 5 s so chips move from Processing to Needs review. */
const PROCESSING_REFETCH_MS = 5000;

function hasProcessing(emails: InboxEmail[]): boolean {
  return emails.some((email) => email.invoices.some((i) => i.status === 'processing'));
}

export function useInbox() {
  return useInfiniteQuery({
    queryKey: inboxQueryKey,
    queryFn: ({ pageParam }) =>
      api(`/inbox${pageParam ? `?cursor=${pageParam}` : ''}`, inboxListResponseSchema),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: (query) => {
      const data: InfiniteData<InboxListResponse> | undefined = query.state.data;
      const emails = data?.pages.flatMap((page) => page.items) ?? [];
      return hasProcessing(emails) ? PROCESSING_REFETCH_MS : false;
    },
  });
}

export function useInboxEmail(id: string | null) {
  return useQuery({
    queryKey: [...inboxQueryKey, 'email', id],
    queryFn: () => api(`/inbox/${id ?? ''}`, inboxEmailDetailSchema),
    enabled: id !== null,
    refetchInterval: (query) =>
      query.state.data && hasProcessing([query.state.data]) ? PROCESSING_REFETCH_MS : false,
  });
}

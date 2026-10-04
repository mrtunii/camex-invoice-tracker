import {
  type ApproveInvoiceRequest,
  type InvoiceDetail,
  type LinkInvoiceVendorRequest,
  type MarkPaidInput,
  type RejectInvoiceInput,
  type UpdateInvoiceInput,
  type WorkflowConflict,
  invoiceDetailSchema,
  invoiceEventsResponseSchema,
  nextToReviewResponseSchema,
  workflowConflictSchema,
} from '@camex/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { inboxQueryKey } from '@/pages/inbox/inbox-query';
import { invoicesQueryKey } from '@/pages/invoices/invoices-query';
import { vendorsQueryKey } from '@/pages/vendors/vendors-query';

/** While the PDF is being read, the detail refreshes this often. */
const READING_REFETCH_MS = 2000;

export const detailQueryKey = (id: string) => [...invoicesQueryKey, 'detail', id] as const;
export const eventsQueryKey = (id: string) => [...invoicesQueryKey, 'events', id] as const;

export function useInvoiceDetail(id: string | null) {
  return useQuery({
    queryKey: detailQueryKey(id ?? ''),
    queryFn: () => api(`/invoices/${id ?? ''}`, invoiceDetailSchema),
    enabled: id !== null,
    refetchInterval: (query) =>
      query.state.data?.status === 'processing' ? READING_REFETCH_MS : false,
  });
}

export function useInvoiceEvents(id: string, refreshKey: string) {
  return useQuery({
    // `refreshKey` (the invoice's version and status) reloads the log after every change.
    queryKey: [...eventsQueryKey(id), refreshKey],
    queryFn: () => api(`/invoices/${id}/events`, invoiceEventsResponseSchema),
  });
}

/** The 409 body of a workflow action (STALE, INVALID_TRANSITION, …), or null. */
export function conflictOf(error: unknown): WorkflowConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = workflowConflictSchema.safeParse(error.body);
  return parsed.success ? parsed.data : null;
}

/** A 400's field issues (ZodValidationPipe shape): `[{path, message}]`. */
export function validationIssuesOf(error: unknown): { path: string; message: string }[] {
  if (!(error instanceof ApiError) || error.status !== 400) return [];
  const { body } = error;
  if (typeof body !== 'object' || body === null || !('issues' in body)) return [];
  const { issues } = body;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) =>
    typeof issue === 'object' &&
    issue !== null &&
    'path' in issue &&
    'message' in issue &&
    typeof issue.path === 'string' &&
    typeof issue.message === 'string'
      ? [{ path: issue.path, message: issue.message }]
      : [],
  );
}

/** After any change: this invoice's new state, and every list, count and Home figure. */
function refreshAfter(queryClient: QueryClient, invoice: InvoiceDetail): void {
  queryClient.setQueryData(detailQueryKey(invoice.id), invoice);
  void queryClient.invalidateQueries({
    queryKey: invoicesQueryKey,
    predicate: (query) => query.queryKey[1] !== 'detail' || query.queryKey[2] !== invoice.id,
  });
  void queryClient.invalidateQueries({ queryKey: inboxQueryKey });
}

export type InvoiceAction =
  | { kind: 'save'; body: UpdateInvoiceInput }
  | { kind: 'approve'; body: ApproveInvoiceRequest }
  | { kind: 'reject'; body: RejectInvoiceInput }
  | { kind: 'reextract'; body: { version: number } }
  | { kind: 'markPaid'; body: MarkPaidInput }
  | { kind: 'undoPayment'; body: { version: number } }
  | { kind: 'reopen'; body: { version: number } }
  | { kind: 'linkVendor'; body: LinkInvoiceVendorRequest };

const ENDPOINT: Record<InvoiceAction['kind'], { path: string; method: 'POST' | 'PATCH' }> = {
  save: { path: '', method: 'PATCH' },
  approve: { path: '/approve', method: 'POST' },
  reject: { path: '/reject', method: 'POST' },
  reextract: { path: '/reextract', method: 'POST' },
  markPaid: { path: '/mark-paid', method: 'POST' },
  undoPayment: { path: '/undo-payment', method: 'POST' },
  reopen: { path: '/reopen', method: 'POST' },
  linkVendor: { path: '/vendor', method: 'POST' },
};

/** Every write on an invoice; each returns the invoice as it is afterwards. */
export function useInvoiceAction(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: InvoiceAction) => {
      const { path, method } = ENDPOINT[action.kind];
      return api(`/invoices/${id}${path}`, invoiceDetailSchema, { method, body: action.body });
    },
    onSuccess: (invoice, action) => {
      refreshAfter(queryClient, invoice);
      if (action.kind === 'linkVendor' || action.kind === 'approve') {
        // A vendor may have been created, or got an alias or a trusted account.
        void queryClient.invalidateQueries({ queryKey: vendorsQueryKey });
      }
    },
  });
}

/** For undo buttons in toasts: the action on an invoice that may no longer be on screen. */
export function useInvoiceActionFor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: InvoiceAction }) => {
      const { path, method } = ENDPOINT[action.kind];
      return api(`/invoices/${id}${path}`, invoiceDetailSchema, { method, body: action.body });
    },
    onSuccess: (invoice) => refreshAfter(queryClient, invoice),
  });
}

/** The next invoice in To review's order after approving `after`, or null when none is left. */
export async function fetchNextToReview(after: string): Promise<string | null> {
  const { id } = await api(
    `/invoices/next-to-review?after=${encodeURIComponent(after)}`,
    nextToReviewResponseSchema,
  );
  return id;
}

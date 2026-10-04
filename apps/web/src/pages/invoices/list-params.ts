import {
  DEFAULT_INVOICE_SORT,
  DEFAULT_SORT_ORDER,
  type DueFilter,
  type InvoiceCategory,
  type InvoiceListStatus,
  type InvoiceSortKey,
  type SortOrder,
  currencyCodeSchema,
  dueFilterSchema,
  invoiceCategorySchema,
  invoiceListStatusSchema,
  invoiceSortKeySchema,
  sortOrderSchema,
  uuidSchema,
  validCalendarDateSchema,
} from '@camex/shared';
import type { z } from 'zod';

// The invoices list keeps its whole state in the URL (tab, filters, sort, page), with the same
// parameter names as GET /api/invoices, so a link, a reload or back/forward restores the view.

export interface ListFilters {
  /** As typed; only sent to the API from 2 characters. */
  q: string;
  vendorId: string | null;
  category: InvoiceCategory | null;
  currency: string | null;
  invoiceDateFrom: string | null;
  invoiceDateTo: string | null;
  hasErrors: boolean;
  due: DueFilter | null;
}

export interface ListParams extends ListFilters {
  status: InvoiceListStatus;
  /** null = the tab's default sort. */
  sort: InvoiceSortKey | null;
  order: SortOrder | null;
  page: number;
}

export const NO_FILTERS: ListFilters = {
  q: '',
  vendorId: null,
  category: null,
  currency: null,
  invoiceDateFrom: null,
  invoiceDateTo: null,
  hasErrors: false,
  due: null,
};

const MIN_SEARCH = 2;

/** Parses the URL leniently: a value that doesn't validate is ignored, never an error page. */
export function readListParams(search: URLSearchParams): ListParams {
  function one<T>(schema: z.ZodType<T>, key: string): T | null {
    const raw = search.get(key);
    if (raw === null) return null;
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  const page = Number(search.get('page'));
  const from = one(validCalendarDateSchema, 'invoiceDateFrom');
  const to = one(validCalendarDateSchema, 'invoiceDateTo');
  return {
    status: one(invoiceListStatusSchema, 'status') ?? 'needs_review',
    q: search.get('q') ?? '',
    vendorId: one(uuidSchema, 'vendorId'),
    category: one(invoiceCategorySchema, 'category'),
    currency: one(currencyCodeSchema, 'currency'),
    invoiceDateFrom: from,
    // A reversed range would be refused by the API; keep the start.
    invoiceDateTo: from !== null && to !== null && to < from ? null : to,
    hasErrors: search.get('hasErrors') === 'true',
    due: one(dueFilterSchema, 'due'),
    sort: one(invoiceSortKeySchema, 'sort'),
    order: one(sortOrderSchema, 'order'),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

function setFilters(target: URLSearchParams, filters: ListFilters, forApi: boolean): void {
  const q = filters.q.trim();
  if (forApi ? q.length >= MIN_SEARCH : filters.q !== '') target.set('q', forApi ? q : filters.q);
  if (filters.vendorId) target.set('vendorId', filters.vendorId);
  if (filters.category) target.set('category', filters.category);
  if (filters.currency) target.set('currency', filters.currency);
  if (filters.invoiceDateFrom) target.set('invoiceDateFrom', filters.invoiceDateFrom);
  if (filters.invoiceDateTo) target.set('invoiceDateTo', filters.invoiceDateTo);
  if (filters.hasErrors) target.set('hasErrors', 'true');
  if (filters.due) target.set('due', filters.due);
}

/** The page's URL query; defaults (Needs review, default sort, page 1) are left out. */
export function writeListParams(params: ListParams): URLSearchParams {
  const search = new URLSearchParams();
  if (params.status !== 'needs_review') search.set('status', params.status);
  setFilters(search, params, false);
  if (params.sort) search.set('sort', params.sort);
  if (params.order) search.set('order', params.order);
  if (params.page > 1) search.set('page', String(params.page));
  return search;
}

export function hasActiveFilters(filters: ListFilters): boolean {
  return (
    filters.q.trim().length >= MIN_SEARCH ||
    filters.vendorId !== null ||
    filters.category !== null ||
    filters.currency !== null ||
    filters.invoiceDateFrom !== null ||
    filters.invoiceDateTo !== null ||
    filters.hasErrors ||
    filters.due !== null
  );
}

/** The sort in effect: the URL's, else the tab's default. */
export function effectiveSort(params: ListParams): { sort: InvoiceSortKey; order: SortOrder } {
  const fallback = DEFAULT_INVOICE_SORT[params.status];
  if (params.sort === null) return { sort: fallback.sort, order: params.order ?? fallback.order };
  return { sort: params.sort, order: params.order ?? DEFAULT_SORT_ORDER[params.sort] };
}

function withQuery(path: string, search: URLSearchParams): string {
  const query = search.toString();
  return query === '' ? path : `${path}?${query}`;
}

function listAndExportQuery(params: ListParams): URLSearchParams {
  const search = new URLSearchParams({ status: params.status });
  setFilters(search, params, true);
  if (params.sort) search.set('sort', params.sort);
  if (params.order) search.set('order', params.order);
  return search;
}

export function listApiPath(params: ListParams): string {
  const search = listAndExportQuery(params);
  search.set('page', String(params.page));
  return withQuery('/invoices', search);
}

export function summaryApiPath(filters: ListFilters): string {
  const search = new URLSearchParams();
  setFilters(search, filters, true);
  return withQuery('/invoices/summary', search);
}

/** The CSV of the current tab, filters and sort (no pagination). */
export function exportApiPath(params: ListParams): string {
  return withQuery('/invoices/export.csv', listAndExportQuery(params));
}

import { type InvoiceDetail, STALE_MESSAGE, businessToday, uuidSchema } from '@camex/shared';
import { Button, Link, Spinner, Tabs, toast, useMediaQuery } from '@heroui/react';
import { ArrowLeft } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Path, useForm, useWatch } from 'react-hook-form';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useBlocker, useLocation, useNavigate, useParams } from 'react-router';
import { ApiError } from '@/lib/api';
import { useDocumentTitle } from '@/lib/document-title';
import { NotFoundPage } from '@/pages/not-found-page';
import { ActionBar } from './action-bar';
import { ApproveDialog, ConfirmDialog, MarkPaidDialog, RejectDialog } from './action-dialogs';
import {
  conflictOf,
  fetchNextToReview,
  useInvoiceAction,
  useInvoiceActionFor,
  useInvoiceDetail,
  validationIssuesOf,
} from './detail-query';
import { focusField } from './field-focus';
import { type InvoiceFormValues, diffForm, toFormValues } from './form-model';
import { InvoiceFacts } from './invoice-facts';
import { InvoiceHeader } from './invoice-header';
import { ReviewForm } from './review-form';
import { ActivityLog, IssuesList, PaymentDetails, SourceEmail } from './side-sections';

// pdf.js is the heaviest part of the page: it loads next to the data, not before it.
const PdfViewer = lazy(async () => ({ default: (await import('./pdf-viewer')).PdfViewer }));

const WIDE = '(min-width: 1024px)';

/** The split's ratio is remembered per browser; storage may be unavailable (private mode). */
const layoutStorage = {
  getItem: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not remembered, that's all.
    }
  },
};

/** What the list put in the history entry when it opened the invoice. */
interface DetailState {
  /** The list's query string ("?status=unpaid&q=aeg"). */
  from?: string;
  /** Opened by "Approve & next", not from the list itself. */
  next?: boolean;
}

function readState(state: unknown): DetailState {
  if (typeof state !== 'object' || state === null) return {};
  const from = 'from' in state && typeof state.from === 'string' ? state.from : undefined;
  const next = 'next' in state && state.next === true;
  return { from, next };
}

type Dialog =
  | { kind: 'approve'; invoice: InvoiceDetail; andNext: boolean }
  | { kind: 'markPaid' }
  | { kind: 'reject' }
  | { kind: 'reextract' };

function PdfFallback() {
  return (
    <div className="grid h-full min-h-64 place-items-center">
      <Spinner size="sm" color="current" className="text-muted" aria-label="Loading the viewer" />
    </div>
  );
}

/** `/invoices/:id`: the original PDF and the extracted data side by side, and the actions. */
export function InvoicePage() {
  const { id = '' } = useParams();
  const valid = uuidSchema.safeParse(id).success;
  const query = useInvoiceDetail(valid ? id : null);

  if (!valid || (query.error instanceof ApiError && query.error.status === 404)) {
    return <NotFoundPage />;
  }
  if (query.data === undefined) {
    return (
      <div className="grid min-h-64 place-items-center p-8">
        {query.isError ? (
          <div className="space-y-3 text-center">
            <p>Couldn’t load the invoice: {query.error.message}</p>
            <Button variant="outline" onPress={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <Spinner size="sm" color="current" className="text-muted" aria-label="Loading invoice" />
        )}
      </div>
    );
  }
  return (
    <InvoiceReview key={id} server={query.data} reload={async () => (await query.refetch()).data} />
  );
}

function InvoiceReview({
  server,
  reload,
}: {
  /** The invoice as the server last sent it (refreshes while it is being read). */
  server: InvoiceDetail;
  reload: () => Promise<InvoiceDetail | undefined>;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const wide = useMediaQuery(WIDE, { initializeWithValue: true });
  const today = businessToday();

  // The invoice the form was loaded from: its version is what our writes are made against.
  const [base, setBase] = useState(server);
  const form = useForm<InvoiceFormValues>({ defaultValues: toFormValues(server) });
  const values = useWatch({ control: form.control }) as InvoiceFormValues;
  const editable = base.status === 'needs_review';
  const diff = useMemo(() => (editable ? diffForm(values, base) : null), [editable, values, base]);
  const dirty = (diff?.dirty.length ?? 0) > 0;
  const [stale, setStale] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [tab, setTab] = useState<'document' | 'details'>('details');
  const action = useInvoiceAction(base.id);
  const actionFor = useInvoiceActionFor();
  const busy = action.isPending;

  useDocumentTitle(base.invoiceNumber === null ? base.fileName : `Invoice ${base.invoiceNumber}`);

  const adopt = useCallback(
    (next: InvoiceDetail, { keepEdits = false }: { keepEdits?: boolean } = {}) => {
      setBase(next);
      if (!keepEdits) form.reset(toFormValues(next));
    },
    [form],
  );

  // Newer data from the server (polling while reading, someone else's change, a re-evaluation):
  // taken as is while there are no edits; with edits, a newer version means our save would be
  // refused, so say so now instead of on save. The form is never overwritten silently.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    if (server === base) return;
    // Syncing react-hook-form (an outside store) with the server's data has to happen here.
    if (!dirtyRef.current) adopt(server);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    else if (server.version !== base.version) setStale(true);
    else adopt(server, { keepEdits: true });
    // `base` is deliberately not a dependency: this reacts to the server's data only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, adopt]);

  const handleError = useCallback(
    (error: Error) => {
      const conflict = conflictOf(error);
      if (conflict?.code === 'STALE') {
        setStale(true);
        return;
      }
      if (conflict !== null) {
        toast.danger(conflict.message);
        void reload();
        return;
      }
      const issues = validationIssuesOf(error);
      if (issues.length > 0) {
        for (const issue of issues) {
          form.setError(issue.path as Path<InvoiceFormValues>, { message: issue.message });
        }
        const first = issues[0];
        if (first) focusField(first.path);
        return;
      }
      toast.danger(error.message);
    },
    [form, reload],
  );

  /** Saves the edits; resolves to the saved invoice, or null when nothing could be saved. */
  const save = useCallback(async (): Promise<InvoiceDetail | null> => {
    if (diff === null) return base;
    form.clearErrors();
    if (diff.issues.length > 0) {
      for (const issue of diff.issues) {
        form.setError(issue.path as Path<InvoiceFormValues>, { message: issue.message });
      }
      const first = diff.issues[0];
      if (first) focusField(first.path);
      toast.danger('Some fields need fixing before saving.');
      return null;
    }
    if (Object.keys(diff.changes).length === 0) return base;
    try {
      const saved = await action.mutateAsync({
        kind: 'save',
        body: { version: base.version, ...diff.changes },
      });
      adopt(saved);
      toast.success('Saved');
      return saved;
    } catch (error) {
      handleError(error as Error);
      return null;
    }
  }, [action, adopt, base, diff, form, handleError]);

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => {
    if (!editable) return;
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (dirtyRef.current) void saveRef.current();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editable]);

  // Unsaved changes: the browser asks on reload/close, the app on navigation.
  useEffect(() => {
    if (!dirty || !editable) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, editable]);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
  );

  const state = readState(location.state);
  const listHref = `/invoices${state.from ?? ''}`;
  const cameFromList = state.from !== undefined && state.next !== true;

  function undoToast(message: string, onUndo: () => void) {
    let toastId = '';
    toastId = toast.success(message, {
      actionProps: {
        children: 'Undo',
        onPress: () => {
          toast.close(toastId);
          onUndo();
        },
      },
    });
  }

  function undo(invoice: InvoiceDetail, kind: 'reopen' | 'undoPayment', done: string) {
    actionFor.mutate(
      { id: invoice.id, action: { kind, body: { version: invoice.version } } },
      {
        onSuccess: () => toast(done),
        onError: (error) => toast.danger(conflictOf(error)?.message ?? error.message),
      },
    );
  }

  async function approved(invoice: InvoiceDetail, andNext: boolean) {
    setDialog(null);
    adopt(invoice);
    undoToast('Approved. Moved to To pay.', () => undo(invoice, 'reopen', 'Back in To review.'));
    if (!andNext) return;
    const next = await fetchNextToReview(invoice.id).catch(() => null);
    if (next === null) {
      void navigate('/invoices', { state: { caughtUp: true } });
    } else {
      void navigate(`/invoices/${next}`, { state: { from: state.from, next: true } });
    }
  }

  async function approve(andNext: boolean) {
    let current = base;
    if (dirty) {
      const saved = await save();
      if (saved === null) return;
      current = saved;
    }
    const missing = current.flags.filter((flag) => flag.code === 'MISSING_REQUIRED');
    if (missing.length > 0) {
      toast.danger(`Can’t approve yet: ${missing.map((flag) => flag.message).join(', ')}.`);
      return;
    }
    const decide =
      current.vendor === null ||
      current.flags.some((flag) => flag.code === 'BANK_FIRST_SEEN' || flag.severity === 'error');
    if (decide) {
      setDialog({ kind: 'approve', invoice: current, andNext });
      return;
    }
    try {
      const result = await action.mutateAsync({
        kind: 'approve',
        body: { version: current.version },
      });
      await approved(result, andNext);
    } catch (error) {
      const conflict = conflictOf(error);
      if (conflict?.code === 'CONFIRM_REQUIRED' || conflict?.code === 'VENDOR_REQUIRED') {
        const fresh = await reload();
        if (fresh) setDialog({ kind: 'approve', invoice: fresh, andNext });
        return;
      }
      handleError(error as Error);
    }
  }

  function simple(kind: 'undoPayment' | 'reopen' | 'reextract', done: string) {
    action.mutate(
      { kind, body: { version: base.version } },
      {
        onSuccess: (invoice) => {
          setDialog(null);
          adopt(invoice);
          toast.success(done);
        },
        onError: (error) => {
          setDialog(null);
          handleError(error);
        },
      },
    );
  }

  async function reloadFromServer() {
    const fresh = await reload();
    if (fresh) {
      adopt(fresh);
      setStale(false);
    }
  }

  const missingReason = useMemo(() => {
    const missing = base.flags.filter((flag) => flag.code === 'MISSING_REQUIRED');
    return missing.length === 0
      ? null
      : `Can’t approve yet: ${missing.map((flag) => flag.message).join(', ')}.`;
  }, [base.flags]);

  const markStale = () => {
    setDialog(null);
    setStale(true);
  };

  const actionBar = (
    <ActionBar
      invoice={base}
      dirty={dirty}
      busy={busy}
      saving={busy && action.variables.kind === 'save'}
      missing={missingReason}
      handlers={{
        onSave: () => void save(),
        onApprove: (andNext) => void approve(andNext),
        onReject: () => setDialog({ kind: 'reject' }),
        onReextract: () => setDialog({ kind: 'reextract' }),
        onMarkPaid: () => setDialog({ kind: 'markPaid' }),
        onUndoPayment: () => simple('undoPayment', 'Payment undone. Back in To pay.'),
        onReopen: () => simple('reopen', 'Reopened. Back in To review.'),
      }}
      className={wide ? undefined : 'sticky bottom-0 z-20 -mx-4 sm:-mx-8'}
    />
  );

  const details = (
    <div className="space-y-8">
      {stale && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-danger/50 p-3"
        >
          <div>
            <p className="font-medium text-danger">{STALE_MESSAGE}</p>
            {dirty && (
              <p className="text-xs text-muted">Your edits stay on screen until you reload.</p>
            )}
          </div>
          <Button size="sm" variant="outline" onPress={() => void reloadFromServer()}>
            Reload
          </Button>
        </div>
      )}
      <InvoiceHeader
        invoice={base}
        today={today}
        onChange={(linked) => adopt(linked, { keepEdits: dirty })}
        onStale={markStale}
      />
      {base.status === 'processing' ? (
        <p className="flex items-center gap-2 text-muted" role="status">
          <Spinner size="sm" color="current" aria-hidden />
          Reading the PDF… The details appear here when it’s done.
        </p>
      ) : (
        <>
          <IssuesList invoice={base} onFocus={focusField} />
          {editable ? (
            <form
              noValidate
              aria-label="Invoice details"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <ReviewForm form={form} invoice={base} />
            </form>
          ) : (
            <InvoiceFacts invoice={base} />
          )}
          {(base.status === 'unpaid' || base.status === 'paid') && (
            <PaymentDetails invoice={base} />
          )}
        </>
      )}
      <SourceEmail invoice={base} />
      <ActivityLog invoice={base} today={today} />
    </div>
  );

  const backLink = (
    <Link
      href={cameFromList ? undefined : listHref}
      onPress={cameFromList ? () => void navigate(-1) : undefined}
      className="gap-1.5 text-muted no-underline hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Invoices
    </Link>
  );

  const pdf = (fill: boolean) => (
    <Suspense fallback={<PdfFallback />}>
      <PdfViewer invoiceId={base.id} fileName={base.fileName} fill={fill} />
    </Suspense>
  );

  return (
    <>
      {wide ? (
        <SplitView backLink={backLink} pdf={pdf(true)} details={details} actionBar={actionBar} />
      ) : (
        <div className="px-4 pt-4 sm:px-8 sm:pt-6">
          <div className="mb-3">{backLink}</div>
          <Tabs
            variant="secondary"
            selectedKey={tab}
            onSelectionChange={(key) => setTab(key === 'document' ? 'document' : 'details')}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label="Invoice views" className="min-w-0">
                <Tabs.Tab id="document" className="w-auto px-3">
                  Document
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab id="details" className="w-auto px-3">
                  Details
                  <Tabs.Indicator />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel id="document" className="-mx-4 px-0 pt-3 pb-6 sm:mx-0">
              {pdf(false)}
            </Tabs.Panel>
            <Tabs.Panel id="details" className="px-0 pt-5 pb-8">
              {details}
            </Tabs.Panel>
          </Tabs>
          {actionBar}
        </div>
      )}

      {dialog?.kind === 'approve' && (
        <ApproveDialog
          invoice={dialog.invoice}
          onClose={() => setDialog(null)}
          onApproved={(invoice) => void approved(invoice, dialog.andNext)}
          onInvoiceChange={(invoice) => adopt(invoice)}
          onStale={markStale}
        />
      )}
      {dialog?.kind === 'markPaid' && (
        <MarkPaidDialog
          invoice={base}
          onClose={() => setDialog(null)}
          onPaid={(invoice) => {
            setDialog(null);
            adopt(invoice);
            undoToast('Marked paid. Moved to Paid.', () =>
              undo(invoice, 'undoPayment', 'Payment undone. Back in To pay.'),
            );
          }}
          onStale={markStale}
        />
      )}
      {dialog?.kind === 'reject' && (
        <RejectDialog
          invoice={base}
          hasUnsavedChanges={dirty}
          onClose={() => setDialog(null)}
          onRejected={(invoice) => {
            setDialog(null);
            adopt(invoice);
            toast.success('Rejected.');
          }}
          onStale={markStale}
        />
      )}
      <ConfirmDialog
        isOpen={dialog?.kind === 'reextract'}
        title="Read the PDF again?"
        body={<p>This replaces every field with a fresh reading. Your edits will be lost.</p>}
        confirmLabel="Read again"
        pendingLabel="Starting…"
        isPending={busy && action.variables.kind === 'reextract'}
        danger
        onConfirm={() => simple('reextract', 'Reading the PDF again.')}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        isOpen={blocker.state === 'blocked'}
        title="Leave without saving?"
        body={<p>Your changes to this invoice haven’t been saved.</p>}
        confirmLabel="Leave without saving"
        cancelLabel="Stay"
        danger
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </>
  );
}

/** ≥ 1024 px: the PDF and the data side by side, resizable, the ratio remembered. */
function SplitView({
  backLink,
  pdf,
  details,
  actionBar,
}: {
  backLink: React.ReactNode;
  pdf: React.ReactNode;
  details: React.ReactNode;
  actionBar: React.ReactNode;
}) {
  const layout = useDefaultLayout({ id: 'camex-invoice-split', storage: layoutStorage });
  return (
    <div className="flex h-svh flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-line px-4">{backLink}</div>
      <Group
        orientation="horizontal"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="min-h-0 flex-1"
      >
        <Panel id="pdf" defaultSize="55%" minSize="25%">
          {pdf}
        </Panel>
        <Separator className="group relative w-2 shrink-0 bg-transparent outline-none">
          <span
            aria-hidden
            className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-colors group-hover:w-0.5 group-hover:bg-primary group-focus-visible:w-0.5 group-focus-visible:bg-primary"
          />
        </Separator>
        <Panel id="details" defaultSize="45%" minSize="30%">
          <div className="flex h-full flex-col bg-background">
            {/* `relative`: visually hidden (absolute) labels stay inside the scroll area. */}
            <div className="relative min-h-0 flex-1 overflow-y-auto px-6 py-6">{details}</div>
            {actionBar}
          </div>
        </Panel>
      </Group>
    </div>
  );
}

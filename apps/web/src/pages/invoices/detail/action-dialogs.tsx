import {
  type InvoiceDetail,
  type InvoiceFlag,
  type RejectionReason,
  businessToday,
  invoiceDetailSchema,
  rejectionReasonSchema,
} from '@camex/shared';
import {
  AlertDialog,
  Button,
  Checkbox,
  Description,
  FieldError,
  Input,
  Label,
  Modal,
  Radio,
  RadioGroup,
  TextArea,
  TextField,
  toast,
} from '@heroui/react';
import { type ReactNode, useState } from 'react';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { REJECTION_REASON_LABELS } from '@/lib/invoice-labels';
import { conflictOf, useInvoiceAction, validationIssuesOf } from './detail-query';
import { DateInput } from './form-fields';
import { VendorLinker } from './vendor-linker';

/** SPEC §8 wording for BANK_UNKNOWN on approve. */
const BANK_UNKNOWN_TEXT =
  'Bank details differ from the ones on file. Verify by phone with the vendor before paying.';

function errorFlags(invoice: InvoiceDetail): InvoiceFlag[] {
  return invoice.flags.filter((flag) => flag.severity === 'error');
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function BankDetailsBlock({ invoice }: { invoice: InvoiceDetail }) {
  const bank = invoice.bankDetails;
  if (bank === null) return null;
  const rows: [string, string | null, boolean][] = [
    ['Beneficiary', bank.beneficiary, false],
    ['Bank', bank.bankName, false],
    ['IBAN', bank.iban, true],
    ['Account number', bank.accountNumber, true],
    ['SWIFT', bank.swift, true],
  ];
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-control border border-line bg-surface-secondary p-3">
      {rows
        .filter(([, value]) => value !== null)
        .map(([label, value, mono]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className={mono ? 'font-mono break-all' : 'break-words'}>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function ConfirmCheckbox({
  isSelected,
  onChange,
  children,
}: {
  isSelected: boolean;
  onChange: (selected: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Checkbox isSelected={isSelected} onChange={onChange}>
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        {children}
      </Checkbox.Content>
    </Checkbox>
  );
}

function ErrorList({ flags }: { flags: InvoiceFlag[] }) {
  return (
    <ul className="space-y-1 text-danger">
      {flags.map((flag) => (
        <li key={`${flag.code}-${flag.field ?? ''}`}>{flag.message}</li>
      ))}
    </ul>
  );
}

async function reload(id: string): Promise<InvoiceDetail> {
  return api(`/invoices/${id}`, invoiceDetailSchema);
}

/**
 * Approve, when something needs a decision first: a vendor to link or create, bank details to
 * trust (BANK_FIRST_SEEN), the BANK_UNKNOWN warning, error flags to approve anyway. Only the
 * steps that apply are shown, in that order.
 */
export function ApproveDialog({
  invoice: initial,
  onClose,
  onApproved,
  onInvoiceChange,
  onStale,
}: {
  invoice: InvoiceDetail;
  onClose: () => void;
  onApproved: (invoice: InvoiceDetail) => void;
  onInvoiceChange: (invoice: InvoiceDetail) => void;
  onStale: () => void;
}) {
  const [invoice, setInvoice] = useState(initial);
  const [trust, setTrust] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useInvoiceAction(invoice.id);

  const errors = errorFlags(invoice);
  const bankUnknown = errors.some((flag) => flag.code === 'BANK_UNKNOWN');
  const firstSeen = invoice.flags.some((flag) => flag.code === 'BANK_FIRST_SEEN');
  const otherErrors = errors.filter((flag) => flag.code !== 'BANK_UNKNOWN');
  const vendorMissing = invoice.vendor === null;
  const canApprove = !vendorMissing && (errors.length === 0 || confirm);

  function changed(next: InvoiceDetail) {
    setInvoice(next);
    setConfirm(false);
    onInvoiceChange(next);
  }

  function approve() {
    setNotice(null);
    action.mutate(
      {
        kind: 'approve',
        body: {
          version: invoice.version,
          ...(errors.length > 0 ? { confirmErrors: confirm } : {}),
          ...(firstSeen && trust ? { trustBankDetails: true } : {}),
        },
      },
      {
        onSuccess: onApproved,
        onError: (error) => {
          const conflict = conflictOf(error);
          if (conflict?.code === 'STALE') {
            onStale();
            return;
          }
          if (conflict !== null && conflict.code !== 'INVALID_TRANSITION') {
            // The checks found something new since the dialog opened: show the current state.
            setNotice(conflict.message);
            void reload(invoice.id).then(changed, () => undefined);
            return;
          }
          toast.danger(error.message);
        },
      },
    );
  }

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="md" scroll="outside">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Approve this invoice?</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-6 py-4">
            {notice !== null && <p className="text-danger">{notice}</p>}
            {vendorMissing ? (
              <Step title="Vendor">
                <p className="text-muted">
                  No vendor matched
                  {invoice.vendorName === null ? '' : ` “${invoice.vendorName}”`}. Link it before
                  approving.
                </p>
                <VendorLinker invoice={invoice} onLinked={changed} onStale={onStale} />
              </Step>
            ) : (
              initial.vendor === null && (
                <p>
                  Vendor: <span className="font-medium">{invoice.vendor?.name}</span>
                </p>
              )
            )}

            {!vendorMissing && firstSeen && (
              <Step title="New bank details">
                <p className="text-muted">
                  These are the first bank details seen for {invoice.vendor?.name}.
                </p>
                <BankDetailsBlock invoice={invoice} />
                <Checkbox isSelected={trust} onChange={setTrust}>
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    Trust these bank details for {invoice.vendor?.name}
                  </Checkbox.Content>
                  <Description>Only if you have confirmed them with the vendor.</Description>
                </Checkbox>
              </Step>
            )}

            {!vendorMissing && bankUnknown && (
              <Step title="Bank details">
                <p className="font-medium text-danger">{BANK_UNKNOWN_TEXT}</p>
                <BankDetailsBlock invoice={invoice} />
              </Step>
            )}

            {!vendorMissing && errors.length > 0 && (
              <Step title={otherErrors.length > 0 ? 'Problems found' : 'Approve anyway?'}>
                {otherErrors.length > 0 && <ErrorList flags={otherErrors} />}
                <ConfirmCheckbox isSelected={confirm} onChange={setConfirm}>
                  I’ve checked these and want to approve anyway
                </ConfirmCheckbox>
              </Step>
            )}

            {!vendorMissing && errors.length === 0 && !firstSeen && (
              <p className="text-muted">Nothing else needs a decision.</p>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={onClose}>
              Cancel
            </Button>
            <Button onPress={approve} isDisabled={!canApprove} isPending={action.isPending}>
              {action.isPending ? 'Approving…' : 'Approve'}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** Mark paid: the date (today by default, never later), reference and note; a last look at the payee. */
export function MarkPaidDialog({
  invoice: initial,
  onClose,
  onPaid,
  onStale,
}: {
  invoice: InvoiceDetail;
  onClose: () => void;
  onPaid: (invoice: InvoiceDetail) => void;
  onStale: () => void;
}) {
  const today = businessToday();
  const [invoice, setInvoice] = useState(initial);
  const [paidAt, setPaidAt] = useState(today);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [dateError, setDateError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useInvoiceAction(invoice.id);
  const errors = errorFlags(invoice);
  const bank = invoice.bankDetails;

  function markPaid() {
    setNotice(null);
    if (paidAt === '') {
      setDateError('Enter the payment date');
      return;
    }
    if (paidAt > today) {
      setDateError('The payment date can’t be after today');
      return;
    }
    setDateError(null);
    action.mutate(
      {
        kind: 'markPaid',
        body: {
          version: invoice.version,
          paidAt,
          paymentReference: reference,
          paymentNote: note,
          ...(errors.length > 0 ? { confirmErrors: confirm } : {}),
        },
      },
      {
        onSuccess: onPaid,
        onError: (error) => {
          const conflict = conflictOf(error);
          if (conflict?.code === 'STALE') {
            onStale();
            return;
          }
          if (conflict?.code === 'CONFIRM_REQUIRED') {
            setNotice(conflict.message);
            setConfirm(false);
            void reload(invoice.id).then(setInvoice, () => undefined);
            return;
          }
          const issue = validationIssuesOf(error).find((i) => i.path === 'paidAt');
          if (issue) setDateError(issue.message);
          else toast.danger(error.message);
        },
      },
    );
  }

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="md" scroll="outside">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Mark as paid</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-5 py-4">
            {notice !== null && <p className="text-danger">{notice}</p>}
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted">Amount</dt>
              <dd className="tabular font-semibold">
                {invoice.amountDue === null
                  ? '—'
                  : `${formatMoney(invoice.amountDue)} ${invoice.amountDueCurrency ?? ''}`}
              </dd>
              <dt className="text-muted">Beneficiary</dt>
              <dd className="break-words">{bank?.beneficiary ?? '—'}</dd>
              {bank !== null && (bank.iban ?? bank.accountNumber) !== null && (
                <>
                  <dt className="text-muted">{bank.iban === null ? 'Account' : 'IBAN'}</dt>
                  <dd className="font-mono break-all">{bank.iban ?? bank.accountNumber}</dd>
                </>
              )}
            </dl>
            <DateInput
              label="Paid on"
              value={paidAt}
              onChange={(value) => {
                setPaidAt(value);
                setDateError(null);
              }}
              maxValue={today}
              isInvalid={dateError !== null}
              error={dateError ?? undefined}
              className="max-w-56"
            />
            <TextField value={reference} onChange={setReference} className="flex flex-col gap-1.5">
              <Label>Payment reference</Label>
              <Input className="font-mono" spellCheck={false} />
              <Description>As on the bank transfer, if there is one.</Description>
            </TextField>
            <TextField value={note} onChange={setNote} className="flex flex-col gap-1.5">
              <Label>Note</Label>
              <TextArea rows={2} />
            </TextField>
            {errors.length > 0 && (
              <Step title="Problems found">
                <ErrorList flags={errors} />
                <ConfirmCheckbox isSelected={confirm} onChange={setConfirm}>
                  I’ve checked these and want to mark it paid anyway
                </ConfirmCheckbox>
              </Step>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={onClose}>
              Cancel
            </Button>
            <Button
              onPress={markPaid}
              isDisabled={errors.length > 0 && !confirm}
              isPending={action.isPending}
            >
              {action.isPending ? 'Saving…' : 'Mark paid'}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

const REASONS = rejectionReasonSchema.options;

/** Reject with a reason (Duplicate preselected for a duplicate); a note is required for Other. */
export function RejectDialog({
  invoice,
  hasUnsavedChanges,
  onClose,
  onRejected,
  onStale,
}: {
  invoice: InvoiceDetail;
  hasUnsavedChanges: boolean;
  onClose: () => void;
  onRejected: (invoice: InvoiceDetail) => void;
  onStale: () => void;
}) {
  const duplicate = invoice.flags.some(
    (flag) => flag.code === 'DUPLICATE_FILE' || flag.code === 'DUPLICATE_NUMBER',
  );
  const [reason, setReason] = useState<RejectionReason | null>(duplicate ? 'duplicate' : null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState(false);
  const action = useInvoiceAction(invoice.id);

  function reject() {
    if (reason === null) {
      setReasonError(true);
      return;
    }
    if (reason === 'other' && note.trim() === '') {
      setNoteError('Say why it is rejected');
      return;
    }
    action.mutate(
      { kind: 'reject', body: { version: invoice.version, reason, note } },
      {
        onSuccess: onRejected,
        onError: (error) => {
          if (conflictOf(error)?.code === 'STALE') {
            onStale();
            return;
          }
          const issue = validationIssuesOf(error).find((i) => i.path === 'note');
          if (issue) setNoteError(issue.message);
          else toast.danger(error.message);
        },
      },
    );
  }

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="md">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Reject this invoice?</Modal.Heading>
            <p className="text-muted">It won’t be paid. You can reopen it later.</p>
          </Modal.Header>
          <Modal.Body className="space-y-5 py-4">
            <RadioGroup
              value={reason}
              onChange={(value) => {
                const parsed = rejectionReasonSchema.safeParse(value);
                if (parsed.success) setReason(parsed.data);
                setReasonError(false);
                setNoteError(null);
              }}
              isInvalid={reasonError}
            >
              <Label>Reason</Label>
              {REASONS.map((value) => (
                <Radio key={value} value={value}>
                  <Radio.Content>
                    <Radio.Control>
                      <Radio.Indicator />
                    </Radio.Control>
                    {REJECTION_REASON_LABELS[value]}
                  </Radio.Content>
                </Radio>
              ))}
              <FieldError>{reasonError ? 'Choose a reason' : undefined}</FieldError>
            </RadioGroup>
            <TextField
              value={note}
              onChange={(value) => {
                setNote(value);
                setNoteError(null);
              }}
              isInvalid={noteError !== null}
              isRequired={reason === 'other'}
              validationBehavior="aria"
              className="flex flex-col gap-1.5"
            >
              <Label>Note</Label>
              <TextArea rows={3} />
              <Description>
                {reason === 'other' ? 'Required: say why.' : 'Optional: anything worth keeping.'}
              </Description>
              <FieldError>{noteError}</FieldError>
            </TextField>
            {hasUnsavedChanges && (
              <p className="text-caution">Your unsaved changes will be discarded.</p>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={onClose}>
              Cancel
            </Button>
            <Button variant="danger" onPress={reject} isPending={action.isPending}>
              {action.isPending ? 'Rejecting…' : 'Reject'}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** A plain confirmation (re-extract, leaving with unsaved changes). */
export function ConfirmDialog({
  isOpen,
  title,
  body,
  confirmLabel,
  pendingLabel,
  isPending,
  danger,
  onConfirm,
  onCancel,
  cancelLabel = 'Cancel',
}: {
  isOpen: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  isPending?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  return (
    <AlertDialog.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Heading>{title}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>{body}</AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="ghost" onPress={onCancel}>
              {cancelLabel}
            </Button>
            <Button
              variant={danger ? 'danger' : 'primary'}
              onPress={onConfirm}
              isPending={isPending}
            >
              {isPending && pendingLabel !== undefined ? pendingLabel : confirmLabel}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

import type { InvoiceDetail } from '@camex/shared';
import {
  type DatePhrase,
  disputePhrase,
  duePhrase,
  formatDay,
  formatDayInSentence,
} from '@/lib/format';
import { REJECTION_REASON_LABELS } from '@/lib/invoice-labels';

/** The Tbilisi day of a timestamp, 'YYYY-MM-DD'. */
function tbilisiDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tbilisi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** "Approved by Nino on Sat 3 Oct", "yesterday", … (the day in a sentence, without "on" for words). */
function onDay(iso: string, today: string): string {
  return formatDayInSentence(tbilisiDay(iso), today);
}

/**
 * The invoice's state in one line of words: "Dispute window ends Tue 6 Oct · Due Fri 9 Oct",
 * "Approved by Nino on Sat 3 Oct · Due Fri 9 Oct", "Paid today · ref TRX-2291".
 */
export function stateLine(invoice: InvoiceDetail, today: string): DatePhrase[] {
  const parts: DatePhrase[] = [];
  const due = invoice.dueDate;
  switch (invoice.status) {
    case 'processing':
      // The status word and the pane already say it is being read.
      return [];
    case 'needs_review': {
      // The same words as Home and the list ("Dispute window closes Tue 6 Oct").
      if (invoice.disputeDeadline !== null)
        parts.push(disputePhrase(invoice.disputeDeadline, today));
      if (due !== null) parts.push({ text: `Due ${formatDay(due, today)}`, tone: null });
      if (parts.length === 0) {
        parts.push({ text: `Received ${onDay(invoice.email.receivedAt, today)}`, tone: null });
      }
      return parts;
    }
    case 'unpaid': {
      if (invoice.approvedAt !== null) {
        const by = invoice.approvedBy === null ? '' : ` by ${invoice.approvedBy.name}`;
        parts.push({ text: `Approved${by} ${onDay(invoice.approvedAt, today)}`, tone: null });
      }
      parts.push(due === null ? { text: 'No due date', tone: null } : duePhrase(due, today));
      return parts;
    }
    case 'paid': {
      if (invoice.paidAt !== null) {
        parts.push({ text: `Paid ${formatDayInSentence(invoice.paidAt, today)}`, tone: null });
      }
      if (invoice.paymentReference !== null) {
        parts.push({ text: `ref ${invoice.paymentReference}`, tone: null });
      }
      return parts;
    }
    case 'rejected': {
      const by = invoice.rejectedBy === null ? '' : ` by ${invoice.rejectedBy.name}`;
      const when = invoice.rejectedAt === null ? '' : ` ${onDay(invoice.rejectedAt, today)}`;
      const reason =
        invoice.rejectionReason === null
          ? ''
          : `: ${REJECTION_REASON_LABELS[invoice.rejectionReason].toLowerCase()}`;
      return [{ text: `Rejected${by}${when}${reason}`, tone: null }];
    }
  }
}

// What needs attention, in plain words (Home, T05b §3). Pure functions over the dashboard data,
// tested with Node's runner (attention.test.ts); no `@/` imports.
import { type AttentionItem, type DashboardAttention, DISPUTE_SOON_DAYS } from '@camex/shared';
import {
  type DatePhrase,
  dayDiff,
  disputePhrase,
  duePhrase,
  formatDayInSentence,
  plural,
} from './format.ts';

/** A piece of the status sentence; a number (or its noun) links to the matching list. */
export interface SentencePart {
  text: string;
  href?: string;
  /** Red for act now, amber for act soon; links without a tone use the primary colour. */
  tone?: 'warning' | 'caution';
}

export type Sentence = SentencePart[];

export const NOTHING_NEEDS_ATTENTION = 'Nothing needs attention.';

/** List links behind the sentence's numbers (the invoices list keeps its state in the URL). */
export const ATTENTION_LINKS = {
  toReview: '/invoices',
  toPay: '/invoices?status=unpaid',
  overdue: '/invoices?status=unpaid&due=overdue',
  dueSoon: '/invoices?status=unpaid&due=soon',
  extractionFailed: '/invoices?extraction=failed',
} as const;

type SentenceData = Pick<
  DashboardAttention,
  | 'disputeSoonCount'
  | 'nextDisputeDeadline'
  | 'overdueCount'
  | 'dueSoonCount'
  | 'extractionFailedCount'
> & { toReviewCount: number };

/**
 * The Home status sentence: only the clauses with something to say, in this order —
 * invoices to review (and the most urgent dispute deadline), overdue payments (else payments
 * due this week), extraction failures. "Nothing needs attention." when there is nothing.
 */
export function statusSentences(data: SentenceData, today: string): Sentence[] {
  const sentences: Sentence[] = [];

  if (data.toReviewCount > 0) {
    sentences.push([
      { text: plural(data.toReviewCount, 'invoice', 'invoices'), href: ATTENTION_LINKS.toReview },
      { text: ' to review.' },
    ]);
  }
  if (data.disputeSoonCount > 0 && data.nextDisputeDeadline !== null) {
    const when = formatDayInSentence(data.nextDisputeDeadline, today);
    sentences.push(
      data.disputeSoonCount === 1
        ? [
            { text: 'A dispute window', href: ATTENTION_LINKS.toReview, tone: 'caution' },
            { text: ` closes ${when}.` },
          ]
        : [
            {
              text: plural(data.disputeSoonCount, 'dispute window', 'dispute windows'),
              href: ATTENTION_LINKS.toReview,
              tone: 'caution',
            },
            { text: ` close soon, the first ${when}.` },
          ],
    );
  }

  if (data.overdueCount > 0) {
    sentences.push([
      {
        text: plural(data.overdueCount, 'payment', 'payments'),
        href: ATTENTION_LINKS.overdue,
        tone: 'warning',
      },
      { text: data.overdueCount === 1 ? ' is overdue.' : ' are overdue.' },
    ]);
  } else if (data.dueSoonCount > 0) {
    sentences.push([
      {
        text: plural(data.dueSoonCount, 'payment', 'payments'),
        href: ATTENTION_LINKS.dueSoon,
        tone: 'caution',
      },
      { text: data.dueSoonCount === 1 ? ' is due this week.' : ' are due this week.' },
    ]);
  }

  if (data.extractionFailedCount > 0) {
    sentences.push([
      {
        text: plural(data.extractionFailedCount, 'invoice', 'invoices'),
        href: ATTENTION_LINKS.extractionFailed,
        tone: 'warning',
      },
      { text: " couldn't be read." },
    ]);
  }

  return sentences.length > 0 ? sentences : [[{ text: NOTHING_NEEDS_ATTENTION }]];
}

/** The sentences as plain text (tests, the page title). */
export function sentenceText(sentences: Sentence[]): string {
  return sentences.map((parts) => parts.map((part) => part.text).join('')).join(' ');
}

/** The one line under a row of a Home panel; `reading` rows show a spinner instead of a tone. */
export interface Reason extends DatePhrase {
  reading?: boolean;
}

/**
 * Why an invoice to review needs a look, the most urgent first: a dispute window that has
 * closed or closes within 3 days, a failed extraction, the first error flag, a later dispute
 * deadline. "Reading…" while it is still being extracted.
 */
export function reviewReason(item: AttentionItem, today: string): Reason {
  if (item.status === 'processing') return { text: 'Reading…', tone: null, reading: true };
  const deadline = item.disputeDeadline;
  if (deadline !== null && dayDiff(today, deadline) <= DISPUTE_SOON_DAYS) {
    return disputePhrase(deadline, today);
  }
  if (item.extractionStatus === 'failed') {
    return { text: "Couldn't read the PDF: enter the details by hand", tone: 'warning' };
  }
  if (item.errorMessage !== null) return { text: item.errorMessage, tone: 'warning' };
  if (deadline !== null) return disputePhrase(deadline, today);
  return { text: 'Nothing flagged', tone: null };
}

/** When an invoice to pay is due: 'Overdue 18 days', 'Due Fri 9 Oct', or 'No due date'. */
export function payReason(item: AttentionItem, today: string): Reason {
  return item.dueDate === null
    ? { text: 'No due date', tone: null }
    : duePhrase(item.dueDate, today);
}

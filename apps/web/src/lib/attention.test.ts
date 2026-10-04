// Unit tests for lib/attention.ts (`pnpm --filter @camex/web test`, Node's test runner).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AttentionItem } from '@camex/shared';
import {
  ATTENTION_LINKS,
  NOTHING_NEEDS_ATTENTION,
  payReason,
  reviewReason,
  sentenceText,
  statusSentences,
} from './attention.ts';

// Sunday 4 October 2026 in Tbilisi.
const TODAY = '2026-10-04';

const NOTHING: Parameters<typeof statusSentences>[0] = {
  toReviewCount: 0,
  disputeSoonCount: 0,
  nextDisputeDeadline: null,
  overdueCount: 0,
  dueSoonCount: 0,
  extractionFailedCount: 0,
};

function text(data: Partial<typeof NOTHING>): string {
  return sentenceText(statusSentences({ ...NOTHING, ...data }, TODAY));
}

void describe('statusSentences', () => {
  void it('says nothing needs attention, without links or colour, when nothing does', () => {
    const sentences = statusSentences(NOTHING, TODAY);
    assert.deepEqual(sentences, [[{ text: NOTHING_NEEDS_ATTENTION }]]);
    assert.equal(sentenceText(sentences), 'Nothing needs attention.');
  });

  void it('builds the example from the task, clause by clause in order', () => {
    assert.equal(
      text({
        toReviewCount: 3,
        disputeSoonCount: 1,
        nextDisputeDeadline: '2026-10-05',
        overdueCount: 2,
      }),
      '3 invoices to review. A dispute window closes tomorrow. 2 payments are overdue.',
    );
  });

  void it('pluralises every clause', () => {
    assert.equal(text({ toReviewCount: 1 }), '1 invoice to review.');
    assert.equal(text({ toReviewCount: 1234 }), '1,234 invoices to review.');
    assert.equal(text({ overdueCount: 1 }), '1 payment is overdue.');
    assert.equal(text({ dueSoonCount: 1 }), '1 payment is due this week.');
    assert.equal(text({ dueSoonCount: 4 }), '4 payments are due this week.');
    assert.equal(text({ extractionFailedCount: 1 }), "1 invoice couldn't be read.");
    assert.equal(text({ extractionFailedCount: 2 }), "2 invoices couldn't be read.");
  });

  void it('names the most urgent dispute deadline', () => {
    const one = { toReviewCount: 1, disputeSoonCount: 1 };
    assert.equal(
      text({ ...one, nextDisputeDeadline: '2026-10-04' }),
      '1 invoice to review. A dispute window closes today.',
    );
    assert.equal(
      text({ ...one, nextDisputeDeadline: '2026-10-07' }),
      '1 invoice to review. A dispute window closes on Wed\u00a07\u00a0Oct.',
    );
    assert.equal(
      text({ toReviewCount: 4, disputeSoonCount: 2, nextDisputeDeadline: '2026-10-05' }),
      '4 invoices to review. 2 dispute windows close soon, the first tomorrow.',
    );
  });

  void it('mentions payments due this week only when none is overdue', () => {
    assert.equal(text({ overdueCount: 2, dueSoonCount: 5 }), '2 payments are overdue.');
    assert.equal(text({ dueSoonCount: 5 }), '5 payments are due this week.');
  });

  void it('links each number to the matching list, coloured by urgency', () => {
    const sentences = statusSentences(
      {
        toReviewCount: 3,
        disputeSoonCount: 1,
        nextDisputeDeadline: '2026-10-05',
        overdueCount: 2,
        dueSoonCount: 0,
        extractionFailedCount: 1,
      },
      TODAY,
    );
    const links = sentences.flatMap((parts) =>
      parts
        .filter((part) => part.href !== undefined)
        .map(({ text, href, tone }) => ({ text, href, tone })),
    );
    assert.deepEqual(links, [
      { text: '3 invoices', href: ATTENTION_LINKS.toReview, tone: undefined },
      { text: 'A dispute window', href: ATTENTION_LINKS.toReview, tone: 'caution' },
      { text: '2 payments', href: ATTENTION_LINKS.overdue, tone: 'warning' },
      { text: '1 invoice', href: ATTENTION_LINKS.extractionFailed, tone: 'warning' },
    ]);
    assert.equal(ATTENTION_LINKS.overdue, '/invoices?status=unpaid&due=overdue');
    assert.equal(ATTENTION_LINKS.extractionFailed, '/invoices?extraction=failed');
    assert.equal(ATTENTION_LINKS.dueSoon, '/invoices?status=unpaid&due=soon');
  });
});

function item(data: Partial<AttentionItem>): AttentionItem {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    status: 'needs_review',
    extractionStatus: 'succeeded',
    vendorName: 'AEG Fuels',
    amountDue: '6461.29',
    amountDueCurrency: 'USD',
    dueDate: null,
    disputeDeadline: null,
    errorMessage: null,
    ...data,
  };
}

void describe('panel reasons', () => {
  void it('to review: a closing or closed dispute window comes first', () => {
    const due = item({ disputeDeadline: '2026-10-05', errorMessage: 'Due date is missing' });
    assert.deepEqual(reviewReason(due, TODAY), {
      text: 'Dispute window closes tomorrow',
      tone: 'caution',
    });
    assert.deepEqual(reviewReason(item({ disputeDeadline: '2026-10-01' }), TODAY), {
      text: 'Dispute window closed 3 days ago',
      tone: 'warning',
    });
  });

  void it('to review: then a failed extraction, then the first error flag', () => {
    assert.equal(
      reviewReason(item({ extractionStatus: 'failed', errorMessage: 'Extraction failed' }), TODAY)
        .text,
      "Couldn't read the PDF: enter the details by hand",
    );
    assert.deepEqual(reviewReason(item({ errorMessage: 'Due date is missing' }), TODAY), {
      text: 'Due date is missing',
      tone: 'warning',
    });
  });

  void it('to review: a later dispute deadline, nothing flagged, or still reading', () => {
    assert.deepEqual(reviewReason(item({ disputeDeadline: '2026-10-20' }), TODAY), {
      text: 'Dispute window closes 20 Oct 2026',
      tone: null,
    });
    assert.deepEqual(reviewReason(item({}), TODAY), { text: 'Nothing flagged', tone: null });
    assert.deepEqual(
      reviewReason(item({ status: 'processing', extractionStatus: 'pending' }), TODAY),
      {
        text: 'Reading…',
        tone: null,
        reading: true,
      },
    );
  });

  void it('to pay: overdue, due soon, later, or no due date', () => {
    const pay = (dueDate: string | null) => payReason(item({ status: 'unpaid', dueDate }), TODAY);
    assert.deepEqual(pay('2026-09-16'), { text: 'Overdue 18 days', tone: 'warning' });
    assert.deepEqual(pay('2026-10-09'), { text: 'Due Fri 9 Oct', tone: 'caution' });
    assert.deepEqual(pay('2026-11-30'), { text: 'Due 30 Nov 2026', tone: null });
    assert.deepEqual(pay(null), { text: 'No due date', tone: null });
  });
});

// Unit tests for list-params.ts (`pnpm --filter @camex/web test`, Node's test runner).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arrivalStatus, isArrival } from './list-params.ts';

void describe('isArrival', () => {
  void it('is the plain list reached from elsewhere (sidebar, after the last review)', () => {
    assert.equal(isArrival(new URLSearchParams(), false), true);
  });

  void it('is not a URL with a query (a tab, a filter or a page was asked for)', () => {
    for (const query of ['status=paid', 'extraction=failed', 'vendorId=x', 'page=2']) {
      assert.equal(isArrival(new URLSearchParams(query), false), false, query);
    }
  });

  void it('is not a history entry the list made itself (the To review tab was clicked)', () => {
    assert.equal(isArrival(new URLSearchParams(), true), false);
  });
});

void describe('arrivalStatus', () => {
  void it('opens To pay when nothing is left to review but something is to pay', () => {
    assert.equal(arrivalStatus({ needs_review: 0, unpaid: 3 }), 'unpaid');
  });

  void it('stays on To review while anything is to review (processing included in the count)', () => {
    assert.equal(arrivalStatus({ needs_review: 1, unpaid: 3 }), 'needs_review');
  });

  void it('stays on To review when both are empty', () => {
    assert.equal(arrivalStatus({ needs_review: 0, unpaid: 0 }), 'needs_review');
  });
});

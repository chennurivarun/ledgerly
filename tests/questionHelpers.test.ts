// Copy pins + client-side scope math for the Dashboard's "Getting to know
// you" card. The parity suite is the important one: the client's grouping
// key must agree byte-for-byte with the server's, or the checkbox would
// promise a different count than the answer endpoint delivers.
import { describe, expect, it } from 'vitest';
import { NEEDS_REVIEW } from '../shared/types';
import {
  answeredMessage,
  applyExistingLabel,
  countNeedsReview,
  questionMerchantKey,
  questionPrompt,
} from '../src/components/questions/questionHelpers';
import { normalizeQuestionMerchant } from '../worker/questions';

describe('question copy', () => {
  it('pins the question line, currency formatted by the house formatter', () => {
    expect(questionPrompt({ merchant: 'Ravi Kumar', txCount: 4, total: 1240.5 })).toBe(
      "You've paid 'Ravi Kumar' 4 times ($1,240.50). Who is this?",
    );
  });

  it('does not lie about a singular count, even though the threshold prevents it', () => {
    expect(questionPrompt({ merchant: 'KFC', txCount: 1, total: 12 })).toBe(
      "You've paid 'KFC' 1 time ($12.00). Who is this?",
    );
  });

  it('pins the success toast', () => {
    expect(answeredMessage('Mom', 'Transfers')).toBe("Got it — 'Mom' filed under Transfers.");
  });

  it('pins the apply-to-existing checkbox label, singular and plural', () => {
    expect(applyExistingLabel(3)).toBe("Also apply to 3 existing 'Needs review' transactions");
    expect(applyExistingLabel(1)).toBe("Also apply to 1 existing 'Needs review' transaction");
  });
});

describe('countNeedsReview — the checkbox count matches the server scope', () => {
  const LEDGER = [
    { merchant: 'UPI-RAVI KUMAR-ravik@okaxis-402934857382', category: NEEDS_REVIEW },
    { merchant: 'UPI-Ravi Kumar-ravik@okhdfcbank', category: NEEDS_REVIEW },
    { merchant: 'Ravi Kumar', category: 'Dining' }, // grounded — server would not touch it
    { merchant: 'Zomato', category: NEEDS_REVIEW }, // different merchant
  ];

  it('counts only Needs-review rows whose cleaned key matches the question', () => {
    expect(countNeedsReview(LEDGER, 'ravi kumar')).toBe(2);
    expect(countNeedsReview(LEDGER, 'zomato')).toBe(1);
    expect(countNeedsReview(LEDGER, 'kfc')).toBe(0);
  });
});

describe('key parity with the server', () => {
  it('questionMerchantKey and normalizeQuestionMerchant agree on every spelling', () => {
    const spellings = [
      'UPI-RAVI KUMAR-ravik@okaxis-402934857382',
      'UPI-Ravi Kumar-ravik@okhdfcbank',
      'Ravi Kumar',
      'POS SWIGGY LIMITED 402934857382',
      'KFC',
      'PhonePe',
      'BY TRANSFER-NEFT-HDFC0001234-ACME CORP SALARY',
      '  NETFLIX.COM  ',
    ];
    for (const raw of spellings) {
      expect(questionMerchantKey(raw)).toBe(normalizeQuestionMerchant(raw));
    }
  });
});

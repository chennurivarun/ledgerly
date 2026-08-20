// Kotak Mahindra Bank — savings account statement (the commons' reference
// pack, S18). Authored from the layout of a real statement; contains ONLY
// layout knowledge — no statement content, no customer data, ever.
//
// Layout notes (why the grammar looks like this):
// - Rows are serial-numbered and carry a running balance — both verification
//   chains apply. The text layer flattens the Withdrawal/Deposit columns into
//   ONE amount token, so direction comes from the balance delta.
// - Descriptions wrap across up to 3 lines (even mid-reference-token); the
//   row closes on the line whose END carries `<amount>  <balance>`.
// - Column gaps flatten to runs of 2+ spaces; single spaces occur inside
//   descriptions — every column anchor uses \s{2,}.
// - Amounts use Indian digit grouping (1,25,000.00); the engine strips
//   commas, so the grammar just accepts digit-comma runs.
// - Every page repeats the section title and the column header; page footers
//   ("Statement Generated on …", "Page N of N") can interleave a wrapped
//   row — all four are furniture.
import type { StatementPack } from '../spec';

export const inKotakSavings: StatementPack = {
  spec: 1,
  id: 'in.kotak.savings',
  name: 'Kotak Mahindra Bank — Savings',
  country: 'in',
  currency: 'INR',
  signature: [
    '^Account Statement\\b',
    'IFSC Code\\s+KKBK',
    '^#\\s{2,}Date\\s{2,}Description\\s{2,}Chq/Ref\\. No\\.\\s{2,}Withdrawal \\(Dr\\.\\)\\s{2,}Deposit \\(Cr\\.\\)\\s{2,}Balance\\s*$',
  ],
  dateFormat: 'dd MMM yyyy',
  direction: 'balance-delta',
  verify: ['serial-chain', 'balance-chain'],
  table: {
    headerLine: '^#\\s{2,}Date\\s{2,}Description\\b',
    openingBalanceLine:
      '^-\\s{2,}-\\s{2,}Opening Balance\\s{2,}-\\s{2,}-\\s{2,}-\\s{2,}(?<balance>[\\d,]+\\.\\d{2})\\s*$',
    rowStart:
      '^(?<serial>\\d{1,5})\\s{2,}(?<date>\\d{2} [A-Z][a-z]{2} \\d{4})\\s{2,}(?<rest>.*\\S)\\s*$',
    rowTail: '(?:^|\\s)(?<amount>[\\d,]+\\.\\d{2})\\s{2,}(?<balance>[\\d,]+\\.\\d{2})\\s*$',
    furniture: [
      '^Savings Account Transactions\\s*$',
      '^Statement Generated on ',
      '^Page \\d+ of \\d+\\s*$',
    ],
  },
};

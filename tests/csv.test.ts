import { describe, expect, it } from 'vitest';
import { detectMapping, normalizeDate, parseCsv, rowsToTransactions } from '../shared/csv';

describe('parseCsv', () => {
  it('parses a simple comma-separated file', () => {
    const table = parseCsv('date,description,amount\n2026-01-01,Coffee,4.50\n2026-01-02,Rent,1000\n');
    expect(table.headers).toEqual(['date', 'description', 'amount']);
    expect(table.rows).toEqual([
      ['2026-01-01', 'Coffee', '4.50'],
      ['2026-01-02', 'Rent', '1000'],
    ]);
  });

  it('handles quoted fields containing commas', () => {
    const table = parseCsv('date,description,amount\n2026-01-01,"Coffee, Tea & Co.",4.50\n');
    expect(table.rows[0]).toEqual(['2026-01-01', 'Coffee, Tea & Co.', '4.50']);
  });

  it('handles escaped double quotes inside quoted fields', () => {
    const table = parseCsv('date,description,amount\n2026-01-01,"Bob""s Diner",12.00\n');
    expect(table.rows[0]).toEqual(['2026-01-01', 'Bob"s Diner', '12.00']);
  });

  it('handles newlines inside quoted fields', () => {
    const table = parseCsv('date,description,amount\n2026-01-01,"Line one\nLine two",5.00\n');
    expect(table.rows[0]).toEqual(['2026-01-01', 'Line one\nLine two', '5.00']);
  });

  it('handles CRLF line endings', () => {
    const table = parseCsv('date,description,amount\r\n2026-01-01,Coffee,4.50\r\n2026-01-02,Rent,1000\r\n');
    expect(table.headers).toEqual(['date', 'description', 'amount']);
    expect(table.rows).toEqual([
      ['2026-01-01', 'Coffee', '4.50'],
      ['2026-01-02', 'Rent', '1000'],
    ]);
  });

  it('handles bare LF line endings', () => {
    const table = parseCsv('date,description,amount\n2026-01-01,Coffee,4.50\n');
    expect(table.rows).toEqual([['2026-01-01', 'Coffee', '4.50']]);
  });

  it('skips blank lines', () => {
    const table = parseCsv('date,description,amount\n2026-01-01,Coffee,4.50\n\n\n2026-01-02,Rent,1000\n');
    expect(table.rows).toEqual([
      ['2026-01-01', 'Coffee', '4.50'],
      ['2026-01-02', 'Rent', '1000'],
    ]);
  });

  it('trims unquoted cells but preserves quoted content verbatim', () => {
    const table = parseCsv('date,description,amount\n2026-01-01,  Coffee  ,4.50\n2026-01-02,"  Padded  ",1.00\n');
    expect(table.rows[0]).toEqual(['2026-01-01', 'Coffee', '4.50']);
    expect(table.rows[1]).toEqual(['2026-01-02', '  Padded  ', '1.00']);
  });

  it('handles a file with no trailing newline', () => {
    const table = parseCsv('date,description,amount\n2026-01-01,Coffee,4.50');
    expect(table.rows).toEqual([['2026-01-01', 'Coffee', '4.50']]);
  });

  it('returns empty table for empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
    expect(parseCsv('\n\n')).toEqual({ headers: [], rows: [] });
  });

  it('opens a quoted field even when preceded by whitespace after the delimiter', () => {
    // Regression: a space after the comma (common in hand-edited exports)
    // must not prevent the quote from opening, or the quote character and
    // the internal comma leak into the parsed cells.
    const table = parseCsv('Date,Description,Amount\n2026-01-01, "Coffee, Tea & Co.", -4.50\n');
    expect(table.rows[0]).toEqual(['2026-01-01', 'Coffee, Tea & Co.', '-4.50']);
  });

  it('flags truncated when a quoted field is never closed', () => {
    const table = parseCsv(
      'date,description,amount\n2026-01-01,"Unterminated field,4.50\n2026-01-02,Next Row,5.00',
    );
    expect(table.truncated).toBe(true);
  });

  it('does not set truncated for well-formed input', () => {
    const table = parseCsv('date,description,amount\n2026-01-01,Coffee,4.50\n');
    expect(table.truncated).toBeUndefined();
  });
});

describe('detectMapping', () => {
  it('detects a debit/credit statement', () => {
    const mapping = detectMapping(['Date', 'Description', 'Debit', 'Credit', 'Category']);
    expect(mapping).toEqual({
      date: 0,
      description: 1,
      debit: 2,
      credit: 3,
      category: 4,
      signConvention: 'negative-expense',
    });
  });

  it('detects a single signed-amount statement', () => {
    const mapping = detectMapping(['Posted', 'Merchant', 'Amount', 'Account']);
    expect(mapping).toEqual({
      date: 0,
      description: 1,
      amount: 2,
      account: 3,
      signConvention: 'negative-expense',
    });
  });

  it('recognizes case-insensitive header synonyms', () => {
    const mapping = detectMapping(['TRANSACTION DATE', 'Payee', 'Withdrawal', 'Deposit']);
    expect(mapping).toEqual({
      date: 0,
      description: 1,
      debit: 2,
      credit: 3,
      signConvention: 'negative-expense',
    });
  });

  it('returns null when headers give no signal (no date/description column)', () => {
    expect(detectMapping(['Col1', 'Col2', 'Col3'])).toBeNull();
  });

  it('returns null when date column is missing', () => {
    expect(detectMapping(['Description', 'Amount'])).toBeNull();
  });

  it('returns null when description column is missing', () => {
    expect(detectMapping(['Date', 'Amount'])).toBeNull();
  });

  it('returns null when both amount and debit/credit columns are present (ambiguous)', () => {
    expect(detectMapping(['Date', 'Description', 'Amount', 'Debit', 'Credit'])).toBeNull();
  });

  it('returns null when neither amount nor debit/credit is present', () => {
    expect(detectMapping(['Date', 'Description', 'Category'])).toBeNull();
  });

  it('returns null when a role matches more than one column', () => {
    // 'Name' and 'Description' both match the description role — ambiguous.
    expect(detectMapping(['Date', 'Name', 'Description', 'Amount'])).toBeNull();
  });

  it('confidently infers negative-expense sign convention when a single amount column has mixed signs', () => {
    const rows = [
      ['2026-01-01', 'Coffee', '-4.50'],
      ['2026-01-02', 'Paycheck', '2000.00'],
    ];
    const mapping = detectMapping(['Date', 'Description', 'Amount'], rows);
    expect(mapping).not.toBeNull();
    expect(mapping!.signConvention).toBe('negative-expense');
    expect(mapping!.signConventionInferred).not.toBe(false);
  });

  it('flags sign convention as not confidently inferred when all sample amounts share one sign', () => {
    const rows = [
      ['2026-01-01', 'Coffee', '4.50'],
      ['2026-01-02', 'Tea', '12.00'],
    ];
    const mapping = detectMapping(['Date', 'Description', 'Amount'], rows);
    expect(mapping).not.toBeNull();
    expect(mapping!.signConventionInferred).toBe(false);
  });

  it('omits the inference flag when rows are not supplied', () => {
    const mapping = detectMapping(['Date', 'Description', 'Amount']);
    expect(mapping).not.toBeNull();
    expect(mapping!.signConventionInferred).toBeUndefined();
  });

  it('does not attempt sign inference on a debit/credit mapping', () => {
    const rows = [['2026-01-01', 'Coffee', '4.50', '']];
    const mapping = detectMapping(['Date', 'Description', 'Debit', 'Credit'], rows);
    expect(mapping).not.toBeNull();
    expect(mapping!.signConventionInferred).toBeUndefined();
  });
});

describe('rowsToTransactions', () => {
  it('honors debit/credit sign convention', () => {
    const table = parseCsv(
      'Date,Description,Debit,Credit\n2026-01-01,Coffee Shop,4.50,\n2026-01-02,Paycheck,,2000.00\n',
    );
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({ merchant: 'Coffee Shop', amount: 4.5, type: 'expense' });
    expect(result.transactions[1]).toMatchObject({ merchant: 'Paycheck', amount: 2000, type: 'income' });
    expect(result.skipped).toBe(0);
  });

  it('honors negative-expense single-amount convention', () => {
    const table = parseCsv(
      'Date,Description,Amount\n2026-01-01,Coffee Shop,-4.50\n2026-01-02,Paycheck,2000.00\n',
    );
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions[0]).toMatchObject({ merchant: 'Coffee Shop', amount: 4.5, type: 'expense' });
    expect(result.transactions[1]).toMatchObject({ merchant: 'Paycheck', amount: 2000, type: 'income' });
  });

  it('parses parenthesized negative amounts as expenses', () => {
    const table = parseCsv('Date,Description,Amount\n2026-01-01,Coffee Shop,"(4.50)"\n');
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions[0]).toMatchObject({ amount: 4.5, type: 'expense' });
  });

  it('strips $ signs and thousands separators', () => {
    const table = parseCsv('Date,Description,Amount\n2026-01-01,Big Purchase,"-$1,234.56"\n');
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions[0]).toMatchObject({ amount: 1234.56, type: 'expense' });
  });

  // Regression: with 29 non-USD currencies now first-class (sprint-2 display
  // currency setting), a statement exported from a non-US bank can carry any
  // symbol — parseAmount used to strip only `$`, so a row like "€12.34"
  // never parsed (Number("€12.34") is NaN) and was silently skipped.
  it('strips non-$ currency symbols (EUR, GBP, INR-symbol rows parse)', () => {
    const table = parseCsv(
      'Date,Description,Amount\n' +
        '2026-01-01,Bakery,"-€1,234.56"\n' +
        '2026-01-02,Pub,"-£1,234.56"\n' +
        '2026-01-03,Salary,"₹1,234.00"\n',
    );
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.skipped).toBe(0);
    expect(result.transactions[0]).toMatchObject({ merchant: 'Bakery', amount: 1234.56, type: 'expense' });
    expect(result.transactions[1]).toMatchObject({ merchant: 'Pub', amount: 1234.56, type: 'expense' });
    expect(result.transactions[2]).toMatchObject({ merchant: 'Salary', amount: 1234, type: 'income' });
  });

  it('strips a bare currency-code prefix (e.g. "CHF 1,234.56")', () => {
    const table = parseCsv('Date,Description,Amount\n2026-01-01,Watch,"-CHF 1,234.56"\n');
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions[0]).toMatchObject({ amount: 1234.56, type: 'expense' });
  });

  // Regression: currency-notation stripping is a WHITELIST (known symbols,
  // known ISO codes, whitespace) — not a blacklist of "anything that isn't a
  // digit". A blacklist would turn strict rejection into "extract any digits
  // from the string", silently misparsing a debit/credit marker, a
  // reference number, a date, or a percentage as a dollar amount. Every row
  // below must keep failing to parse.
  it('still rejects non-currency text in the amount column', () => {
    const table = parseCsv(
      'Date,Description,Amount\n' +
        '2026-01-01,Card refund,12.34DR\n' +
        '2026-01-02,Card charge,12.34CR\n' +
        '2026-01-03,Mystery,Ref 12345\n' +
        '2026-01-04,Mystery,Jan 5 2026\n' +
        '2026-01-05,Mystery,3.5%\n',
    );
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions).toHaveLength(0);
    expect(result.skipped).toBe(5);
  });

  // The leading-code pattern preserves a sign or open paren before the code,
  // so signed and parenthesized code-prefixed amounts parse like their
  // symbol-currency equivalents.
  it('parses signed and parenthesized code-prefixed amounts', () => {
    const table = parseCsv(
      'Date,Description,Amount\n' +
        '2026-01-01,Refund,+CHF 100.00\n' +
        '2026-01-02,Watch,"(CHF 1,234.00)"\n',
    );
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({ amount: 100, type: 'income' });
    expect(result.transactions[1]).toMatchObject({ amount: 1234, type: 'expense' });
  });

  it('skips unparseable rows instead of inserting placeholders', () => {
    const table = parseCsv(
      'Date,Description,Amount\nnot-a-date,Coffee Shop,-4.50\n2026-01-02,,10.00\n2026-01-03,Empty Amount,not-a-number\n2026-01-04,Good Row,-5.00\n',
    );
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].merchant).toBe('Good Row');
    expect(result.skipped).toBe(3);
  });

  it('counts rows without a supported category as needsReview', () => {
    const table = parseCsv(
      'Date,Description,Amount,Category\n2026-01-01,Coffee Shop,-4.50,Dining\n2026-01-02,Mystery Charge,-9.00,\n',
    );
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[1].category).toBe('Needs review');
    expect(result.needsReview).toBe(1);
  });

  it('preserves only supported categories when a categories list is provided (spec §8.1.6)', () => {
    const table = parseCsv(
      'Date,Description,Amount,Category\n2026-01-01,Coffee Shop,-4.50,Dining\n2026-01-02,Mystery Charge,-9.00,NotARealCategory\n',
    );
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping, {
      categories: ['Dining', 'Groceries', 'Needs review'],
    });
    expect(result.transactions[0].category).toBe('Dining');
    expect(result.transactions[1].category).toBe('Needs review');
    expect(result.needsReview).toBe(1);
  });

  it('matches supported categories case-insensitively', () => {
    const table = parseCsv('Date,Description,Amount,Category\n2026-01-01,Coffee Shop,-4.50,dining\n');
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping, { categories: ['Dining'] });
    expect(result.transactions[0].category).toBe('Dining');
    expect(result.needsReview).toBe(0);
  });

  it('keeps the raw statement category verbatim when no categories list is provided (backward compatible)', () => {
    const table = parseCsv(
      'Date,Description,Amount,Category\n2026-01-01,Coffee Shop,-4.50,SomeRandomCategory\n',
    );
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions[0].category).toBe('SomeRandomCategory');
  });

  it('treats a negative debit-column value as a refund (income)', () => {
    const table = parseCsv('Date,Description,Debit,Credit\n2026-01-01,Refund,-25.00,\n');
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({ amount: 25, type: 'income' });
  });

  it('skips a row where both debit and credit are populated (ambiguous)', () => {
    const table = parseCsv('Date,Description,Debit,Credit\n2026-01-01,Weird Row,10.00,5.00\n');
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('refuses to silently misparse decimal-comma amounts', () => {
    // "-1.234,56" is -1234.56 in EU notation; naively stripping the comma
    // as a US thousands separator would silently produce -1.23 (~1000x off).
    const table = parseCsv('Date,Description,Amount\n2026-01-01,Big Purchase,"-1.234,56"\n');
    const mapping = detectMapping(table.headers)!;
    const result = rowsToTransactions(table, mapping);
    expect(result.transactions).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });
});

describe('normalizeDate', () => {
  it('accepts ISO YYYY-MM-DD', () => {
    expect(normalizeDate('2026-03-04')).toBe('2026-03-04');
  });

  it('accepts YYYY/MM/DD', () => {
    expect(normalizeDate('2026/03/04')).toBe('2026-03-04');
  });

  it('accepts MM/DD/YYYY and M/D/YYYY', () => {
    expect(normalizeDate('03/04/2026')).toBe('2026-03-04');
    expect(normalizeDate('3/4/2026')).toBe('2026-03-04');
  });

  it('disambiguates day-first dates when the first number exceeds 12', () => {
    // 25 can't be a month, so this must be day-first: 25 Dec 2026.
    expect(normalizeDate('25-12-2026')).toBe('2026-12-25');
  });

  it('defaults ambiguous numeric dates to month-first (MM/DD/YYYY)', () => {
    // Both 3 and 4 are valid months/days; US convention wins: March 4.
    expect(normalizeDate('03-04-2026')).toBe('2026-03-04');
  });

  it('accepts textual month formats', () => {
    expect(normalizeDate('Jan 5, 2026')).toBe('2026-01-05');
    expect(normalizeDate('5 Jan 2026')).toBe('2026-01-05');
    expect(normalizeDate('05-Jan-2026')).toBe('2026-01-05');
    expect(normalizeDate('January 5 2026')).toBe('2026-01-05');
  });

  it('returns null for unparseable dates', () => {
    expect(normalizeDate('not a date')).toBeNull();
    expect(normalizeDate('')).toBeNull();
    expect(normalizeDate('13/40/2026')).toBeNull();
    expect(normalizeDate('2026-02-30')).toBeNull();
  });
});

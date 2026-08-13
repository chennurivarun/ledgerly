// cleanBankDescriptor is a TRANSFORM of printed text, never an inference:
// each rule deletes one enumerable kind of routing noise, and a cleanup that
// would destroy everything returns the original instead. Every rule is
// pinned here with realistic Indian bank descriptor shapes (the sprint-13
// field report: proposed rows showed "UPI-MERCHANT-vpa@bank-ref…" raw).
import { describe, expect, it } from 'vitest';
import { cleanBankDescriptor } from '../shared/descriptors';

describe('cleanBankDescriptor — realistic descriptors', () => {
  it('cleans a full UPI descriptor down to the merchant kernel', () => {
    expect(cleanBankDescriptor('UPI-SWIGGY LIMITED-swiggy@axis-402934857382-Payment')).toBe(
      'Swiggy Limited',
    );
  });

  it('cleans a NEFT descriptor with an IFSC code', () => {
    expect(cleanBankDescriptor('NEFT/HDFC0001234/ACME CORP SALARY')).toBe('Acme Corp Salary');
  });

  it('cleans a POS descriptor with a masked card number', () => {
    expect(cleanBankDescriptor('POS 402934XXXXXX1234 AMAZON RETAIL')).toBe('Amazon Retail');
  });

  it('leaves an already-clean mixed-case merchant untouched', () => {
    expect(cleanBankDescriptor('Netflix')).toBe('Netflix');
    expect(cleanBankDescriptor('PhonePe')).toBe('PhonePe');
  });

  // The never-guess backstop: a transform that deletes everything has proven
  // it does not understand this string, so the raw input (trimmed) comes back.
  it('returns the raw input when the descriptor is all reference numbers', () => {
    expect(cleanBankDescriptor('UPI-404850938201-857392051234')).toBe(
      'UPI-404850938201-857392051234',
    );
    expect(cleanBankDescriptor('  402934857382 000123456789  ')).toBe(
      '402934857382 000123456789',
    );
  });
});

describe('cleanBankDescriptor — channel prefixes', () => {
  for (const raw of [
    'UPI-SWIGGY',
    'UPI/SWIGGY',
    'UPI SWIGGY',
    'NEFT-SWIGGY',
    'NEFT/SWIGGY',
    'IMPS-SWIGGY',
    'IMPS/SWIGGY',
    'RTGS-SWIGGY',
    'POS SWIGGY',
    'ATM-SWIGGY',
    'ACH-SWIGGY',
    'ECS-SWIGGY',
    'upi-SWIGGY',
  ]) {
    it(`strips the channel prefix from ${JSON.stringify(raw)}`, () => {
      expect(cleanBankDescriptor(raw)).toBe('Swiggy');
    });
  }

  it('strips TO TRANSFER and BY TRANSFER, with their separators', () => {
    expect(cleanBankDescriptor('TO TRANSFER-ACME CORP')).toBe('Acme Corp');
    expect(cleanBankDescriptor('BY TRANSFER/ACME CORP')).toBe('Acme Corp');
    expect(cleanBankDescriptor('by transfer ACME CORP')).toBe('Acme Corp');
  });

  it('strips stacked rails ("BY TRANSFER-NEFT/…")', () => {
    expect(cleanBankDescriptor('BY TRANSFER-NEFT/ACME CORP')).toBe('Acme Corp');
  });

  // The prefix needs its own separator: names that merely START with the
  // letters are not channel markers.
  it('does not mistake POSH or ATMOSPHERE for channel prefixes', () => {
    expect(cleanBankDescriptor('POSH SPA')).toBe('Posh Spa');
    expect(cleanBankDescriptor('ATMOSPHERE CAFE')).toBe('Atmosphere Cafe');
  });

  it('returns the raw input when the descriptor is only a prefix', () => {
    expect(cleanBankDescriptor('UPI-')).toBe('UPI-');
    expect(cleanBankDescriptor('TO TRANSFER')).toBe('TO TRANSFER');
  });
});

describe('cleanBankDescriptor — the VPA ends the merchant kernel', () => {
  it('drops the VPA and everything after it (references, bank remarks)', () => {
    expect(cleanBankDescriptor('UPI-PhonePe-phonepe@ybl-40385920176-UPI')).toBe('PhonePe');
  });

  it('returns the raw input when the VPA is all there is', () => {
    expect(cleanBankDescriptor('merchant@ybl')).toBe('merchant@ybl');
  });
});

describe('cleanBankDescriptor — reference tokens', () => {
  it('drops digit runs of 5+ but keeps short store numbers', () => {
    expect(cleanBankDescriptor('SWIGGY 402934857382')).toBe('Swiggy');
    expect(cleanBankDescriptor('Store 1234')).toBe('Store 1234');
  });

  it('drops 8+ character tokens mixing letters and digits, anywhere', () => {
    expect(cleanBankDescriptor('ACME CORP UTIB0000059')).toBe('Acme Corp');
  });

  it('keeps pure words and short letter-digit mixes — those are names', () => {
    expect(cleanBankDescriptor('GOLD MEMBERSHIP')).toBe('Gold Membership');
    expect(cleanBankDescriptor('7Eleven Store')).toBe('7Eleven Store');
  });
});

describe('cleanBankDescriptor — separators and casing', () => {
  it('collapses repeated separators into single spaces', () => {
    expect(cleanBankDescriptor('ACME--CORP')).toBe('Acme Corp');
    expect(cleanBankDescriptor('ACME   CORP')).toBe('Acme Corp');
  });

  it('Title-Cases an all-caps or all-lower survivor', () => {
    expect(cleanBankDescriptor('SWIGGY LIMITED')).toBe('Swiggy Limited');
    expect(cleanBankDescriptor('swiggy limited')).toBe('Swiggy Limited');
  });

  it('preserves a survivor that already mixes cases', () => {
    expect(cleanBankDescriptor('UPI-McDonalds India')).toBe('McDonalds India');
  });

  it('keeps a lone short all-caps survivor as written (acronym merchants)', () => {
    expect(cleanBankDescriptor('UPI-KFC-kfc@icici-40293845')).toBe('KFC');
    expect(cleanBankDescriptor('IRCTC')).toBe('IRCTC');
  });

  it('still Title-Cases multi-word and long all-caps survivors', () => {
    expect(cleanBankDescriptor('UPI-ACME CORP SALARY-acme@sbi-11111')).toBe('Acme Corp Salary');
    expect(cleanBankDescriptor('SWIGGY')).toBe('Swiggy');
  });

  it('passes empty and whitespace-only input through trimmed', () => {
    expect(cleanBankDescriptor('')).toBe('');
    expect(cleanBankDescriptor('   ')).toBe('');
  });
});

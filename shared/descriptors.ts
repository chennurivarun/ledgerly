// Deterministic cleanup of bank-printed transaction descriptors (sprint 13).
//
// This is a TRANSFORM of text the bank printed, not an inference about the
// merchant: every rule below deletes an enumerable kind of routing noise the
// bank wrapped around the merchant's name — channel prefixes ("UPI-",
// "NEFT/"), VPA handles ("swiggy@axis"), reference numbers and bank/branch
// codes ("402934857382", "HDFC0001234"). Nothing is ever added or reordered,
// and a cleanup that would destroy the whole descriptor returns the original
// instead ("never guess": a transform that leaves nothing has proven it does
// not understand this string). Precedent: shared/detection.ts
// normalizeMerchant, which flattens the same punctuation for MATCHING — this
// module produces the DISPLAY name a statement proposal should carry, so it
// keeps casing and word order instead of lowercasing.

/**
 * Leading channel/rail markers, each requiring its own separator (`-`, `/`,
 * or whitespace) so "POSH SPA" and "ATMOSPHERE CAFE" are never mistaken for
 * "POS H SPA" / "ATM OSPHERE CAFE". Stripped in a loop: rails stack in the
 * wild ("BY TRANSFER-NEFT/…").
 */
const CHANNEL_PREFIX = /^(?:UPI|NEFT|IMPS|RTGS|POS|ATM|ACH|ECS)[-\/\s]+/i;
const TRANSFER_PREFIX = /^(?:TO|BY)\s+TRANSFER\b[-\/\s:]*/i;

/** A token that is nothing but a long digit run — a reference, not a name. */
const DIGIT_RUN = /^\d{5,}$/;

/**
 * A reference/branch code: 8+ characters of pure alphanumerics mixing letters
 * AND digits (IFSC codes like "HDFC0001234", masked card numbers like
 * "402934XXXXXX1234"). Pure words ("MEMBERSHIP") and short mixes ("7Eleven")
 * are names, not references, and survive.
 */
function isReferenceToken(token: string): boolean {
  return /^[A-Za-z0-9]{8,}$/.test(token) && /\d/.test(token) && /[A-Za-z]/.test(token);
}

function titleCaseWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Clean one bank descriptor into the name a review table should show.
 *
 * Rules, in order (each pinned by tests/descriptors.test.ts):
 *  1. strip leading channel prefixes (UPI/NEFT/IMPS/RTGS/POS/ATM/ACH/ECS,
 *     "TO TRANSFER", "BY TRANSFER"), repeatedly;
 *  2. split on the separators banks use as field delimiters (`-`, `/`,
 *     whitespace);
 *  3. a VPA token (contains `@`) ends the merchant kernel — it and everything
 *     after it is routing tail (reference numbers, bank remarks like
 *     "Payment");
 *  4. drop long digit runs (5+) and alphanumeric reference tokens;
 *  5. rejoin the survivors with single spaces (separators collapse — they
 *     were field delimiters, not name punctuation; normalizeMerchant makes
 *     the same call);
 *  6. Title-Case the survivor UNLESS it already mixes cases ("PhonePe",
 *     "Netflix" pass through untouched).
 *
 * If the rules delete everything, the raw input (trimmed) comes back — never
 * an empty string, never a guess.
 */
export function cleanBankDescriptor(raw: string): string {
  const original = raw.trim();
  if (!original) return original;

  let s = original;
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(CHANNEL_PREFIX, '').replace(TRANSFER_PREFIX, '');
  }

  let tokens = s.split(/[-\/\s]+/).filter(Boolean);

  const vpa = tokens.findIndex((t) => t.includes('@'));
  if (vpa !== -1) tokens = tokens.slice(0, vpa);

  tokens = tokens.filter((t) => !DIGIT_RUN.test(t) && !isReferenceToken(t));

  const survivor = tokens.join(' ');
  if (!survivor) return original;

  const mixedCase = /\p{Ll}/u.test(survivor) && /\p{Lu}/u.test(survivor);
  if (mixedCase) return survivor;
  // A lone short all-caps survivor is almost always an acronym merchant
  // ("KFC", "HDFC", "IRCTC") — Title-Casing it manufactures a name nobody
  // wrote. Multi-word survivors still Title-Case as a whole: mixing per-token
  // exceptions ("Acme CORP Salary") reads worse than either extreme.
  if (/^\p{Lu}{2,5}$/u.test(survivor)) return survivor;
  return survivor.split(' ').map(titleCaseWord).join(' ');
}

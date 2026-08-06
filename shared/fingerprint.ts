// Central duplicate fingerprint — the ONLY definition; every import path uses it (spec §4.4, §8.3).
export function txFingerprint(
  date: string,
  merchant: string,
  amount: number,
  account: string,
): string {
  return `${date}|${merchant.trim().toLowerCase()}|${amount.toFixed(2)}|${account.trim().toLowerCase()}`;
}

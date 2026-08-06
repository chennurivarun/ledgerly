// Pure add/remove rules for the onboarding Accounts step. Kept side-effect
// free (no store access) so the dedupe/minimum-count rules are directly unit
// testable without mounting the wizard — mirrors ManagedListSection's rules
// (trim, case-insensitive dedupe, keep at least one) but operates on a local
// draft list instead of persisting on every call (the step persists once, on
// Continue). Neither function mutates its input array.

export interface AccountListChange {
  accounts: string[];
  error: string | null;
}

export function addAccountName(accounts: string[], rawName: string): AccountListChange {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return { accounts, error: 'Enter an account name.' };
  }
  if (accounts.some((a) => a.toLowerCase() === trimmed.toLowerCase())) {
    return { accounts, error: `"${trimmed}" already exists.` };
  }
  return { accounts: [...accounts, trimmed], error: null };
}

export function removeAccountName(accounts: string[], name: string): AccountListChange {
  if (accounts.length <= 1) {
    return { accounts, error: 'Keep at least one account to continue.' };
  }
  return { accounts: accounts.filter((a) => a !== name), error: null };
}

/**
 * True when two account lists hold the same names, ignoring order — a plain
 * `array === array` / index-wise compare is order-sensitive, which made
 * "remove then re-add the same name" look like a real change and fire a
 * redundant PUT that reshuffled every account picker in the app for no
 * reason. Name comparison is exact (case-sensitive): case-insensitive dedupe
 * is already enforced by `addAccountName`, so two differently-cased entries
 * here are a genuine difference, not noise.
 */
export function accountsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((name, i) => name === sortedB[i]);
}

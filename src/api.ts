// Typed API client — the ONLY place the frontend talks to the server.
// Pages never call fetch directly; they go through the store, which calls this.
import type { Briefing } from '../shared/briefing';
import {
  WIPE_CONFIRMATION,
  type ApiErrorBody,
  type BatchInsertResult,
  type DriveSyncStatus,
  type ExtractionResult,
  type MerchantAnswerInput,
  type PatchTxInput,
  type PreferencesResult,
  type PreferencesUpdate,
  type Rule,
  type RuleSuggestionActionInput,
  type StatementConfirmInput,
  type StatementExtraction,
  type StatementPagesFinalizeInput,
  type StatementPagesRoundInput,
  type StatementPagesRoundResult,
  type StatementPreflight,
  type StatePayload,
  type Transaction,
  type TxInput,
  type UploadResult,
  type WipeResult,
} from '../shared/types';

/** Preview payload: the structured briefing plus its rendered message text. */
export interface BriefingPreview {
  briefing: Briefing;
  /** The exact plain-text message a delivery would send. */
  text: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Network error — check your connection and try again.');
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg = (body as ApiErrorBody | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export const api = {
  getState: () => request<StatePayload>('/api/state'),

  addTransactions: (txs: TxInput[]) =>
    request<BatchInsertResult>('/api/transactions', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(txs),
    }),

  patchTransaction: (id: string, patch: PatchTxInput) =>
    request<Transaction>(`/api/transactions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(patch),
    }),

  deleteTransaction: (id: string) =>
    request<{ ok: true }>(`/api/transactions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  putPreferences: (update: PreferencesUpdate) =>
    request<PreferencesResult>('/api/preferences', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(update),
    }),

  uploadDocuments: (files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    return request<UploadResult>('/api/documents', { method: 'POST', body: fd });
  },

  /** Streams original bytes via the worker — raw R2 URLs are never exposed. */
  documentDownloadUrl: (id: string) => `/api/documents/${encodeURIComponent(id)}/download`,

  deleteDocument: (id: string) =>
    request<{ ok: true }>(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getDriveSync: () => request<DriveSyncStatus>('/api/drive-sync'),

  /** Run AI extraction on a stored document. Returns the suggestion (never auto-inserts). */
  extractDocument: (id: string) =>
    request<ExtractionResult>(`/api/documents/${encodeURIComponent(id)}/extract`, {
      method: 'POST',
    }),

  /** Confirm a (possibly user-edited) extraction → creates the transaction. */
  confirmExtraction: (id: string, input: TxInput) =>
    request<BatchInsertResult>(
      `/api/documents/${encodeURIComponent(id)}/extraction/confirm`,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) },
    ),

  dismissExtraction: (id: string) =>
    request<{ ok: true }>(`/api/documents/${encodeURIComponent(id)}/extraction/dismiss`, {
      method: 'POST',
    }),

  /** What a statement read will involve — pages, batches, honest cost. */
  statementPreflight: (id: string) =>
    request<StatementPreflight>(
      `/api/documents/${encodeURIComponent(id)}/statement/preflight`,
    ),

  /** Read a PDF statement into many proposed rows. Inserts nothing. */
  extractStatement: (id: string) =>
    request<StatementExtraction>(
      `/api/documents/${encodeURIComponent(id)}/statement/extract`,
      { method: 'POST' },
    ),

  /** Claim a statement for the browser-pages read (custom provider, S16). */
  beginStatementPages: (id: string) =>
    request<{ ok: true }>(
      `/api/documents/${encodeURIComponent(id)}/statement/pages/begin`,
      { method: 'POST' },
    ),

  /** One round of browser-extracted pages → raw rows. Persists nothing. */
  statementPagesRound: (id: string, input: StatementPagesRoundInput) =>
    request<StatementPagesRoundResult>(
      `/api/documents/${encodeURIComponent(id)}/statement/pages/round`,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) },
    ),

  /** Settle a browser read through the ordinary persistence pipeline. */
  finalizeStatementPages: (id: string, input: StatementPagesFinalizeInput) =>
    request<StatementExtraction>(
      `/api/documents/${encodeURIComponent(id)}/statement/pages/finalize`,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) },
    ),

  /** Best-effort cancel of a browser read (unload/cancel). */
  abortStatementPages: (id: string) =>
    request<{ ok: true }>(
      `/api/documents/${encodeURIComponent(id)}/statement/pages/abort`,
      { method: 'POST' },
    ),

  /** Import the rows the user selected (and possibly edited). */
  confirmStatementRows: (id: string, input: StatementConfirmInput) =>
    request<BatchInsertResult>(
      `/api/documents/${encodeURIComponent(id)}/statement/confirm`,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) },
    ),

  dismissStatement: (id: string) =>
    request<{ ok: true }>(`/api/documents/${encodeURIComponent(id)}/statement/dismiss`, {
      method: 'POST',
    }),

  /** Turn a learned suggestion into a real rule. Returns the updated rule list. */
  acceptRuleSuggestion: (input: RuleSuggestionActionInput) =>
    request<{ rules: Rule[] }>('/api/rule-suggestions/accept', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    }),

  /** Suppress a suggestion; it will not be offered again for this pair. */
  dismissRuleSuggestion: (input: RuleSuggestionActionInput) =>
    request<{ ok: true }>('/api/rule-suggestions/dismiss', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    }),

  /** Answer a "Getting to know you" question: stores the merchant profile,
   * creates the rule, and optionally recategorizes existing 'Needs review' rows. */
  answerMerchantQuestion: (input: MerchantAnswerInput) =>
    request<{ rules: Rule[]; recategorized: number }>('/api/merchant-questions/answer', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    }),

  /** Suppress a merchant question; it will not be asked again. */
  dismissMerchantQuestion: (input: { merchant: string }) =>
    request<{ ok: true }>('/api/merchant-questions/dismiss', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    }),

  /** Confirm a (possibly user-edited) mail-in proposal → creates the transaction. */
  confirmInboxEmail: (id: string, input: TxInput) =>
    request<BatchInsertResult>(`/api/inbox/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    }),

  dismissInboxEmail: (id: string) =>
    request<{ ok: true }>(`/api/inbox/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }),

  /** Compute today's briefing without sending anything. */
  previewBriefing: () => request<BriefingPreview>('/api/briefings/preview'),

  /** Compute today's briefing and deliver it over WhatsApp. */
  sendBriefing: () =>
    request<{ ok: true; sentTo: string }>('/api/briefings/send', { method: 'POST' }),

  wipeAll: () =>
    request<WipeResult>('/api/state', {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: JSON.stringify({ confirm: WIPE_CONFIRMATION }),
    }),
};

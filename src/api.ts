// Typed API client — the ONLY place the frontend talks to the server.
// Pages never call fetch directly; they go through the store, which calls this.
import {
  WIPE_CONFIRMATION,
  type ApiErrorBody,
  type BatchInsertResult,
  type DriveSyncStatus,
  type PatchTxInput,
  type PreferencesResult,
  type PreferencesUpdate,
  type StatePayload,
  type Transaction,
  type TxInput,
  type UploadResult,
  type WipeResult,
} from '../shared/types';

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

  wipeAll: () =>
    request<WipeResult>('/api/state', {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: JSON.stringify({ confirm: WIPE_CONFIRMATION }),
    }),
};

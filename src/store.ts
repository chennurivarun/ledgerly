import { create } from 'zustand';
import { api } from './api';
import { setActiveCurrency } from '../shared/format';
import {
  defaultSettings,
  type BatchInsertResult,
  type DocumentMeta,
  type ExtractionResult,
  type PatchTxInput,
  type Period,
  type PreferencesUpdate,
  type Rule,
  type Settings,
  type Tag,
  type Transaction,
  type TxInput,
  type UploadResult,
} from '../shared/types';

export type ModalKind = 'add-entry' | 'import' | 'drive-sync' | null;

export interface Toast {
  id: number;
  kind: 'success' | 'error';
  message: string;
}

/** Every settings payload flows through here so display formatting follows settings.currency. */
function applySettings(s: Settings): Settings {
  setActiveCurrency(s.currency);
  return s;
}

/** Canonical ordering everywhere: newest first. Matches the server's ORDER BY. */
export function sortTransactions(txs: Transaction[]): Transaction[] {
  return [...txs].sort(
    (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
  );
}

interface AppStore {
  loaded: boolean;
  loadError: string | null;
  transactions: Transaction[];
  tags: Tag[];
  rules: Rule[];
  settings: Settings;
  documents: DocumentMeta[];
  extractions: ExtractionResult[];
  activeModal: ModalKind;
  toasts: Toast[];

  load(): Promise<void>;
  toast(kind: Toast['kind'], message: string): void;
  dismissToast(id: number): void;
  openModal(m: Exclude<ModalKind, null>): void;
  closeModal(): void;

  /** Optimistic with rollback + error toast on failure (spec §6.1.5). */
  setPeriod(p: Period): Promise<void>;
  /** Partial update; server merges only the provided groups. Throws ApiError for inline handling. */
  updatePreferences(update: PreferencesUpdate): Promise<void>;
  addTransactions(inputs: TxInput[]): Promise<BatchInsertResult>;
  patchTransaction(id: string, patch: PatchTxInput): Promise<void>;
  deleteTransaction(id: string): Promise<void>;
  uploadDocuments(files: File[]): Promise<UploadResult>;
  wipeAll(): Promise<void>;
  /** Run AI extraction on a document; throws ApiError for inline handling. */
  extractDocument(id: string): Promise<ExtractionResult>;
  /** Confirm a (possibly edited) extraction → creates the transaction. */
  confirmExtraction(id: string, input: TxInput): Promise<BatchInsertResult>;
  dismissExtraction(id: string): Promise<void>;
  /** Internal: background refresh that never clobbers UI on failure. */
  refreshQuiet(): Promise<void>;
}

/** Upsert an extraction row by documentId. */
function upsertExtraction(list: ExtractionResult[], next: ExtractionResult): ExtractionResult[] {
  const rest = list.filter((e) => e.documentId !== next.documentId);
  return [...rest, next];
}

let toastSeq = 1;

export const useStore = create<AppStore>((set, get) => ({
  loaded: false,
  loadError: null,
  transactions: [],
  tags: [],
  rules: [],
  settings: defaultSettings(),
  documents: [],
  extractions: [],
  activeModal: null,
  toasts: [],

  async load() {
    set({ loadError: null });
    try {
      const s = await api.getState();
      set({
        loaded: true,
        transactions: sortTransactions(s.transactions),
        tags: s.tags,
        rules: s.rules,
        settings: applySettings(s.settings),
        documents: s.documents,
        extractions: s.extractions ?? [],
      });
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : 'Failed to load your data.' });
    }
  },

  toast(kind, message) {
    const id = toastSeq++;
    set((st) => ({ toasts: [...st.toasts, { id, kind, message }] }));
    setTimeout(() => get().dismissToast(id), 5000);
  },

  dismissToast(id) {
    set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }));
  },

  openModal(m) {
    set({ activeModal: m });
  },

  closeModal() {
    set({ activeModal: null });
  },

  async setPeriod(p) {
    const prev = get().settings.selectedPeriod;
    if (p === prev) return;
    set((st) => ({ settings: { ...st.settings, selectedPeriod: p } }));
    try {
      const res = await api.putPreferences({ selectedPeriod: p });
      set({ settings: applySettings(res.settings) });
    } catch (e) {
      set((st) => ({ settings: { ...st.settings, selectedPeriod: prev } }));
      get().toast('error', e instanceof Error ? e.message : 'Could not save the period.');
    }
  },

  async updatePreferences(update) {
    const res = await api.putPreferences(update);
    set({ settings: applySettings(res.settings), tags: res.tags, rules: res.rules });
  },

  async addTransactions(inputs) {
    const res = await api.addTransactions(inputs);
    if (res.insertedRows.length > 0) {
      set((st) => ({
        transactions: sortTransactions([...st.transactions, ...res.insertedRows]),
      }));
      // New tags may have been registered server-side (e.g. from an entry form)
      void get().refreshQuiet();
    }
    return res;
  },

  async patchTransaction(id, patch) {
    const row = await api.patchTransaction(id, patch);
    set((st) => ({
      transactions: st.transactions.map((t) => (t.id === id ? row : t)),
    }));
  },

  async deleteTransaction(id) {
    await api.deleteTransaction(id);
    set((st) => ({ transactions: st.transactions.filter((t) => t.id !== id) }));
  },

  async uploadDocuments(files) {
    const res = await api.uploadDocuments(files);
    // Uploads can create transactions (CSV) and documents; refresh from source of truth.
    await get().load();
    return res;
  },

  async wipeAll() {
    await api.wipeAll();
    await get().load();
  },

  async extractDocument(id) {
    const result = await api.extractDocument(id);
    set((st) => ({ extractions: upsertExtraction(st.extractions, result) }));
    return result;
  },

  async confirmExtraction(id, input) {
    const res = await api.confirmExtraction(id, input);
    if (res.insertedRows.length > 0) {
      set((st) => ({
        transactions: sortTransactions([...st.transactions, ...res.insertedRows]),
      }));
    }
    // Server updates the extraction row + document status; pull fresh state.
    void get().refreshQuiet();
    return res;
  },

  async dismissExtraction(id) {
    await api.dismissExtraction(id);
    set((st) => ({
      extractions: st.extractions.map((e) =>
        e.documentId === id ? { ...e, status: 'dismissed' as const } : e,
      ),
    }));
  },

  async refreshQuiet() {
    try {
      const s = await api.getState();
      set({
        transactions: sortTransactions(s.transactions),
        tags: s.tags,
        rules: s.rules,
        settings: applySettings(s.settings),
        documents: s.documents,
        extractions: s.extractions ?? [],
      });
    } catch {
      /* keep current state */
    }
  },
}));

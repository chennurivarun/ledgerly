import { create } from 'zustand';
import { api, type BriefingPreview } from './api';
import { setActiveCurrency } from '../shared/format';
import {
  defaultSettings,
  type BatchInsertResult,
  type DocumentMeta,
  type ExtractionResult,
  type InboxEmail,
  type MerchantAnswerInput,
  type MerchantQuestion,
  type PatchTxInput,
  type Period,
  type PreferencesUpdate,
  type Rule,
  type RuleSuggestion,
  type Settings,
  type StatementConfirmInput,
  type StatementExtraction,
  type StatementPreflight,
  type StatementJobStatus,
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
  statements: StatementExtraction[];
  ruleSuggestions: RuleSuggestion[];
  merchantQuestions: MerchantQuestion[];
  inboxEmails: InboxEmail[];
  activeModal: ModalKind;
  toasts: Toast[];
  /** Build id the server last reported (version-skew detection, shared/version.ts);
   * null = unknown (older server, or nothing fetched yet) — never guess a
   * mismatch. Set from every /api/state response (load + refreshQuiet), so a
   * rollback to this tab's own build honestly clears any banner. */
  serverBuildId: string | null;

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
  /** Pages/batches/cost a statement read will involve; throws ApiError. */
  statementPreflight(id: string): Promise<StatementPreflight>;
  /** Read a PDF statement into proposed rows; inserts nothing. */
  extractStatement(id: string): Promise<StatementExtraction>;
  /** Import the user-selected (possibly edited) rows. */
  confirmStatementRows(id: string, input: StatementConfirmInput): Promise<BatchInsertResult>;
  dismissStatement(id: string): Promise<void>;
  /** Turn a learned suggestion into a rule; updates the rules list. */
  acceptRuleSuggestion(s: RuleSuggestion): Promise<void>;
  /** Suppress a suggestion permanently for this merchant/category pair. */
  dismissRuleSuggestion(s: RuleSuggestion): Promise<void>;
  /** Answer a "Getting to know you" question: updates rules, advances the
   * queue locally, then refreshes from the source of truth. */
  answerMerchantQuestion(
    q: MerchantQuestion,
    input: MerchantAnswerInput,
  ): Promise<{ rules: Rule[]; recategorized: number }>;
  /** Skip a question — suppressed permanently for this merchant. */
  dismissMerchantQuestion(q: MerchantQuestion): Promise<void>;
  /** Confirm a mail-in proposal → creates the transaction. */
  confirmInboxEmail(id: string, input: TxInput): Promise<BatchInsertResult>;
  dismissInboxEmail(id: string): Promise<void>;
  /** Compute today's briefing server-side; throws ApiError for inline handling. */
  previewBriefing(): Promise<BriefingPreview>;
  /** Deliver today's briefing over WhatsApp; refreshes lastBriefingSentAt. */
  sendBriefing(): Promise<{ ok: true; sentTo: string }>;
  /** Internal: background refresh that never clobbers UI on failure. */
  refreshQuiet(): Promise<void>;
}

/** Upsert an extraction row by documentId. */
function upsertExtraction(list: ExtractionResult[], next: ExtractionResult): ExtractionResult[] {
  const rest = list.filter((e) => e.documentId !== next.documentId);
  return [...rest, next];
}

const REVIEWABLE_STATEMENT_STATUSES: StatementJobStatus[] = ['pending', 'suggested', 'partial'];

/**
 * Merges a fresh /api/state statements payload against the current local
 * list. /api/state only carries rows for the newest 10 reviewable jobs — a
 * refreshQuiet fired while a job is mid-triage can legitimately return that
 * job as { status: 'suggested', rows: [], rowCount > 0 } once a newer job
 * pushes it out of that window. A naive replace would then prune every
 * in-progress draft in the review modal (edits destroyed, silently).
 *
 * When the server elides rows this way (reviewable status, empty rows, but
 * a real rowCount) AND the local copy still has rows for that document,
 * keep the local rows — the server didn't delete them, it just didn't
 * re-send them. Every other case takes the incoming payload as-is: a
 * settled status (confirmed/dismissed/failed) always wins, since that's how
 * post-confirm pruning actually removes rows from the review table; a
 * genuinely empty new job (rowCount 0) has nothing to preserve; and a
 * non-elided reviewable job (incoming actually has rows) is simply fresher.
 */
export function mergeStatements(
  local: StatementExtraction[],
  incoming: StatementExtraction[],
): StatementExtraction[] {
  return incoming.map((next) => {
    const elided =
      REVIEWABLE_STATEMENT_STATUSES.includes(next.status) && next.rows.length === 0 && next.rowCount > 0;
    if (!elided) return next;
    const prevLocal = local.find((s) => s.documentId === next.documentId);
    return prevLocal && prevLocal.rows.length > 0 ? { ...next, rows: prevLocal.rows } : next;
  });
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
  statements: [],
  ruleSuggestions: [],
  merchantQuestions: [],
  inboxEmails: [],
  activeModal: null,
  toasts: [],
  serverBuildId: null,

  async load() {
    set({ loadError: null });
    try {
      const s = await api.getState();
      set((st) => ({
        loaded: true,
        transactions: sortTransactions(s.transactions),
        tags: s.tags,
        rules: s.rules,
        settings: applySettings(s.settings),
        documents: s.documents,
        extractions: s.extractions ?? [],
        statements: mergeStatements(st.statements, s.statements ?? []),
        ruleSuggestions: s.ruleSuggestions ?? [],
        merchantQuestions: s.merchantQuestions ?? [],
        inboxEmails: s.inboxEmails ?? [],
        serverBuildId: s.buildId ?? null,
      }));
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

  async statementPreflight(id) {
    return api.statementPreflight(id);
  },

  async extractStatement(id) {
    const result = await api.extractStatement(id);
    set((st) => ({
      statements: [...st.statements.filter((x) => x.documentId !== id), result],
    }));
    return result;
  },

  async confirmStatementRows(id, input) {
    const res = await api.confirmStatementRows(id, input);
    if (res.insertedRows.length > 0) {
      set((st) => ({
        transactions: sortTransactions([...st.transactions, ...res.insertedRows]),
      }));
    }
    // Server flips row + job status; pull fresh state rather than guessing it.
    void get().refreshQuiet();
    return res;
  },

  async dismissStatement(id) {
    await api.dismissStatement(id);
    set((st) => ({
      statements: st.statements.map((x) =>
        x.documentId === id ? { ...x, status: 'dismissed' as const } : x,
      ),
    }));
  },

  async refreshQuiet() {
    try {
      const s = await api.getState();
      set((st) => ({
        transactions: sortTransactions(s.transactions),
        tags: s.tags,
        rules: s.rules,
        settings: applySettings(s.settings),
        documents: s.documents,
        extractions: s.extractions ?? [],
        statements: mergeStatements(st.statements, s.statements ?? []),
        ruleSuggestions: s.ruleSuggestions ?? [],
        merchantQuestions: s.merchantQuestions ?? [],
        inboxEmails: s.inboxEmails ?? [],
        serverBuildId: s.buildId ?? null,
      }));
    } catch {
      /* keep current state */
    }
  },

  async acceptRuleSuggestion(sug) {
    const res = await api.acceptRuleSuggestion({ merchant: sug.merchant, category: sug.category });
    set((st) => ({
      rules: res.rules,
      ruleSuggestions: st.ruleSuggestions.filter((x) => x.id !== sug.id),
    }));
  },

  async dismissRuleSuggestion(sug) {
    await api.dismissRuleSuggestion({ merchant: sug.merchant, category: sug.category });
    set((st) => ({
      ruleSuggestions: st.ruleSuggestions.filter((x) => x.id !== sug.id),
    }));
  },

  async answerMerchantQuestion(q, input) {
    const res = await api.answerMerchantQuestion(input);
    // Advance the queue immediately (the next question appears); the refresh
    // reconciles rules, recategorized rows and any newly eligible question.
    set((st) => ({
      rules: res.rules,
      merchantQuestions: st.merchantQuestions.filter((x) => x.id !== q.id),
    }));
    void get().refreshQuiet();
    return res;
  },

  async dismissMerchantQuestion(q) {
    await api.dismissMerchantQuestion({ merchant: q.merchant });
    set((st) => ({
      merchantQuestions: st.merchantQuestions.filter((x) => x.id !== q.id),
    }));
  },

  async confirmInboxEmail(id, input) {
    const res = await api.confirmInboxEmail(id, input);
    if (res.insertedRows.length > 0) {
      set((st) => ({
        transactions: sortTransactions([...st.transactions, ...res.insertedRows]),
      }));
    }
    // Server flips the inbox item's status; pull fresh state rather than guessing.
    void get().refreshQuiet();
    return res;
  },

  async dismissInboxEmail(id) {
    await api.dismissInboxEmail(id);
    set((st) => ({
      inboxEmails: st.inboxEmails.map((e) =>
        e.id === id ? { ...e, status: 'dismissed' as const } : e,
      ),
    }));
  },

  async previewBriefing() {
    return api.previewBriefing();
  },

  async sendBriefing() {
    const res = await api.sendBriefing();
    // Server stamps lastBriefingSentAt; pull it rather than guessing it.
    void get().refreshQuiet();
    return res;
  },
}));

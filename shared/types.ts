// Ledgerly shared contracts — FROZEN during the team sprint.
// Client (src/), worker (worker/), and shared libs all import from here.
// Changing a shape here requires EM sign-off; additive changes only.

export type TxType = 'expense' | 'income';
export type TxSource = 'manual' | 'csv' | 'document' | 'google-drive';

export interface Transaction {
  id: string;
  date: string; // ISO YYYY-MM-DD
  merchant: string;
  category: string;
  amount: number; // positive magnitude; sign comes from `type`
  type: TxType;
  account: string;
  tags: string[];
  receipt: boolean;
  source: TxSource;
  fingerprint: string;
  createdAt: string; // ISO timestamp
}

export interface Tag {
  name: string;
  createdAt: string;
}

export interface Rule {
  id: string;
  whenText: string;
  thenText: string;
  enabled: boolean;
  createdAt: string;
}

export type DocStatus = 'queued' | 'stored' | 'review';
export type DocSource = 'upload' | 'google-drive';

export interface DocumentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  objectKey: string; // never shown raw in the UI
  status: DocStatus;
  source: DocSource;
  createdAt: string;
}

export type Period =
  | 'all-time'
  | 'this-month'
  | 'last-month'
  | 'last-3-months'
  | 'last-6-months'
  | 'this-year';

export const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'all-time', label: 'All time' },
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'last-3-months', label: 'Last 3 months' },
  { value: 'last-6-months', label: 'Last 6 months' },
  { value: 'this-year', label: 'This year' },
];

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';

export interface RecurringItem {
  id: string;
  name: string;
  category: string;
  amount: number;
  cadence: Cadence;
  nextDate: string; // YYYY-MM-DD
  account?: string;
  active: boolean;
}

// Subscriptions share the RecurringItem shape; `name` is the service name.
export type Subscription = RecurringItem;

export interface Budget {
  id: string;
  category: string;
  limit: number; // monthly limit
  active: boolean;
}

export interface Goal {
  id: string;
  name: string;
  target: number;
  current: number;
  dueDate?: string;
  note?: string;
}

export interface DriveSyncMeta {
  folderName?: string;
  folderUrl?: string;
  timezone?: string;
  lastSyncedAt?: string;
  lastStatus?: 'complete' | 'partial' | 'error';
  lastImported?: number;
  lastDuplicates?: number;
  lastStored?: number;
  lastReview?: number;
  lastErrors?: string[];
}

export interface Settings {
  categories: string[];
  accounts: string[];
  goals: Goal[];
  budgets: Budget[];
  subscriptions: Subscription[];
  recurring: RecurringItem[];
  dismissedPatterns: string[];
  assetsTotal: number;
  liabilitiesTotal: number;
  netWorthConfigured: boolean;
  selectedPeriod: Period;
  drive: DriveSyncMeta;
  driveResetAt: string | null;
  freshStart: boolean;
  /** ISO 4217 display currency (see shared/currencies.ts). Formatting only. */
  currency: string;
  /** True once the first-run setup wizard was completed or skipped. */
  onboarded: boolean;
  /** Receipt-extraction AI provider. 'workers-ai' runs inside the user's own
   * Cloudflare account; 'anthropic' sends document bytes to Anthropic under
   * the user's own API key (BYOK). */
  aiProvider: AiProvider;
  /** Optional model override for the active provider; null = provider default. */
  aiModel: string | null;
  /** Whether a BYOK API key is stored. The key itself is write-only — it is
   * NEVER returned by any endpoint. */
  aiKeySet: boolean;
}

export type AiProvider = 'off' | 'workers-ai' | 'anthropic';

// Starter definitions are lookup configuration only — never financial records (spec §3).
export const STARTER_CATEGORIES = [
  'Housing',
  'Groceries',
  'Shopping',
  'Dining',
  'Transportation',
  'Utilities',
  'Subscriptions',
  'Insurance',
  'Health',
  'Entertainment',
  'Income',
  'Needs review',
  'Other',
];

export const STARTER_ACCOUNTS = ['Main Checking', 'Everyday Visa', 'Rewards Card', 'Cash'];

export const NEEDS_REVIEW = 'Needs review';
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
export const WIPE_CONFIRMATION = 'DELETE ALL LEDGERLY DATA';

export function defaultSettings(): Settings {
  return {
    categories: [...STARTER_CATEGORIES],
    accounts: [...STARTER_ACCOUNTS],
    goals: [],
    budgets: [],
    subscriptions: [],
    recurring: [],
    dismissedPatterns: [],
    assetsTotal: 0,
    liabilitiesTotal: 0,
    netWorthConfigured: false,
    selectedPeriod: 'all-time',
    drive: {},
    driveResetAt: null,
    freshStart: false,
    currency: 'USD',
    onboarded: false,
    aiProvider: 'off',
    aiModel: null,
    aiKeySet: false,
  };
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

/** GET /api/state */
export interface StatePayload {
  transactions: Transaction[]; // newest first, capped at 5000
  tags: Tag[];
  rules: Rule[];
  settings: Settings;
  documents: DocumentMeta[]; // newest first, capped at 100
  /** Extraction rows for the returned documents (absent before first extraction). */
  extractions?: ExtractionResult[];
  /** Statement jobs (with rows) for the returned documents. */
  statements?: StatementExtraction[];
}

// ---------------------------------------------------------------------------
// AI receipt/document extraction (sprint 3)
// ---------------------------------------------------------------------------

export type ExtractionStatus = 'pending' | 'suggested' | 'confirmed' | 'dismissed' | 'failed';

/** Hard cap on rows proposed from one statement run (spec: no silent truncation). */
export const MAX_STATEMENT_ROWS = 300;

/** One extracted field with the model's confidence (0..1). */
export interface ExtractedField<T> {
  value: T | null;
  confidence: number;
}

/**
 * The AI's suggestion for a document. NEVER auto-inserted — a transaction is
 * created only when the user confirms via the review flow (vision principle:
 * AI suggests, it never silently writes).
 */
export interface ExtractionResult {
  documentId: string;
  status: ExtractionStatus;
  merchant: ExtractedField<string>;
  date: ExtractedField<string>; // YYYY-MM-DD
  total: ExtractedField<number>; // positive magnitude
  type: ExtractedField<TxType>;
  category: ExtractedField<string>; // suggestion from the managed list, or null
  provider: string;
  model: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// PDF statement extraction (sprint 4) — many transactions from one document
// ---------------------------------------------------------------------------

export type StatementJobStatus =
  | 'pending'
  | 'suggested' // rows proposed, awaiting review
  | 'partial' // rows proposed but the run hit the cap / ran out of room
  | 'confirmed' // every row triaged (confirmed or dismissed)
  | 'dismissed'
  | 'failed';

export type StatementRowStatus = 'proposed' | 'confirmed' | 'dismissed';

/**
 * One proposed transaction read off a statement. Same never-guess rules as
 * receipt extraction: a field the model could not read is null with
 * confidence 0, and NOTHING here becomes a transaction until the user
 * confirms the row.
 */
export interface StatementRow {
  id: string;
  documentId: string;
  index: number; // order as read off the statement
  date: ExtractedField<string>; // YYYY-MM-DD
  merchant: ExtractedField<string>;
  amount: ExtractedField<number>; // positive magnitude
  type: ExtractedField<TxType>;
  category: ExtractedField<string>; // from the managed list, or null
  status: StatementRowStatus;
  /** Server-computed: this row's fingerprint already exists in transactions. */
  duplicate: boolean;
  /** Lowest field confidence — drives review ordering. */
  lowestConfidence: number;
}

export interface StatementExtraction {
  documentId: string;
  status: StatementJobStatus;
  rowCount: number;
  /** True when the run stopped at MAX_STATEMENT_ROWS or ran out of output room. */
  truncated: boolean;
  provider: string;
  model: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  rows: StatementRow[];
}

/** POST /api/documents/:id/statement/confirm — user-reviewed rows only. */
export interface StatementConfirmInput {
  /** Each entry is a (possibly edited) row the user chose to import. */
  rows: (TxInput & { rowId: string })[];
}

/** POST /api/transactions — single or batch */
export interface TxInput {
  date: string;
  merchant: string;
  amount: number;
  type: TxType;
  category?: string; // defaults to NEEDS_REVIEW
  account?: string; // defaults to 'Imported account'
  tags?: string[];
  receipt?: boolean;
  source?: TxSource; // defaults to 'manual'
}

export interface BatchInsertResult {
  inserted: number;
  duplicates: number;
  insertedRows: Transaction[];
  errors: string[];
}

/**
 * PATCH /api/transactions/:id
 * Contract note (EM-ratified): tag names sent here that are not yet defined are
 * registered as global tag definitions server-side, satisfying §7.2's "save
 * both the global tag definition and the transaction's updated tag array".
 */
export interface PatchTxInput {
  category?: string;
  tags?: string[];
}

/** PUT /api/preferences — partial; only provided groups are updated (spec §4.5). */
export interface PreferencesUpdate {
  categories?: string[];
  accounts?: string[];
  tags?: string[]; // full replacement list of tag names
  rules?: Rule[]; // full replacement
  goals?: Goal[];
  budgets?: Budget[];
  subscriptions?: Subscription[];
  recurring?: RecurringItem[];
  dismissedPatterns?: string[];
  assetsTotal?: number;
  liabilitiesTotal?: number;
  netWorthConfigured?: boolean;
  selectedPeriod?: Period;
  drive?: DriveSyncMeta;
  currency?: string;
  onboarded?: boolean;
  aiProvider?: AiProvider;
  aiModel?: string | null;
  /** Write-only BYOK key. Stored server-side, never echoed back; null clears it. */
  aiApiKey?: string | null;
}

export interface PreferencesResult {
  ok: true;
  settings: Settings;
  tags: Tag[];
  rules: Rule[];
}

/** POST /api/documents (multipart, field name `files`) */
export interface UploadResult {
  documents: DocumentMeta[];
  inserted: number; // transactions created from parseable files (e.g. CSV)
  duplicates: number;
  review: number; // files stored but needing review
  errors: string[];
}

/** GET /api/drive-sync */
export interface DriveSyncStatus {
  folder: DriveSyncMeta;
  schedule: { time: '08:00'; timezone: string; cadence: 'daily' };
  lastSyncedAt: string | null;
  lastStatus: 'complete' | 'partial' | 'error' | null;
  counts: {
    imported: number;
    duplicates: number;
    stored: number;
    review: number;
    errors: number;
  };
  processedFileIds: string[]; // most recent, capped at 5000
  resetAt: string | null;
}

/** POST /api/drive-sync */
export interface DriveFilePayload {
  fileId: string;
  filename: string;
  mimeType: string;
  modifiedTime: string; // ISO
  contentBase64?: string;
  status: DocStatus;
}

export interface DriveSyncPost {
  transactions?: (TxInput & { fileId?: string })[];
  files?: DriveFilePayload[];
  errors?: string[];
}

export interface DriveSyncResult {
  status: 'complete' | 'partial';
  lastSyncedAt: string;
  imported: number;
  duplicates: number;
  filesStored: number;
  filesReview: number;
  errors: string[];
}

/** DELETE /api/state — body: { confirm: WIPE_CONFIRMATION } */
export interface WipeResult {
  ok: true;
  wipedAt: string;
}

/** Error shape for all endpoints: HTTP >= 400 with { error: string } */
export interface ApiErrorBody {
  error: string;
}

// ---------------------------------------------------------------------------
// Recurring/subscription detection contracts (implemented in shared/detection.ts)
// ---------------------------------------------------------------------------

export interface DetectedPattern {
  key: string; // stable dismissal key: `${normalized}|${cadence}`
  merchant: string; // display merchant (from the most recent transaction)
  normalized: string;
  kind: 'subscription' | 'recurring';
  cadence: Cadence;
  occurrences: number;
  confidence: 'high' | 'likely';
  averageAmount: number;
  monthlyEquivalent: number;
  nextDate: string; // YYYY-MM-DD, calendar-aware
  lastDate: string;
  category: string;
}

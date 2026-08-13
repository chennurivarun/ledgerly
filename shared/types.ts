// Ledgerly shared contracts — FROZEN during the team sprint.
// Client (src/), worker (worker/), and shared libs all import from here.
// Changing a shape here requires EM sign-off; additive changes only.

export type TxType = 'expense' | 'income';
export type TxSource = 'manual' | 'csv' | 'document' | 'google-drive' | 'email';

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
  /**
   * PDF page count, measured once at upload/ingest time (sprint 11). null =
   * unknown: a non-PDF (pages aren't a meaningful concept), a row stored
   * before the column existed, or a PDF that could not be read (encrypted or
   * corrupt). Unknown stays null — a count is never guessed or backfilled —
   * and consumers must treat null as "don't gate on pages", not as zero.
   */
  pageCount: number | null;
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
  /** Whether a Sarvam API key is stored. Write-only, NEVER echoed. */
  sarvamKeySet: boolean;
  /** Base URL of a user-configured OpenAI-compatible endpoint (sprint 15),
   * e.g. 'https://integrate.api.nvidia.com/v1' or a local Ollama server.
   * Stored normalized (no trailing slash); '' = not configured. */
  customBaseUrl: string;
  /** Whether a custom-endpoint API key is stored. Write-only, NEVER echoed.
   * The key itself is OPTIONAL — keyless servers (local Ollama) are valid. */
  customKeySet: boolean;
  /** User-entered Sarvam per-page price (their dashboard rate) for honest
   * cost estimates; null = no estimate shown, never a guessed price. */
  sarvamPricePerPage: number | null;
  /** Proactive briefings (sprint 7, vision phase-2 item 6). Off by default. */
  briefingsEnabled: boolean;
  briefingCadence: BriefingCadence;
  /** WhatsApp Business Cloud API delivery (BYO Meta credentials).
   * Recipient in E.164 digits; phoneNumberId from the user's Meta app. */
  briefingWhatsappRecipient: string;
  briefingWhatsappPhoneNumberId: string;
  /** Whether a Cloud API access token is stored. Write-only, NEVER echoed. */
  briefingWhatsappTokenSet: boolean;
  /** ISO timestamp of the last successful briefing send; null = never. */
  lastBriefingSentAt: string | null;
  /** Mail-in feed (sprint 8). Off by default; with an EMPTY allowlist
   * nothing is ever ingested — secure by default. */
  emailFeedEnabled: boolean;
  /** Allowed senders: exact addresses ("alerts@chase.com") or whole domains
   * ("@chase.com"). Matching is case-insensitive on the envelope sender. */
  emailAllowedSenders: string[];
}

export type AiProvider = 'off' | 'workers-ai' | 'anthropic' | 'sarvam' | 'custom';

export type BriefingCadence = 'daily' | 'weekly';

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
    sarvamKeySet: false,
    customBaseUrl: '',
    customKeySet: false,
    sarvamPricePerPage: null,
    briefingsEnabled: false,
    briefingCadence: 'weekly',
    briefingWhatsappRecipient: '',
    briefingWhatsappPhoneNumberId: '',
    briefingWhatsappTokenSet: false,
    lastBriefingSentAt: null,
    emailFeedEnabled: false,
    emailAllowedSenders: [],
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
  /** Rule suggestions learned from category corrections (sprint 5). */
  ruleSuggestions?: RuleSuggestion[];
  /** "Getting to know you" merchant questions (sprint 14): top-ranked first,
   * capped at 3 — a drip, never a wall. */
  merchantQuestions?: MerchantQuestion[];
  /** Mail-in feed inbox (sprint 8): newest first, capped at 100. */
  inboxEmails?: InboxEmail[];
  /** Build id of the deployment serving this response (version-skew detection); absent on older servers. */
  buildId?: string;
}

// ---------------------------------------------------------------------------
// The mail-in feed (sprint 8): bank alert emails, e-receipts and statements
// arrive at an address the user routes into their own Worker; a deterministic
// parser proposes transactions the user confirms. Suggestion-only, always —
// a spoofed email can at worst propose an item the user rejects. Inbound
// email NEVER triggers AI automatically: deterministic parsing is free and
// safe, AI extraction on stored attachments stays a user-clicked action.
// ---------------------------------------------------------------------------

export type InboxEmailStatus = 'proposed' | 'unparsed' | 'confirmed' | 'dismissed';

/** What the deterministic parser read off an alert email — plain facts only.
 * A field the parser could not establish unambiguously makes the whole email
 * 'unparsed' (never-guess); `date` falls back to the email's own arrival
 * date, which is a fact, not a guess. */
export interface InboxParsedFields {
  date: string; // YYYY-MM-DD
  merchant: string;
  amount: number; // positive; direction carried by `type`
  type: TxType;
  /** Which parser pack matched (e.g. 'generic-en'). Community packs land here. */
  pack: string;
}

export interface InboxEmail {
  id: string;
  /** Arrival time (email Date header, or ingestion time when absent). */
  receivedAt: string; // ISO timestamp
  from: string;
  subject: string; // clipped server-side
  status: InboxEmailStatus;
  /** Parser output, or null when the email landed as 'unparsed'. */
  parsed: InboxParsedFields | null;
  /** Stored attachment (PDF/image routed into the documents vault), if any. */
  documentId: string | null;
  createdAt: string;
}

/** Per-day ingestion cap — a flood of spoofed mail cannot swamp the vault. */
export const MAX_INBOX_EMAILS_PER_DAY = 200;

// ---------------------------------------------------------------------------
// Correction-learning rule suggestions (sprint 5, vision phase-2 item 1).
// Deterministic: repeated manual recategorizations of the same merchant become
// a suggested rule. The rules engine stays authoritative; a suggestion writes
// nothing until the user accepts it.
// ---------------------------------------------------------------------------

/** Corrections that must agree before a suggestion is made. */
export const RULE_SUGGESTION_THRESHOLD = 2;

export interface RuleSuggestion {
  /** Stable key: `${merchant.toLowerCase().trim()}|${category}`. */
  id: string;
  /** Merchant exactly as it appears on the corrected transactions. */
  merchant: string;
  /** The category the user keeps choosing for it. */
  category: string;
  /** How many corrections agree (>= RULE_SUGGESTION_THRESHOLD). */
  evidenceCount: number;
  /** ISO timestamp of the most recent agreeing correction. */
  lastSeen: string;
}

// ---------------------------------------------------------------------------
// "Getting to know you" merchant questions (sprint 14). Sparse, high-value
// questions — "who is this merchant?" — whose answers permanently teach the
// app (a stored profile + a real rule). Deterministic, zero AI: candidates
// come from repeated transactions the app demonstrably does not understand.
// ---------------------------------------------------------------------------

export type MerchantKind = 'person' | 'business';

/** One question the Dashboard may ask. Computed, never stored — answering or
 * dismissing is what writes anything. */
export interface MerchantQuestion {
  /** Stable key: the cleaned (cleanBankDescriptor), lowercased merchant. */
  id: string;
  /** Display name — the cleaned merchant as seen on the most recent transaction. */
  merchant: string;
  /** Transactions grouped under this merchant. */
  txCount: number;
  /** Sum of their amounts (positive magnitudes). */
  total: number;
  /** Date (YYYY-MM-DD) of the newest transaction in the group. */
  mostRecent: string;
  /** Heuristic default for the UI's Person/Business toggle — a HINT only,
   * never stored without the user's answer. null = no opinion. */
  suggestedKind: MerchantKind | null;
}

/** Body for POST /api/merchant-questions/answer. */
export interface MerchantAnswerInput {
  /** The question's display merchant. */
  merchant: string;
  kind: MerchantKind | null;
  /** Optional friendly name; defaults to the display merchant. */
  label?: string;
  category: string;
  /** Also recategorize this merchant's existing 'Needs review' transactions. */
  applyToExisting: boolean;
}

/**
 * GET /api/documents/:id/statement/preflight (sprint 10) — what a statement
 * read will involve, BEFORE anything is sent to a model. estimatedCost is
 * present only when the user saved their own per-page price.
 */
export interface StatementPreflight {
  pages: number;
  batches: number;
  provider: AiProvider;
  /** pages × sarvamPricePerPage, rounded to 2dp; null when no price saved
   * or the provider does not bill per page (anthropic). */
  estimatedCost: number | null;
}

/** Body for POST /api/rule-suggestions/accept and /dismiss. */
export interface RuleSuggestionActionInput {
  merchant: string;
  category: string;
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
  /**
   * Batch progress for a resumable read (sprint 12): done = batches that have
   * reached a terminal state at the provider, total = batches submitted.
   * Populated ONLY while status is 'pending' on a run that parked resumable
   * provider state server-side (Sarvam's submit-then-tick flow); null for
   * settled jobs, single-request providers (Anthropic), and legacy pending
   * rows — so `progress !== null` is also the UI's signal that this pending
   * job advances via ticks rather than a blocking request.
   */
  progress: { done: number; total: number } | null;
}

/** POST /api/documents/:id/statement/confirm — user-reviewed rows only. */
export interface StatementConfirmInput {
  /** Each entry is a (possibly edited) row the user chose to import. */
  rows: (TxInput & { rowId: string })[];
}

// ---------------------------------------------------------------------------
// Browser statement reads over the custom endpoint (sprint 16). The user's
// own browser extracts each PDF page (text layer first, rendered image as the
// fallback) and posts pages in small rounds; the worker owns the model calls
// and every persistence step. Rows a browser submits are SUGGESTIONS that ride
// the same never-guess normalization and review table as every provider —
// the manual-entry trust model. The custom API key never leaves the worker.
// ---------------------------------------------------------------------------

/** Pages per round — keeps every request short and free-plan safe. */
export const CLIENT_STATEMENT_PAGES_PER_ROUND = 8;

/** Total pages a browser read will send; anything past this is a loud partial. */
export const CLIENT_STATEMENT_MAX_PAGES = 100;

/** Server cap on one text page's extracted characters. */
export const STATEMENT_PAGE_TEXT_MAX_CHARS = 20000;

/** Server cap on one image page's data-URI length (bytes of the string). */
export const STATEMENT_PAGE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** One browser-extracted page (POST .../statement/pages/round). */
export interface StatementPageInput {
  /** 0-based page position in the PDF. */
  index: number;
  /** 'text' = the page's own text layer read clean; 'image' = a rendered
   * JPEG/PNG data URI for scanned or text-poor pages. */
  kind: 'text' | 'image';
  /** kind 'text': extracted text (≤ STATEMENT_PAGE_TEXT_MAX_CHARS);
   * kind 'image': a data: URI (≤ STATEMENT_PAGE_IMAGE_MAX_BYTES). */
  content: string;
}

/** POST .../statement/pages/round body. */
export interface StatementPagesRoundInput {
  pages: StatementPageInput[];
  /** Scopes the round to the begin that issued it (stale-tab safety). */
  runId?: string;
}

/** POST .../statement/pages/round response: raw rows, nothing persisted. */
export interface StatementPagesRoundResult {
  /** Unvalidated row objects exactly as the model returned them — finalize
   * owns normalization and persistence. */
  rows: unknown[];
  /** True when a round's answer had to be salvaged mid-JSON — rows may be
   * missing from it, and the client must carry that loudly into finalize. */
  truncated: boolean;
  /** Present when the round produced ZERO rows: a short structural
   * explanation (finish_reason etc. — never model prose) so an all-empty
   * read can say WHY instead of just "nothing could be read". */
  diagnostic?: string | null;
}

/** POST .../statement/pages/finalize body. */
export interface StatementPagesFinalizeInput {
  rows: unknown[];
  /** True when any round failed after retries or pages were skipped. */
  truncated: boolean;
  /** Scopes the finalize to the begin that issued it (stale-tab safety). */
  runId?: string;
  /** The last round's zero-row diagnostic (or failure copy) — stored into
   * the failed job's error when the whole read produced nothing. */
  diagnostic?: string;
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
  /** Write-only Sarvam key; null clears (aiApiKey semantics). */
  sarvamApiKey?: string | null;
  sarvamPricePerPage?: number | null;
  /** Custom endpoint base URL; '' clears. Validated + normalized server-side. */
  customBaseUrl?: string;
  /** Write-only custom-endpoint key; null clears (aiApiKey semantics).
   * Optional even when the provider is active — keyless servers exist. */
  customApiKey?: string | null;
  briefingsEnabled?: boolean;
  briefingCadence?: BriefingCadence;
  /** E.164 digits without '+', or '' to clear. */
  briefingWhatsappRecipient?: string;
  briefingWhatsappPhoneNumberId?: string;
  /** Write-only Cloud API access token. Stored server-side, never echoed
   * back; null clears it (exactly the aiApiKey semantics). */
  briefingWhatsappToken?: string | null;
  emailFeedEnabled?: boolean;
  /** Full replacement list; exact addresses or "@domain" entries. */
  emailAllowedSenders?: string[];
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

// Dashboard (spec §6): period-aware summary cards, cash flow + category
// charts, recent activity, a factual insight, and upcoming recurring items.
import { useMemo, type ReactNode } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CreditCard,
  PiggyBank,
  Receipt,
  Repeat,
  TrendingDown,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { fmtCurrency, fmtDate, fmtSigned, inPeriod } from '../../shared/format';
import { NEEDS_REVIEW, type Transaction } from '../../shared/types';
import { CashFlowChart, CategoryDonut } from '../components/flows/charts';
import {
  buildCashFlowSeries,
  buildCategoryBreakdown,
  computeTrend,
  upcomingItems,
  type Trend,
  type UpcomingItem,
} from '../components/flows/dashboardMath';
import { PeriodSelector } from '../components/flows/PeriodSelector';
import { MerchantQuestionCard } from '../components/questions/MerchantQuestionCard';
import { Card, EmptyState } from '../components/ui';
import { useStore } from '../store';

export default function Dashboard() {
  const transactions = useStore((s) => s.transactions);
  const settings = useStore((s) => s.settings);
  const period = settings.selectedPeriod;
  // One stable "now" per render pass — date-only math, and the page re-renders whenever store data changes.
  const now = useMemo(() => new Date(), []);

  const periodTx = useMemo(
    () => transactions.filter((t) => inPeriod(t.date, period, now)),
    [transactions, period, now],
  );
  const income = useMemo(() => sumByType(periodTx, 'income'), [periodTx]);
  const spending = useMemo(() => sumByType(periodTx, 'expense'), [periodTx]);
  const savingsRate = income > 0 ? ((income - spending) / income) * 100 : 0;

  const incomeTrend = useMemo(
    () => computeTrend(transactions, period, income, 'income', now),
    [transactions, period, income, now],
  );
  const spendingTrend = useMemo(
    () => computeTrend(transactions, period, spending, 'expense', now),
    [transactions, period, spending, now],
  );

  const cashFlow = useMemo(() => buildCashFlowSeries(transactions, period, now), [transactions, period, now]);
  const categoryBreakdown = useMemo(
    () => buildCategoryBreakdown(transactions, period, now),
    [transactions, period, now],
  );

  const netWorth = settings.assetsTotal - settings.liabilitiesTotal;
  // `transactions` is canonically newest-first (store.sortTransactions), so filtering preserves order.
  const recent = periodTx.slice(0, 5);
  const needsReviewCount = useMemo(
    () => transactions.filter((t) => t.category === NEEDS_REVIEW).length,
    [transactions],
  );
  const upcoming = useMemo(
    () => upcomingItems(settings.recurring, settings.subscriptions, now),
    [settings.recurring, settings.subscriptions, now],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Overview</h2>
          <p className="text-sm text-muted">Your finances at a glance.</p>
        </div>
        <PeriodSelector />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <NetWorthCard
          configured={settings.netWorthConfigured}
          assets={settings.assetsTotal}
          liabilities={settings.liabilitiesTotal}
          netWorth={netWorth}
        />
        <SummaryCard
          icon={TrendingUp}
          tone="positive"
          label="Income"
          value={fmtCurrency(income)}
          strip={<TrendStrip trend={incomeTrend} goodWhenUp />}
        />
        <SummaryCard
          icon={TrendingDown}
          tone="caution"
          label="Spending"
          value={fmtCurrency(spending)}
          strip={<TrendStrip trend={spendingTrend} goodWhenUp={false} />}
        />
        <SummaryCard
          icon={PiggyBank}
          tone="info"
          label="Savings rate"
          value={`${savingsRate.toFixed(0)}%`}
          strip={
            <p className="truncate text-xs text-muted">
              {fmtCurrency(income)} income − {fmtCurrency(spending)} spending
            </p>
          }
        />
      </div>

      {/* Renders nothing while there is no question — no empty-state filler. */}
      <MerchantQuestionCard />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card
          title="Cash flow"
          action={cashFlow.truncated ? <span className="text-xs text-muted">Last 7 months shown</span> : undefined}
          className="lg:col-span-3"
        >
          <CashFlowChart points={cashFlow.points} />
        </Card>
        <Card title="Spending by category" className="lg:col-span-2">
          <CategoryDonut slices={categoryBreakdown.slices} total={categoryBreakdown.total} />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card title="Recent activity" className="lg:col-span-3" padded={false}>
          <RecentActivity items={recent} />
        </Card>
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card title="Ledgerly insight">
            <InsightPanel needsReviewCount={needsReviewCount} />
          </Card>
          <Card title="Coming up">
            <ComingUp items={upcoming} />
          </Card>
        </div>
      </div>
    </div>
  );
}

function sumByType(txs: Transaction[], type: Transaction['type']): number {
  return txs.filter((t) => t.type === type).reduce((sum, t) => sum + t.amount, 0);
}

// ---------------------------------------------------------------------------
// Summary cards (spec §6.2)
// ---------------------------------------------------------------------------

function SummaryCard({
  icon: Icon,
  tone,
  label,
  value,
  strip,
}: {
  icon: LucideIcon;
  tone: 'positive' | 'caution' | 'info';
  label: string;
  value: string;
  strip: ReactNode;
}) {
  const toneClass = {
    positive: 'bg-positive-soft text-positive',
    caution: 'bg-caution-soft text-caution',
    info: 'bg-info-soft text-info',
  }[tone];
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted">{label}</p>
          <p className="mt-1 truncate text-2xl font-semibold">{value}</p>
        </div>
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${toneClass}`}>
          <Icon className="size-5" aria-hidden />
        </span>
      </div>
      <div className="mt-4 border-t border-border pt-3">{strip}</div>
    </Card>
  );
}

function NetWorthCard({
  configured,
  assets,
  liabilities,
  netWorth,
}: {
  configured: boolean;
  assets: number;
  liabilities: number;
  netWorth: number;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted">Net worth</p>
          <p className="mt-1 truncate text-2xl font-semibold">{configured ? fmtCurrency(netWorth) : 'Not set'}</p>
        </div>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Wallet className="size-5" aria-hidden />
        </span>
      </div>
      <div className="mt-4 border-t border-border pt-3">
        {configured ? (
          <p className="truncate text-xs text-muted">
            {fmtCurrency(assets)} assets − {fmtCurrency(liabilities)} liabilities
          </p>
        ) : (
          <div className="space-y-1.5">
            <p className="text-xs text-muted">
              Set your total assets and liabilities to calculate net worth. It is never derived from cash flow.
            </p>
            <Link
              to="/settings"
              className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
            >
              Set up in Settings <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>
        )}
      </div>
    </Card>
  );
}

function TrendStrip({ trend, goodWhenUp }: { trend: Trend; goodWhenUp: boolean }) {
  if (trend.kind === 'not-applicable') {
    // all-time has no comparable prior window — a labeled calculation strip, not a fake "no data yet" state.
    return <p className="text-xs text-muted">{trend.label}</p>;
  }
  if (trend.kind === 'unavailable') {
    return <p className="text-xs text-muted">No trend yet</p>;
  }
  const up = trend.pct >= 0;
  const good = up === goodWhenUp;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <p className={`flex items-center gap-1 text-xs font-medium ${good ? 'text-positive' : 'text-caution'}`}>
      <Icon className="size-3.5" aria-hidden />
      {up ? '+' : ''}
      {trend.pct.toFixed(0)}% {trend.label}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Recent activity (spec §6.3)
// ---------------------------------------------------------------------------

function RecentActivity({ items }: { items: Transaction[] }) {
  if (items.length === 0) {
    return (
      <div className="px-5 py-6">
        <EmptyState
          icon={Receipt}
          title="No activity in this period"
          body="Transactions you add or import will show up here."
          compact
        />
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {items.map((t) => (
        <li key={t.id} className="flex items-center justify-between gap-3 px-5 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{t.merchant}</p>
            <p className="truncate text-xs text-muted">
              {fmtDate(t.date)} · {t.category} · {t.account}
            </p>
          </div>
          <span
            className={`shrink-0 text-sm font-semibold tabular-nums ${t.type === 'income' ? 'text-positive' : 'text-ink'}`}
          >
            {fmtSigned(t.amount, t.type)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Ledgerly insight (spec §6.3) — factual only, scoped to all data (not just
// the selected period) since it tracks an operational backlog, not a total.
// "Review now" switches the shared period to all-time before navigating so
// the destination always shows the same count the card just claimed.
// ---------------------------------------------------------------------------

function InsightPanel({ needsReviewCount }: { needsReviewCount: number }) {
  const setPeriod = useStore((s) => s.setPeriod);
  const toast = useStore((s) => s.toast);
  const navigate = useNavigate();

  if (needsReviewCount === 0) {
    return <p className="text-sm text-muted">Nothing needs review right now. Nice and tidy.</p>;
  }

  async function goReview() {
    await setPeriod('all-time');
    // setPeriod already rolls back + toasts its own generic error on
    // failure, but that toast doesn't explain the downstream consequence —
    // verify the save actually landed before navigating anyway, so a failed
    // save doesn't silently ship a Transactions view that undercounts what
    // this card just claimed.
    if (useStore.getState().settings.selectedPeriod !== 'all-time') {
      toast('error', 'Could not switch to all time — the list below may not show every item counted here.');
    }
    navigate(`/transactions?category=${encodeURIComponent(NEEDS_REVIEW)}`);
  }

  return (
    <div className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-caution-soft text-caution">
        <AlertCircle className="size-5" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-sm">
          <span className="font-semibold">{needsReviewCount}</span>{' '}
          {needsReviewCount === 1 ? 'transaction needs' : 'transactions need'} review across all time.
        </p>
        <button
          type="button"
          onClick={() => void goReview()}
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
        >
          Review now <ArrowRight className="size-3" aria-hidden />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Coming up (spec §6.3)
// ---------------------------------------------------------------------------

function ComingUp({ items }: { items: UpcomingItem[] }) {
  if (items.length === 0) {
    return (
      <div className="space-y-1.5">
        <p className="text-sm text-muted">Nothing due in the next 14 days.</p>
        <Link to="/recurring" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
          Manage recurring payments <ArrowRight className="size-3" aria-hidden />
        </Link>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={`${i.kind}-${i.id}`} className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-canvas text-muted">
              {i.kind === 'subscription' ? (
                <CreditCard className="size-4" aria-hidden />
              ) : (
                <Repeat className="size-4" aria-hidden />
              )}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{i.name}</p>
              <p className="truncate text-xs text-muted">{fmtDate(i.nextDate)}</p>
            </div>
          </div>
          <span className="shrink-0 text-sm font-semibold tabular-nums">{fmtCurrency(i.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

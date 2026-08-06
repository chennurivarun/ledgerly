// Dashboard visualizations (spec §6.3). Cash flow reuses the app's own
// semantic tokens (income = positive green, expenses = caution orange —
// spec allows either violet/green for income and gray/orange for expenses).
// The category donut uses a fixed, colorblind-safe categorical order (see
// dashboardMath.ts) capped at 8 identity hues, folding the remainder into
// "Other categories" rather than generating a 9th hue (dataviz skill).
//
// Presentational only: the caller (Dashboard.tsx) owns the memoized
// aggregation over transactions and passes pre-computed points/slices down,
// so the expensive grouping runs once per data change, not once per chart.
import { PieChart as PieChartIcon, TrendingUp } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
// recharts-scale is a transitive dependency of recharts and the exact
// tick-selection function <YAxis> uses internally for a numeric axis's
// default domain/tickCount. Reused directly here (rather than reimplemented)
// so the "nice" ticks we size the gutter for are guaranteed to be the same
// algorithm, not a lookalike that could pick different values. It ships no
// type declarations, hence the sibling recharts-scale.d.ts shim.
import { getNiceTickValues } from 'recharts-scale';
import { fmtCurrency, getActiveCurrency } from '../../../shared/format';
import { EmptyState } from '../ui';
import type { CategorySlice, MonthPoint } from './dashboardMath';

const INCOME_COLOR = '#1a9e5c'; // --color-positive
const EXPENSE_COLOR = '#e07b16'; // --color-caution

/** Compact axis tick in the active currency, e.g. "$2K" (spec §5 chart legibility). */
function compactCurrency(v: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: getActiveCurrency(),
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(v);
}

/**
 * The exact tick values <YAxis> would otherwise compute on its own for a
 * [0, max] domain with recharts' defaults (tickCount=5, allowDecimals=true —
 * neither is overridden below). Computed once here and passed straight to
 * <YAxis ticks={...}>, so what's sized (tickGutterWidth) and what's rendered
 * are the same array — never two independent tick-selection passes that
 * could drift apart. That matters because a "nice" middle tick can format
 * LONGER than the domain's raw max: e.g. domain [0, 25000] nice-ticks to
 * [0, 6500, 13000, 19500, 26000], and "$19.5K" (needs a decimal) is longer
 * than "$26K" (a clean round number) — sizing off the raw max alone
 * under-budgets the gutter.
 */
function niceTicks(points: MonthPoint[]): number[] {
  const maxValue = points.reduce((max, p) => Math.max(max, p.income, p.expense), 0);
  return getNiceTickValues([0, maxValue], 5, true);
}

/**
 * Y axis gutter width, sized from the actual rendered ticks (see niceTicks)
 * rather than a single value. recharts spends 20px of the gutter on
 * non-text chrome — CartesianAxis's default tickSize (6px) + tickMargin
 * (2px), plus the 12px this chart's own `margin.left: -12` eats into the
 * axis — so only `width - 20` is actually available for the tick text
 * itself. ~7.5px/char covers the axis's 12px tick font with a little slack.
 * Clamped to [52, 100]: short currencies don't waste space, and 100 clears
 * the worst case found across all 30 supported currencies and realistic
 * dashboard magnitudes (a 3-letter code plus a one-decimal compact number,
 * e.g. "CZK 16.5K" at 9 chars -> 88px, leaving real slack instead of the
 * old 84px ceiling that was already the exact worst case with zero margin).
 */
function tickGutterWidth(ticks: number[]): number {
  const longestTick = Math.max(...ticks.map((t) => compactCurrency(t).length));
  return Math.min(100, Math.max(52, Math.ceil(longestTick * 7.5) + 20));
}

export function CashFlowChart({ points }: { points: MonthPoint[] }) {
  if (points.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No cash flow yet"
        body="Import or add transactions to see cash flow."
        compact
      />
    );
  }
  // A single monthly bucket has no line to draw between points — recharts
  // Area renders nothing visible without an explicit dot in that case.
  const singleBucket = points.length === 1;
  const ticks = niceTicks(points);
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id="cfIncome" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={INCOME_COLOR} stopOpacity={0.22} />
              <stop offset="100%" stopColor={INCOME_COLOR} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="cfExpense" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={EXPENSE_COLOR} stopOpacity={0.2} />
              <stop offset="100%" stopColor={EXPENSE_COLOR} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#e5e7eb" />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} />
          <YAxis
            tick={{ fontSize: 12, fill: '#6b7280' }}
            axisLine={false}
            tickLine={false}
            width={tickGutterWidth(ticks)}
            ticks={ticks}
            tickFormatter={compactCurrency}
          />
          <Tooltip content={<CashFlowTooltip />} />
          <Legend
            verticalAlign="top"
            align="right"
            height={32}
            iconType="circle"
            iconSize={8}
            formatter={(value: string) => <span className="text-xs text-muted">{value}</span>}
          />
          <Area
            type="monotone"
            dataKey="income"
            name="Income"
            stroke={INCOME_COLOR}
            strokeWidth={2}
            fill="url(#cfIncome)"
            dot={singleBucket ? { r: 4 } : false}
            activeDot={{ r: 4 }}
          />
          <Area
            type="monotone"
            dataKey="expense"
            name="Expenses"
            stroke={EXPENSE_COLOR}
            strokeWidth={2}
            fill="url(#cfExpense)"
            dot={singleBucket ? { r: 4 } : false}
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

interface CashFlowTooltipProps {
  active?: boolean;
  label?: string;
  payload?: { dataKey: string; name: string; value: number; color: string }[];
}

function CashFlowTooltip({ active, payload, label }: CashFlowTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-semibold">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full" style={{ background: p.color }} aria-hidden />
          <span className="text-muted">{p.name}:</span> {fmtCurrency(p.value)}
        </p>
      ))}
    </div>
  );
}

export function CategoryDonut({ slices, total }: { slices: CategorySlice[]; total: number }) {
  if (slices.length === 0) {
    return (
      <EmptyState
        icon={PieChartIcon}
        title="No spending yet"
        body="Categorize expenses in this period and they'll show up here."
        compact
      />
    );
  }
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
      <div className="relative mx-auto h-52 w-52 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="amount"
              nameKey="category"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={slices.length > 1 ? 2 : 0}
              stroke="#ffffff"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.id} fill={s.color} />
              ))}
            </Pie>
            <Tooltip content={<DonutTooltip total={total} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xs text-muted">Total spent</span>
          <span className="text-lg font-semibold">{fmtCurrency(total)}</span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-2" aria-label="Spending by category">
        {slices.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
              <span className="truncate">{s.category}</span>
            </span>
            <span className="shrink-0 tabular-nums text-muted">
              {fmtCurrency(s.amount)} · {s.pct.toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DonutTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean;
  payload?: { name: string; value: number }[];
  total: number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0];
  const pct = total > 0 ? (p.value / total) * 100 : 0;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md">
      <p className="font-semibold">{p.name}</p>
      <p className="text-muted">
        {fmtCurrency(p.value)} · {pct.toFixed(0)}%
      </p>
    </div>
  );
}

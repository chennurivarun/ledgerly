// Forecast section for the Recurring page (VISION phase-2 item 4, sprint 6
// S6-2) — rendered BELOW the detection/confirmed content. Honest framing:
// every figure on screen comes from the Forecast object (shared/forecast.ts),
// and an empty forecast renders an empty state — never zeros dressed as data,
// no fake chart. buildForecast is pure and synchronous, so there are no busy
// states: the section recomputes via useMemo whenever the transactions,
// dismissed keys, or horizon change.
import { CalendarRange } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  buildForecast,
  FORECAST_HORIZONS,
  type ForecastHorizon,
  type ForecastOccurrence,
  type ForecastPoint,
} from '../../../shared/forecast';
import { fmtCurrency, fmtDate, fmtSigned, todayISO } from '../../../shared/format';
import { useStore } from '../../store';
import { CADENCE_LABELS } from '../manage/commitmentTotals';
import { Stat } from '../manage/Stat';
import { StatusBadge } from '../manage/StatusBadge';
import { Card, EmptyState, SegmentedControl } from '../ui';
import {
  capUpcoming,
  compactCurrency,
  deriveForecastTiles,
  fmtDayLabel,
  groupOccurrencesByDate,
  hiddenCountLabel,
  netAxisTicks,
  netTickGutterWidth,
} from './forecastMath';

const NET_COLOR = '#6558d3'; // --color-accent

const HORIZON_OPTIONS = FORECAST_HORIZONS.map((h) => ({ value: String(h), label: `${h} days` }));

export function ForecastSection() {
  const transactions = useStore((s) => s.transactions);
  const settings = useStore((s) => s.settings);
  // Horizon is local component state, default 30 — no persistence in v1.
  const [horizon, setHorizon] = useState<ForecastHorizon>(30);

  // The SAME dismissed set RecurringEngineView uses to hide dismissed
  // patterns (membership in settings.dismissedPatterns) — only as a Set,
  // per buildForecast's signature. A dismissed pattern contributes nothing.
  const dismissedKeys = useMemo(() => new Set(settings.dismissedPatterns), [settings.dismissedPatterns]);

  const forecast = useMemo(
    // todayISO(): the caller's local calendar day, computed once per
    // recompute (house rule in shared/format: never toISOString for
    // calendar dates) — same clock RecurringEngineView reads on this page.
    () => buildForecast(transactions, dismissedKeys, horizon, todayISO()),
    [transactions, dismissedKeys, horizon],
  );

  const empty = forecast.occurrences.length === 0;
  const tiles = deriveForecastTiles(forecast);
  const { visible, hiddenCount } = capUpcoming(forecast.occurrences);
  const groups = groupOccurrencesByDate(visible);
  const moreLabel = hiddenCountLabel(hiddenCount);

  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Forecast</h2>
          <p className="mt-0.5 text-sm text-muted">
            A deterministic projection of your detected recurring activity — not a guarantee.
          </p>
        </div>
        {/* Kept visible even when the current horizon is empty: a pattern due
            in 45 days yields nothing at 30 days but real occurrences at 60/90,
            and hiding the control would trap the user at the empty horizon. */}
        <div className="w-full shrink-0 sm:w-64">
          <SegmentedControl
            ariaLabel="Forecast horizon"
            options={HORIZON_OPTIONS}
            value={String(horizon)}
            onChange={(v) => setHorizon(Number(v) as ForecastHorizon)}
          />
        </div>
      </div>

      {empty ? (
        <EmptyState
          compact
          icon={CalendarRange}
          title="No forecast yet"
          body="Forecasts appear once recurring patterns are detected."
        />
      ) : (
        <div className="mt-5 space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {tiles.map((t) => (
              <Stat
                key={t.label}
                label={t.label}
                value={
                  t.tone ? (
                    <span className={t.tone === 'positive' ? 'text-positive' : 'text-caution'}>{t.value}</span>
                  ) : (
                    t.value
                  )
                }
                sub={t.sub}
              />
            ))}
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-muted">
              Cumulative net, {fmtDate(forecast.start)} – {fmtDate(forecast.end)}
            </p>
            <ForecastNetChart points={forecast.points} />
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold">Upcoming</p>
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.date}>
                  <p className="text-xs font-medium text-muted">{fmtDate(g.date)}</p>
                  <ul className="divide-y divide-border">
                    {g.occurrences.map((o) => (
                      <UpcomingRow key={`${o.key}-${o.type}-${o.date}`} occurrence={o} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {moreLabel && <p className="mt-3 text-xs text-muted">{moreLabel}</p>}
          </div>
        </div>
      )}
    </Card>
  );
}

function UpcomingRow({ occurrence: o }: { occurrence: ForecastOccurrence }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{o.merchant}</p>
          <StatusBadge label={CADENCE_LABELS[o.cadence]} tone="neutral" />
          {/* Visible de-emphasis marker, not hover-only — same chip idiom as
              PatternCard's confidence badge. */}
          {o.confidence === 'likely' && <StatusBadge label="Likely" tone="info" />}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted">{o.category}</p>
      </div>
      <span
        className={`shrink-0 text-sm font-semibold tabular-nums ${o.type === 'income' ? 'text-positive' : 'text-ink'}`}
      >
        {fmtSigned(o.amount, o.type)}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Cumulative net chart — same axis/tooltip/gutter idioms as the dashboard's
// CashFlowChart (flows/charts.tsx): nice ticks computed once and passed to
// both the axis and the gutter sizing, compact currency ticks, custom
// currency tooltip. Net can dip below zero, so the y-domain is pinned to the
// tick extremes rather than recharts' default [0, auto].
// ---------------------------------------------------------------------------

function ForecastNetChart({ points }: { points: ForecastPoint[] }) {
  // A single projected day has no line to draw between points — recharts
  // Area renders nothing visible without an explicit dot in that case.
  const singleDay = points.length === 1;
  const ticks = netAxisTicks(points);
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id="forecastNet" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={NET_COLOR} stopOpacity={0.22} />
              <stop offset="100%" stopColor={NET_COLOR} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#e5e7eb" />
          <XAxis
            dataKey="date"
            tickFormatter={fmtDayLabel}
            minTickGap={32}
            tick={{ fontSize: 12, fill: '#6b7280' }}
            axisLine={{ stroke: '#e5e7eb' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 12, fill: '#6b7280' }}
            axisLine={false}
            tickLine={false}
            width={netTickGutterWidth(ticks)}
            ticks={ticks}
            domain={[ticks[0], ticks[ticks.length - 1]]}
            tickFormatter={compactCurrency}
          />
          <Tooltip content={<ForecastNetTooltip />} />
          <Area
            type="monotone"
            dataKey="net"
            name="Cumulative net"
            stroke={NET_COLOR}
            strokeWidth={2}
            fill="url(#forecastNet)"
            dot={singleDay ? { r: 4 } : false}
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

interface ForecastNetTooltipProps {
  active?: boolean;
  payload?: { payload: ForecastPoint }[];
}

function ForecastNetTooltip({ active, payload }: ForecastNetTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-semibold">{fmtDate(p.date)}</p>
      <p>
        <span className="text-muted">In so far:</span> {fmtCurrency(p.in)}
      </p>
      <p>
        <span className="text-muted">Out so far:</span> {fmtCurrency(p.out)}
      </p>
      <p>
        <span className="text-muted">Net so far:</span> {fmtCurrency(p.net)}
      </p>
    </div>
  );
}

import { describe, expect, it } from 'vitest';
import type { Forecast, ForecastOccurrence, ForecastPoint } from '../shared/forecast';
import {
  capUpcoming,
  deriveForecastTiles,
  fmtDayLabel,
  groupOccurrencesByDate,
  hiddenCountLabel,
  netAxisTicks,
  netTickGutterWidth,
  UPCOMING_CAP,
} from '../src/components/forecast/forecastMath';

// Hand-built fixtures against the frozen S6-0 contract (shared/forecast.ts) —
// the UI is exercised through these helpers regardless of the engine stub.

function occ(overrides: Partial<ForecastOccurrence> = {}): ForecastOccurrence {
  return {
    key: 'netflix|monthly',
    date: '2026-09-01',
    merchant: 'Netflix',
    amount: 15.49,
    type: 'expense',
    cadence: 'monthly',
    confidence: 'high',
    category: 'Subscriptions',
    ...overrides,
  };
}

function forecast(overrides: Partial<Forecast> = {}): Forecast {
  // Income + expense mix: $2,400 salary in, $955.49 out over 30 days.
  return {
    start: '2026-08-08',
    end: '2026-09-06',
    horizonDays: 30,
    occurrences: [
      occ({ key: 'acme payroll|biweekly', date: '2026-08-14', merchant: 'Acme Payroll', amount: 1200, type: 'income', cadence: 'biweekly', category: 'Income' }),
      occ({ key: 'rent|monthly', date: '2026-09-01', merchant: 'Rent', amount: 940, cadence: 'monthly', category: 'Housing' }),
      occ({ key: 'netflix|monthly', date: '2026-09-01' }),
      occ({ key: 'acme payroll|biweekly', date: '2026-08-28', merchant: 'Acme Payroll', amount: 1200, type: 'income', cadence: 'biweekly', category: 'Income' }),
    ],
    points: [],
    totalIn: 2400,
    totalOut: 955.49,
    net: 1444.51,
    expenseSeries: 2,
    incomeSeries: 1,
    ...overrides,
  };
}

function point(overrides: Partial<ForecastPoint> = {}): ForecastPoint {
  return { date: '2026-08-08', in: 0, out: 0, net: 0, ...overrides };
}

describe('groupOccurrencesByDate', () => {
  it('groups by date preserving the forecast contract order (date ascending)', () => {
    const groups = groupOccurrencesByDate([
      occ({ key: 'a|monthly', date: '2026-08-14' }),
      occ({ key: 'b|monthly', date: '2026-08-28' }),
      occ({ key: 'c|monthly', date: '2026-09-01' }),
      occ({ key: 'd|monthly', date: '2026-09-01' }),
    ]);
    expect(groups.map((g) => g.date)).toEqual(['2026-08-14', '2026-08-28', '2026-09-01']);
    expect(groups[2].occurrences).toHaveLength(2);
  });

  it('keeps within-day order stable (input order, no re-sorting)', () => {
    const groups = groupOccurrencesByDate([
      occ({ key: 'rent|monthly', merchant: 'Rent', date: '2026-09-01' }),
      occ({ key: 'netflix|monthly', merchant: 'Netflix', date: '2026-09-01' }),
      occ({ key: 'gym|monthly', merchant: 'Gym', date: '2026-09-01' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].occurrences.map((o) => o.merchant)).toEqual(['Rent', 'Netflix', 'Gym']);
  });

  it('returns no groups for an empty list', () => {
    expect(groupOccurrencesByDate([])).toEqual([]);
  });
});

describe('capUpcoming', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => occ({ key: `m${i}|monthly`, date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}` }));

  it('shows everything and hides nothing when under the cap', () => {
    const { visible, hiddenCount } = capUpcoming(many(5), 30);
    expect(visible).toHaveLength(5);
    expect(hiddenCount).toBe(0);
  });

  it('hides nothing at exactly the cap (N=0 — no "+0 more" line)', () => {
    const { visible, hiddenCount } = capUpcoming(many(30), 30);
    expect(visible).toHaveLength(30);
    expect(hiddenCount).toBe(0);
    expect(hiddenCountLabel(hiddenCount)).toBeNull();
  });

  it('caps to the first (soonest) N and counts the remainder honestly', () => {
    const { visible, hiddenCount } = capUpcoming(many(42), 30);
    expect(visible).toHaveLength(30);
    expect(visible[0].key).toBe('m0|monthly'); // slice keeps the soonest, date-ascending head
    expect(hiddenCount).toBe(12);
    expect(hiddenCountLabel(hiddenCount)).toBe('+12 more within the horizon');
  });

  it('defaults to UPCOMING_CAP', () => {
    const { visible, hiddenCount } = capUpcoming(many(UPCOMING_CAP + 1));
    expect(visible).toHaveLength(UPCOMING_CAP);
    expect(hiddenCount).toBe(1);
  });
});

describe('deriveForecastTiles', () => {
  it('derives all three tiles from the Forecast object (income + expense mix)', () => {
    const [tin, tout, tnet] = deriveForecastTiles(forecast());
    expect(tin).toEqual({ label: 'Expected in', value: '$2,400.00', sub: '1 income series' });
    expect(tout).toEqual({ label: 'Expected out', value: '$955.49', sub: '2 expense series' });
    expect(tnet).toEqual({ label: 'Net', value: '+$1,444.51', sub: 'Next 30 days', tone: 'positive' });
  });

  it('signs and tones a negative net as a shortfall (caution)', () => {
    const [, , tnet] = deriveForecastTiles(
      forecast({ totalIn: 100, totalOut: 350.25, net: -250.25, horizonDays: 90 }),
    );
    expect(tnet.value).toBe('-$250.25');
    expect(tnet.tone).toBe('caution');
    expect(tnet.sub).toBe('Next 90 days');
  });

  it('treats a zero net as a surplus, not a shortfall', () => {
    const [, , tnet] = deriveForecastTiles(forecast({ totalIn: 100, totalOut: 100, net: 0 }));
    expect(tnet.value).toBe('+$0.00');
    expect(tnet.tone).toBe('positive');
  });
});

describe('netAxisTicks', () => {
  it('anchors an all-positive cumulative net at zero', () => {
    const ticks = netAxisTicks([point({ net: 120 }), point({ date: '2026-08-09', net: 480 })]);
    expect(ticks[0]).toBeLessThanOrEqual(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(480);
  });

  it('extends below zero when the projection dips negative', () => {
    const ticks = netAxisTicks([point({ net: -300 }), point({ date: '2026-08-09', net: 150 })]);
    expect(ticks[0]).toBeLessThanOrEqual(-300);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(150);
  });
});

describe('netTickGutterWidth', () => {
  it('clamps short currency ticks to the 52px floor', () => {
    // "$0" / "$1" — far under the floor's character budget.
    expect(netTickGutterWidth([0, 1])).toBe(52);
  });

  it('budgets from the longest formatted tick, not the largest value', () => {
    // -$19.5K (7 chars) formats longer than $20K (4 chars).
    const w = netTickGutterWidth([-19500, 20000]);
    expect(w).toBe(Math.min(100, Math.max(52, Math.ceil(7 * 7.5) + 20)));
    expect(w).toBeGreaterThan(netTickGutterWidth([0, 100]));
  });
});

describe('fmtDayLabel', () => {
  it('renders a short month + day without the year', () => {
    expect(fmtDayLabel('2026-09-05')).toBe('Sep 5');
    expect(fmtDayLabel('2026-12-31')).toBe('Dec 31');
  });

  it('returns malformed input unchanged', () => {
    expect(fmtDayLabel('not-a-date')).toBe('not-a-date');
  });
});

describe('composition: cap then group (the exact ForecastSection pipeline)', () => {
  it('a 90-day many-series list stays scannable: capped first, grouped second, remainder honest', () => {
    // 3 series x 20 dates = 60 occurrences, date-ascending like the contract.
    const occurrences: ForecastOccurrence[] = [];
    for (let day = 0; day < 20; day++) {
      const date = `2026-09-${String(day + 1).padStart(2, '0')}`;
      occurrences.push(
        occ({ key: 'payroll|weekly', merchant: 'Payroll', type: 'income', cadence: 'weekly', date }),
        occ({ key: 'rent|monthly', merchant: 'Rent', date }),
        occ({ key: 'gym|monthly', merchant: 'Gym', date, confidence: 'likely' }),
      );
    }
    const { visible, hiddenCount } = capUpcoming(occurrences);
    const groups = groupOccurrencesByDate(visible);

    expect(visible).toHaveLength(30);
    expect(hiddenCount).toBe(30);
    expect(hiddenCountLabel(hiddenCount)).toBe('+30 more within the horizon');
    // 30 visible / 3 per day = the 10 soonest date headings, ascending.
    expect(groups).toHaveLength(10);
    expect(groups[0].date).toBe('2026-09-01');
    expect(groups[9].date).toBe('2026-09-10');
    // Within-day order still matches the engine's emission order.
    expect(groups[0].occurrences.map((o) => o.merchant)).toEqual(['Payroll', 'Rent', 'Gym']);
  });
});

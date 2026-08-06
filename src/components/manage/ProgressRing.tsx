// Hand-rolled SVG progress ring for the Budgets "budget-health" summary
// (spec §12). A single ring doesn't warrant pulling recharts machinery in.
import type { ReactNode } from 'react';
import type { BudgetTone } from './budgetMath';

const TONE_STROKE: Record<BudgetTone, string> = {
  accent: 'var(--color-accent)',
  caution: 'var(--color-caution)',
  danger: 'var(--color-danger)',
};

export function ProgressRing({
  pct,
  tone,
  size = 96,
  strokeWidth = 10,
  children,
}: {
  pct: number;
  tone: BudgetTone;
  size?: number;
  strokeWidth?: number;
  children?: ReactNode;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-canvas)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={TONE_STROKE[tone]}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 300ms cubic-bezier(0.23, 1, 0.32, 1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

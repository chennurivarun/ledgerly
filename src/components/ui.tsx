// Shared UI kit — every page and modal builds from these primitives so the
// product stays visually consistent (spec §5). Touch targets: default control
// height is 44px (h-11); use size="sm" only in dense desktop table contexts.
import { X, type LucideIcon } from 'lucide-react';
import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-white hover:bg-accent-deep disabled:bg-accent/50 shadow-sm',
  ghost:
    'bg-surface text-ink border border-border hover:bg-canvas disabled:text-muted',
  subtle: 'bg-accent-soft text-accent hover:bg-accent-soft/70 disabled:opacity-60',
  danger: 'bg-danger text-white hover:bg-danger/90 disabled:bg-danger/50',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed ${
        size === 'md' ? 'h-11 px-4 text-sm' : 'h-9 px-3 text-sm'
      } ${BUTTON_STYLES[variant]} ${className}`}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Cards & layout
// ---------------------------------------------------------------------------

export function Card({
  title,
  action,
  children,
  className = '',
  padded = true,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={`rounded-card border border-border bg-surface shadow-[0_1px_3px_rgba(16,24,40,0.06)] ${
        padded ? 'p-5' : ''
      } ${className}`}
    >
      {(title || action) && (
        <header className={`flex items-center justify-between gap-3 ${padded ? 'mb-4' : 'p-5 pb-0 mb-4'}`}>
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  compact = false,
}: {
  icon?: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-6' : 'py-12'}`}>
      {Icon && (
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon className="size-6" aria-hidden />
        </div>
      )}
      <p className="text-sm font-semibold">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className = 'size-5' }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  );
}

export function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const CONTROL =
  'w-full h-11 rounded-xl border border-border bg-surface px-3 text-sm text-ink placeholder:text-muted focus:outline-2 focus:outline-accent disabled:bg-canvas disabled:text-muted';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input className={`${CONTROL} ${className}`} {...rest} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', children, ...rest } = props;
  return (
    <select className={`${CONTROL} appearance-none ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex w-full rounded-xl border border-border bg-canvas p-1"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`h-9 flex-1 rounded-lg text-sm font-medium transition-colors ${
            value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TagPill({
  label,
  onRemove,
  tone = 'accent',
}: {
  label: string;
  onRemove?: () => void;
  tone?: 'accent' | 'neutral';
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
        tone === 'accent' ? 'bg-accent-soft text-accent' : 'bg-canvas text-muted border border-border'
      }`}
    >
      {label}
      {onRemove && (
        // Padding + negative margin keeps the pill compact while growing the
        // tap target well past the 12px glyph (§1.13/§19 tappability).
        <button
          type="button"
          aria-label={`Remove tag ${label}`}
          onClick={onRemove}
          className="-my-2 -mr-1.5 flex items-center justify-center rounded-full p-2 hover:bg-accent/15"
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </span>
  );
}

export function ProgressBar({
  pct,
  tone = 'accent',
}: {
  pct: number; // 0..100+, clamped visually at 100
  tone?: 'accent' | 'positive' | 'caution' | 'danger' | 'info';
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const toneClass = {
    accent: 'bg-accent',
    positive: 'bg-positive',
    caution: 'bg-caution',
    danger: 'bg-danger',
    info: 'bg-info',
  }[tone];
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2 w-full overflow-hidden rounded-full bg-canvas"
    >
      <div className={`h-full rounded-full ${toneClass}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal — focus-trapped, Escape + visible close, ARIA labelled (spec §5)
// ---------------------------------------------------------------------------

let modalTitleSeq = 0;

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
  xl = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Wider still than `wide` — for content that genuinely needs desktop
   * width (e.g. a dense review table). Backward compatible: existing `wide`
   * callers are unaffected since this only takes effect when explicitly set. */
  xl?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useRef(`modal-title-${++modalTitleSeq}`);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () =>
      el
        ? Array.from(
            el.querySelectorAll<HTMLElement>(
              'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((f) => !f.hasAttribute('disabled'))
        : [];
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        const f = focusables();
        if (f.length === 0) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        className={`flex max-h-[92dvh] w-full flex-col rounded-t-2xl bg-surface shadow-xl sm:rounded-card ${
          xl ? 'sm:max-w-[min(96vw,1100px)]' : wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'
        }`}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 id={titleId.current} className="text-base font-semibold">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-canvas hover:text-ink"
          >
            <X className="size-5" aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-border px-5 py-4">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

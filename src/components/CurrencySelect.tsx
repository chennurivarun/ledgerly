// Shared currency picker — used by Settings and the onboarding wizard.
import { CURRENCIES } from '../../shared/currencies';
import { Select } from './ui';

export function CurrencySelect({
  value,
  onChange,
  disabled = false,
  ariaLabel = 'Display currency',
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <Select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {CURRENCIES.map((c) => (
        <option key={c.code} value={c.code}>
          {c.code} · {c.name}
        </option>
      ))}
    </Select>
  );
}

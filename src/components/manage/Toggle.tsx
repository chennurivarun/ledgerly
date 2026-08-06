// Accessible on/off switch — ui.tsx has no Toggle primitive, so pages that
// need one (Recurring/Subscriptions active state, Budget active state, Rule
// enabled state) share this. 44px tap target even though the visible pill is
// slim; press feedback follows the emil-design-eng guidance (fast ease-out,
// no bounce for a utilitarian control).
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex h-11 w-12 shrink-0 items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-150 ease-out ${
          checked ? 'bg-accent' : 'bg-border'
        }`}
      >
        <span
          className={`inline-block size-5 transform rounded-full bg-white shadow-sm transition-transform duration-150 ease-out ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </span>
    </button>
  );
}

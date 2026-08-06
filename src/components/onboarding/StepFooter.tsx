// Shared Back/Continue row used by every wizard step so the button layout
// stays identical across steps. `continueType="submit"` lets Enter in a
// step's single unambiguous field (e.g. the currency select, the net-worth
// amount fields) advance the step via the enclosing <form>; Back is always
// type="button" so it never intercepts that Enter.
import type { ReactNode } from 'react';
import { Button } from '../ui';

export function StepFooter({
  onBack,
  continueLabel = 'Continue',
  continueLoading = false,
  continueDisabled = false,
  continueType = 'submit',
  onContinueClick,
  secondary,
  disabled = false,
}: {
  onBack: () => void;
  continueLabel?: string;
  continueLoading?: boolean;
  continueDisabled?: boolean;
  continueType?: 'submit' | 'button';
  onContinueClick?: () => void;
  /** Extra button rendered before Continue, e.g. "Skip for now" on the net-worth step. */
  secondary?: ReactNode;
  /** External lock (e.g. "Skip setup" in flight elsewhere) — ORs with this step's own busy state. */
  disabled?: boolean;
}) {
  return (
    <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-5">
      <Button type="button" variant="ghost" onClick={onBack} disabled={continueLoading || disabled}>
        Back
      </Button>
      <div className="flex items-center gap-2">
        {secondary}
        <Button
          type={continueType}
          onClick={continueType === 'button' ? onContinueClick : undefined}
          loading={continueLoading}
          disabled={continueDisabled || disabled}
        >
          {continueLabel}
        </Button>
      </div>
    </div>
  );
}

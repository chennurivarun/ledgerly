// Recurring page (spec §10) — non-subscription recurring bills (mortgage,
// rent, utilities, etc.), driven by the shared detection engine.
import { Repeat } from 'lucide-react';
import { RecurringEngineView } from '../components/manage/RecurringEngineView';

export default function Recurring() {
  return (
    <RecurringEngineView
      kind="recurring"
      pageIcon={Repeat}
      itemLabel="Recurring payment"
      itemLabelPlural="recurring payments"
      addLabel="Add recurring payment"
      nextLabel="Next expected payment"
    />
  );
}

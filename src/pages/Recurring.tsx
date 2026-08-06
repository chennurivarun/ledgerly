// Recurring page (spec §10) — non-subscription recurring bills (mortgage,
// rent, utilities, etc.), driven by the shared detection engine, plus the
// deterministic cash-flow Forecast section (VISION phase-2 item 4) below it.
import { Repeat } from 'lucide-react';
import { ForecastSection } from '../components/forecast/ForecastSection';
import { RecurringEngineView } from '../components/manage/RecurringEngineView';

export default function Recurring() {
  return (
    <div className="space-y-6">
      <RecurringEngineView
        kind="recurring"
        pageIcon={Repeat}
        itemLabel="Recurring payment"
        itemLabelPlural="recurring payments"
        addLabel="Add recurring payment"
        nextLabel="Next expected payment"
      />
      <ForecastSection />
    </div>
  );
}

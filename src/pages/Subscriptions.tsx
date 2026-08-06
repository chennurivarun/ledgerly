// Subscriptions page (spec §11) — the same detection engine as Recurring,
// filtered to the 'subscription' lens (streaming, SaaS, memberships, etc.).
import { CreditCard } from 'lucide-react';
import { RecurringEngineView } from '../components/manage/RecurringEngineView';

export default function Subscriptions() {
  return (
    <RecurringEngineView
      kind="subscription"
      pageIcon={CreditCard}
      itemLabel="Subscription"
      itemLabelPlural="subscriptions"
      addLabel="Add subscription"
      nextLabel="Next renewal"
    />
  );
}

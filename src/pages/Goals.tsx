// Goals page (spec §13) — empty start with a prominent Create goal action.
import { Target } from 'lucide-react';
import { useState } from 'react';
import type { Goal } from '../../shared/types';
import { ConfirmDialog } from '../components/manage/ConfirmDialog';
import { GoalCard } from '../components/manage/GoalCard';
import { GoalFormModal } from '../components/manage/GoalFormModal';
import { useStore } from '../store';
import { Button, Card, EmptyState } from '../components/ui';

export default function Goals() {
  const settings = useStore((s) => s.settings);
  const updatePreferences = useStore((s) => s.updatePreferences);
  const toast = useStore((s) => s.toast);

  const [modal, setModal] = useState<'add' | Goal | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Goal | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const goals = settings.goals;

  async function handleSave(goal: Goal) {
    const exists = goals.some((g) => g.id === goal.id);
    const next = exists ? goals.map((g) => (g.id === goal.id ? goal : g)) : [...goals, goal];
    await updatePreferences({ goals: next });
    toast('success', exists ? 'Goal updated.' : 'Goal created.');
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await updatePreferences({ goals: goals.filter((g) => g.id !== pendingDelete.id) });
      toast('success', 'Goal deleted.');
      setPendingDelete(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Could not delete the goal.');
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <>
      <Card
        title={goals.length > 0 ? 'Your goals' : undefined}
        action={goals.length > 0 ? <Button onClick={() => setModal('add')}>Create goal</Button> : undefined}
      >
        {goals.length === 0 ? (
          <EmptyState
            icon={Target}
            title="No goals yet"
            body="Create a savings goal to track progress toward something specific."
            action={<Button onClick={() => setModal('add')}>Create goal</Button>}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {goals.map((g) => (
              <GoalCard key={g.id} goal={g} onEdit={() => setModal(g)} onDelete={() => setPendingDelete(g)} />
            ))}
          </div>
        )}
      </Card>

      {modal !== null && (
        <GoalFormModal initial={modal === 'add' ? undefined : modal} onClose={() => setModal(null)} onSave={handleSave} />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.name}"?`}
          message={<p>This removes the goal permanently. This can&apos;t be undone.</p>}
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            setPendingDelete(null);
            setDeleteError(null);
          }}
        />
      )}
    </>
  );
}

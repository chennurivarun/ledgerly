// Global top-bar modal content: Add entry (§7.3), Import (§8), Drive sync
// status (§5/§16.4). store.activeModal (set by Layout.tsx's top-bar buttons)
// drives which one is open; each modal closes itself via store.closeModal.
import { useStore } from '../store';
import { AddEntryModal } from './flows/AddEntryModal';
import { DriveSyncModal } from './flows/DriveSyncModal';
import { ImportModal } from './flows/ImportModal';

export function GlobalModals() {
  const activeModal = useStore((s) => s.activeModal);
  const closeModal = useStore((s) => s.closeModal);

  if (activeModal === 'add-entry') return <AddEntryModal onClose={closeModal} />;
  if (activeModal === 'import') return <ImportModal onClose={closeModal} />;
  if (activeModal === 'drive-sync') return <DriveSyncModal onClose={closeModal} />;
  return null;
}

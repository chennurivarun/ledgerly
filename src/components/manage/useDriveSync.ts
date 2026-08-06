// Shared fetch/loading/error wrapper around api.getDriveSync() — used by both
// Documents (§14) and Settings (§16.4) so neither duplicates the request
// lifecycle. Not store state: Drive sync status isn't part of AppStore.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { DriveSyncStatus } from '../../../shared/types';

export function useDriveSync() {
  const [status, setStatus] = useState<DriveSyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await api.getDriveSync();
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load Drive sync status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { status, loading, error, reload };
}

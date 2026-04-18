import { useState, useEffect, useCallback } from 'react';
import type { TraceSummary } from '../../shared/types';
import { getTraces } from '../api';

/**
 * Fetches the set of traces known to every trace provider and keeps the list
 * in sync with server-sent change events.
 */
export function useTraces() {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      const list = await getTraces();
      list.sort((a, b) => b.startTime - a.startTime);
      setTraces(list);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  return { traces, loading, error, refetch };
}

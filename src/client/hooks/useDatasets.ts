// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useEffect, useState } from "react";
import type { DatasetSummary } from "../../shared/types";
import { getDatasets } from "../api";

/**
 * Fetches every dataset across every dataset provider. The caller refetches
 * on `dataset-changed` server-sent events, as `useTraces` does for traces.
 */
export function useDatasets() {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      setDatasets(await getDatasets());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { datasets, loading, error, refetch };
}

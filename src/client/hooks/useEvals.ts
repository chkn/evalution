// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useEffect, useState } from "react";
import type { EvalSummary } from "../../eval/eval-types";
import { getEvals } from "../api";

/**
 * Fetches every eval across every eval provider. The caller refetches on
 * `eval-changed` server-sent events, as `useDatasets` does for datasets.
 */
export function useEvals() {
  const [evals, setEvals] = useState<EvalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      setEvals(await getEvals());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { evals, loading, error, refetch };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { SyncingDatabase } from "../shared/types";
import { datasetKey } from "./components/DatasetList";

/** Which of the sidebar's lists show a database being brought into sync. */
export interface SyncingLists {
  traces: boolean;
  evals: boolean;
  /** Datasets, by `datasetKey`. */
  datasets: ReadonlySet<string>;
}

/** Sorts what `GET /api/sync` says is being brought into sync by the list that shows it. */
export function syncingLists(
  adopting: readonly SyncingDatabase[],
): SyncingLists {
  return {
    traces: adopting.some(db => db.kind === "traces"),
    evals: adopting.some(db => db.kind === "evals"),
    datasets: new Set(
      adopting.flatMap(db =>
        db.kind === "dataset" && db.key
          ? [datasetKey({ providerId: db.provider, id: db.key })]
          : [],
      ),
    ),
  };
}

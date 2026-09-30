// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type { DatasetSummary } from "../../../shared/types";
import DatasetList, { datasetKey } from "../DatasetList";

/**
 * Mounts DatasetList against a fixed set of datasets, tracking the selection
 * and the sidebar width — like `TraceListHarness`, the wrapper only gets an
 * inline width given `initialSidebarWidth`; otherwise it fills the viewport.
 * A dataset selected that isn't listed yet (one just created) is added to
 * the list, as the app's `dataset-changed` refetch would.
 */
export function DatasetListHarness({
  datasets,
  initialSidebarWidth,
}: {
  datasets: DatasetSummary[];
  initialSidebarWidth?: number;
}) {
  const [list, setList] = useState(datasets);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth ?? 0);
  return (
    <div
      style={
        initialSidebarWidth !== undefined ? { width: sidebarWidth } : undefined
      }
    >
      <DatasetList
        datasets={list}
        loading={false}
        error={null}
        selectedKey={selectedKey}
        onSelect={d => {
          setSelectedKey(datasetKey(d));
          setList(l =>
            l.some(x => datasetKey(x) === datasetKey(d)) ? l : [...l, d],
          );
        }}
        promptName={p => (p.id === "support" ? "Support reply" : undefined)}
        sidebarWidth={sidebarWidth}
        onResizeSidebar={setSidebarWidth}
      />
    </div>
  );
}

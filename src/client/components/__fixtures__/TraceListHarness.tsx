// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { filterTraces, groupTraceSummaries } from "@evalution/sdk";
import { useEffect, useMemo, useState } from "react";
import type { TraceSummary } from "../../../shared/types";
import { type TraceSource, useTraces } from "../../hooks/useTraces";
import TraceList from "../TraceList";

/**
 * Mounts TraceList against a fixed set of traces, searched, filtered and
 * grouped in the page the way the server would, tracking the selection and
 * (given `initialSidebarWidth`) the sidebar width — an inline-width wrapper
 * that mirrors the `aside` `App.tsx` constrains TraceList's width with, which
 * is what its table-mode toggle resizes. Omitting `initialSidebarWidth`
 * leaves the wrapper unconstrained (fills the mount root, as before it
 * existed), for tests that size the table/card layout off the viewport
 * directly.
 */
export function TraceListHarness({
  traces,
  initialSidebarWidth,
}: {
  traces: TraceSummary[];
  initialSidebarWidth?: number;
}) {
  const source = useMemo<TraceSource>(
    () => ({
      list: async query => filterTraces(traces, query),
      groups: async query =>
        groupTraceSummaries(
          filterTraces(traces, query),
          query.groupBy,
          query.timeZone,
        ),
    }),
    [traces],
  );
  const listing = useTraces(source);
  const { refetch } = listing;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetches for a new source
  useEffect(() => {
    void refetch();
  }, [refetch, source]);
  const [selectedTraceKey, setSelectedTraceKey] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth ?? 0);
  return (
    <div
      style={
        initialSidebarWidth !== undefined ? { width: sidebarWidth } : undefined
      }
    >
      <TraceList
        listing={listing}
        selectedTraceKey={selectedTraceKey}
        onSelect={t => setSelectedTraceKey(`${t.providerId}:${t.id}`)}
        sidebarWidth={sidebarWidth}
        onResizeSidebar={setSidebarWidth}
      />
    </div>
  );
}

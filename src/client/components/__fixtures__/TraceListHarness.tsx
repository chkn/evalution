// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type { TraceSummary } from "../../../shared/types";
import TraceList from "../TraceList";

/** Mounts TraceList against a fixed set of traces, tracking the selection. */
export function TraceListHarness({ traces }: { traces: TraceSummary[] }) {
  const [selectedTraceKey, setSelectedTraceKey] = useState<string | null>(null);
  return (
    <TraceList
      traces={traces}
      loading={false}
      error={null}
      selectedTraceKey={selectedTraceKey}
      onSelect={t => setSelectedTraceKey(`${t.providerId}:${t.id}`)}
    />
  );
}

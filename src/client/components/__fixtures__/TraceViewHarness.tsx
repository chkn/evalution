// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import TraceView from "../TraceView";

/** Mounts TraceView against whatever `page.route` mocks the test installs. */
export function TraceViewHarness({
  providerId = "p1",
  traceId = "t1",
}: {
  providerId?: string;
  traceId?: string;
}) {
  return <TraceView providerId={providerId} traceId={traceId} />;
}

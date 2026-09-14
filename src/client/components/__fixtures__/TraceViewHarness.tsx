// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import TraceView from "../TraceView";

/**
 * Mounts TraceView against whatever `page.route` mocks the test installs.
 *
 * Wrapped in a fixed-height div: in the real app, `TraceView`'s `height:
 * 100%` resolves against the `.app` layout's `height: 100vh` root, which is
 * what lets its internal panes (the span list, the chat below it) scroll
 * independently rather than growing to fit their content. The CT harness
 * has no such ancestor, so without this `TraceView` would just render at its
 * content's natural height and none of that internal scrolling would happen.
 */
export function TraceViewHarness({
  providerId = "p1",
  traceId = "t1",
}: {
  providerId?: string;
  traceId?: string;
}) {
  return (
    <div style={{ height: "700px" }}>
      <TraceView providerId={providerId} traceId={traceId} />
    </div>
  );
}

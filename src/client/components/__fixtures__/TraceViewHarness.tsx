// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { NormalizedPrompt, PromptID } from "../../../shared/types";
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
 *
 * `promptName`, when given, makes every prompt reference resolve to a loaded
 * prompt of that name (`findPrompt` can't cross the CT boundary itself: a
 * callback prop comes back async).
 */
export function TraceViewHarness({
  providerId = "p1",
  traceId = "t1",
  onDeleted,
  onOpenPrompt,
  promptName,
}: {
  providerId?: string;
  traceId?: string;
  onDeleted?: () => void;
  onOpenPrompt?: (prompt: PromptID) => void;
  promptName?: string;
}) {
  return (
    <div style={{ height: "700px" }}>
      <TraceView
        providerId={providerId}
        traceId={traceId}
        onDeleted={onDeleted}
        onOpenPrompt={onOpenPrompt}
        findPrompt={
          promptName
            ? prompt =>
                ({
                  ...prompt,
                  name: promptName,
                  functionParameters: [],
                }) as unknown as NormalizedPrompt
            : undefined
        }
      />
    </div>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The trace surface: views shown as tabs beside the trace view's
 * Conversation and Spans. See `specs/trace-visualizers.md` §A.1.
 */

import { applyStreamEvent } from "../../shared/trace-stream.ts";
import type {
  TraceStreamEvent,
  TraceWithSpans,
} from "../../trace/trace-types.ts";
import type { Surface } from "../surface.ts";
import {
  defineView,
  type View,
  type ViewDefinition,
  type ViewProps,
} from "../view.ts";

/** The host state a trace view is told about but doesn't own. */
export interface TraceViewContext {
  /** The span selected in the host's details pane, if any. */
  selectedSpanId: string | null;
}

/** What a trace view is given, on mount and on every update. */
export interface TraceViewProps extends ViewProps {
  /** The trace so far. Updated as spans arrive while the run is live. */
  trace: TraceWithSpans;
  /** The span selected in the host's details pane, if any. */
  selectedSpanId: string | null;
  /** Asks the host to select a span, which opens it in the details pane. */
  selectSpan(spanId: string): void;
}

/** A view on the trace surface. */
export type TraceViewDefinition = ViewDefinition<
  TraceWithSpans,
  TraceViewProps
>;

/** The trace surface's descriptor. */
export const traceSurface: Surface<
  TraceWithSpans,
  TraceStreamEvent,
  TraceViewContext,
  TraceViewProps
> = {
  name: "traces",
  helper: "traceView",
  applyEvent: (subject, event) => applyStreamEvent(subject, event),
  isFinal: ({ trace }) =>
    trace.endTime !== undefined && trace.status !== "running",
  actions: {
    selectSpan: {
      effect: "ephemeral",
      check(args, { subject }) {
        const spanId = (args as { spanId?: unknown } | null)?.spanId;
        if (typeof spanId !== "string") return "selectSpan needs a span id";
        return subject.spans.some(s => s.id === spanId)
          ? undefined
          : `no span ${spanId} in this trace`;
      },
    },
  },
  props: ({ subject, context }, send, base) => ({
    ...base,
    trace: subject,
    selectedSpanId: context.selectedSpanId,
    selectSpan: spanId => send("selectSpan", { spanId }),
  }),
};

/**
 * Makes a trace view: a tab beside Conversation and Spans for every trace
 * `applies` says yes to. A file under `.evalution/views/traces/` default-
 * exports one.
 *
 * @example
 * ```tsx
 * export default traceView({
 *   label: "Tasks",
 *   applies: trace => taskChanges(trace).length > 0,
 *   mount: react(TaskTree),
 * });
 * ```
 */
export function traceView(
  definition: TraceViewDefinition,
): View<TraceWithSpans, TraceViewProps> {
  return defineView(traceSurface, definition);
}

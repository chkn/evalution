// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * **evalution/views** — custom views: trace views shown as tabs beside a
 * trace's Conversation and Spans, and dataset views beside a dataset's
 * Grid. Each file under `.evalution/views/<surface>/` default-exports one,
 * and runs in its own sandboxed frame. Framework-free: a view mounts into an
 * element however it likes (`evalution/views/react` adapts a React
 * component). See `specs/trace-visualizers.md` and `specs/dataset-views.md`.
 *
 * @module evalution/views
 */

export type {
  Dataset,
  DatasetRow,
  DatasetRowsOverview,
  DatasetRowUpdate,
} from "../dataset/dataset-types.ts";
export type {
  ExecutionInput,
  ResourceInstanceInput,
  RunResources,
} from "../shared/types.ts";
export type { Span, Trace, TraceWithSpans } from "../trace/trace-types.ts";
export {
  type FrameMessage,
  type HostMessage,
  PROTOCOL,
  type ViewTheme,
} from "./protocol.ts";
export { reportViewError, start } from "./runtime.ts";
export type {
  ActionEffect,
  SendAction,
  Surface,
  SurfaceAction,
  SurfaceState,
} from "./surface.ts";
export {
  type DatasetViewContext,
  type DatasetViewDefinition,
  type DatasetViewProps,
  type DatasetViewSubject,
  datasetView,
  type SelectedRow,
} from "./surfaces/datasets.ts";
export {
  type TraceViewContext,
  type TraceViewDefinition,
  type TraceViewProps,
  traceView,
} from "./surfaces/trace.ts";
export {
  isView,
  type MountedView,
  VIEW_TAG,
  type View,
  type ViewDefinition,
  type ViewProps,
} from "./view.ts";

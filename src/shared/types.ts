// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { TraceChangeEvent } from "@evalution/sdk";
import type {
  NormalizedPrompt,
  PromptRef,
  VariationConflict,
  VariationId,
  VariationInfo,
  VersionId,
} from "@evalution/sdk/adapter";
import type { DatasetChangeEvent } from "../dataset/dataset-types.ts";
import type { EvalChangeEvent, EvalRunProgress } from "../eval/eval-types.ts";
import type { PromptProvider } from "../prompt/prompt-provider.ts";

export type {
  Annotation,
  AnnotationChanges,
  AnnotationEvent,
  AnnotationEventOp,
  AnnotationKind,
  AnnotationSource,
  LLMSpanDetails,
  PromptID,
  Span,
  SpanContentPart,
  SpanImagePart,
  SpanKind,
  SpanMessage,
  SpanMessageRole,
  SpanReasoningPart,
  SpanTextPart,
  SpanToolCallPart,
  SpanToolResultPart,
  ToolSpanDetails,
  Trace,
  TraceChangeEvent,
  TraceChangeType,
  TraceEvalRun,
  TraceLiveEvent,
  TraceProviderInfo,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from "@evalution/sdk";
export type {
  ChatPromptUpdates,
  FieldValues,
  InputLayout,
  NormalizedChatPrompt,
  NormalizedMessage,
  NormalizedParameter,
  NormalizedPrompt,
  NormalizedPromptBase,
  NormalizedPromptUpdates,
  NormalizedQuestionsPrompt,
  NormalizedToolCall,
  ParsedPrompt,
  PendingConflicts,
  PromptInputSources,
  PromptRef,
  PromptStyle,
  QuestionsPromptUpdates,
  ResourceInfo,
  ResourceScope,
  VariationConflict,
  VariationId,
  VariationInfo,
  VersionId,
  VersionInfo,
} from "@evalution/sdk/adapter";
export type {
  Dataset,
  DatasetChangeEvent,
  DatasetChangeType,
  DatasetField,
  DatasetFieldShape,
  DatasetInstanceShape,
  DatasetPathChild,
  DatasetProviderInfo,
  DatasetRow,
  DatasetRowSource,
  DatasetRowsOverview,
  DatasetRowUpdate,
  DatasetSummary,
} from "../dataset/dataset-types.ts";

/** What rebasing or merging a variation produced. */
export type RebaseResult =
  | { ok: true; variation: VariationInfo }
  | {
      ok: false;
      conflicts: VariationConflict[];
      /** How to label each side of the conflicts in the UI. */
      labels?: { target: string; variation: string };
    };

/**
 * How to resolve each of a WIP's {@link PendingConflicts}, keyed by field:
 * keep the target's value, or the variation's.
 */
export type ConflictChoices = Record<string, "target" | "variation">;

/**
 * One prompt input, *before* resolution — the recipe rather than the value.
 *
 * The panel sends these instead of concrete JSON because a resource reference
 * cannot survive a JSON round trip: its value doesn't exist until the run
 * creates it. Every variant is JSON-safe by construction, which is also what
 * lets a trace record what it ran with and replay it (see `PromptSpanInfo`).
 */
export type ExecutionInput =
  /** A value typed into the panel. */
  | { kind: "value"; value: PropValue }
  /**
   * An object assembled from per-property inputs, so a resource can fill one
   * field of an otherwise hand-edited object — `toolsContext`'s `db` beside
   * its typed-in ids. Only objects nest: an array of resources isn't a case
   * any slot has yet.
   */
  | { kind: "object"; properties: Record<string, ExecutionInput> }
  /**
   * One of the run's named resource instances ({@link RunResources}), or one
   * of its outputs — created by the provider at run time, once per run
   * however many places name it. See `specs/resource-instances.md` §A.
   */
  | {
      kind: "instance";
      /** The instance's name in the run's {@link RunResources}. */
      name: string;
      /** A top-level output of its value (`taskId`). Absent for the value itself. */
      output?: string;
    }
  /**
   * A cell of the dataset row being run, by `DatasetField.id`. Only
   * meaningful in an eval run, where the row is implicit; anywhere else it
   * fails with a message that says so. The cell may itself hold a resource
   * or an object, and resolves recursively. See `specs/evals.md` §B.2.
   */
  | { kind: "dataset"; field: string }
  /**
   * Whatever the same run bound to one of the prompt's own slots, resolved
   * in the run's lease — so a resource comes back as the same instance, and
   * two slots can say they hold the same id rather than repeat one recipe.
   * Works anywhere a run is assembled: the execute panel and an eval alike.
   * See `specs/evals.md` §B.2.
   */
  | {
      kind: "input";
      /** Which half of the prompt's slots `path` is in. */
      half: "function" | "execute";
      /** The dotted slot path (`taskId`, `toolsContext.list_tasks.db`). */
      path: string;
    };

/**
 * One code-defined resource instance a run creates, whether or not any slot
 * reads it — the run's resources are the instances it declares, by name. See
 * `specs/resource-instances.md` §A.
 */
export interface ResourceInstanceInput {
  /** The resource's root {@link ResourceInfo.uri} — never an output's. */
  uri: string;
  /**
   * Values for the resource's declared arguments, by parameter name. Absent
   * when it takes none. Recursive — an argument may be a typed-in value, an
   * object, another instance's output, a dataset cell, or another slot.
   */
  args?: Record<string, ExecutionInput>;
  /**
   * What this instance's `create()` produced. Recorded on every run (never
   * sent by the panel); sent back only by a replay, so `create` can
   * reconstruct rather than re-mint. See `specs/resource-arguments.md` §E.
   */
  receipt?: unknown;
}

/**
 * A run's named resource instances, by name — `[A-Za-z_][A-Za-z0-9_-]*`.
 * Every one is created when the run starts, and {@link ExecutionInput}s of
 * kind `instance` refer to them by name.
 */
export type RunResources = Record<string, ResourceInstanceInput>;

/**
 * What the client knows about a check — a playground export made with
 * `check()`, or a built-in from `evalution/checks`. See `specs/evals.md`
 * §B.4.
 */
export interface CheckInfo {
  /** `<module>#<export>`, or `evalution/checks#<name>` for a built-in. */
  uri: string;
  /** Human-readable label. Defaults to the export name. */
  label: string;
  /** Display group, `/`-separated for nesting. Built-ins are `Built-in`. */
  group?: string;
  description?: string;
  /**
   * The schema-valued inputs, as the probe resolved them, in declaration
   * order. Resource inputs are bound in code and not listed.
   */
  parameters: PropDefinition[];
  /** Whether the check still runs when the prompt run itself errored. */
  runsOnError?: boolean;
  /** Set when the module failed to load or the definition is invalid. */
  error?: string;
}

/** The kind of change that occurred to a prompt. */
export type ChangeEventType = "change" | "add" | "remove";

/**
 * Describes a single change emitted by {@link PromptProvider.watch}.
 */
export interface PromptChangeEvent {
  /** Whether the prompt was added, modified, or removed. */
  type: ChangeEventType;
  /** The ID of the affected prompt ({@link ParsedPrompt.id}) */
  promptId: string;
  /**
   * Which state of the prompt changed, when it was a variation rather than the
   * source — a WIP edit, or a WIP rebased after an external edit.
   */
  ref?: PromptRef;
}

/** Describes a single form field rendered by the Add Prompt dialog. */
export interface AddPromptField {
  /** Key used to identify this field's value (e.g. `'name'`). */
  name: string;
  /** Human-readable label shown next to the input. */
  label: string;
  /** The kind of input control to render. */
  type: "text" | "select";
  /** Whether the field must be filled before submission. */
  required?: boolean;
  /** Pre-filled value. */
  defaultValue?: string;
  /** Placeholder text shown when the field is empty. */
  placeholder?: string;
  /** Available choices when `type` is `'select'`. */
  options?: { label: string; value: string }[];
}

/**
 * Returned by {@link PromptProvider.addPrompt} when additional user input is
 * needed before the prompt can be created.
 */
export interface AddPromptContext {
  /** The form fields the provider needs the user to fill in. */
  fields: AddPromptField[];
}

/** Information about a registered provider, returned by `GET /api/providers`. */
export interface PromptProviderInfo {
  id: string;
  displayName?: string;
  description?: string;
  icon?: string;
  hasAddPrompt: boolean;
  /** Whether the provider can name versions of its prompts. */
  hasVersions?: boolean;
  /** Whether the provider holds edits apart from the source (see `PromptProvider.variations`). */
  hasVariations?: boolean;
}

/**
 * Request body of `POST /api/prompts/:providerId/:id/execute`.
 *
 * Inputs arrive *unresolved*: the server resolves them (creating resources,
 * materializing values) immediately before calling
 * {@link PromptProvider.execute}. See {@link ExecutionInput}.
 */
export interface ExecuteRequest {
  /** Positional, one per {@link NormalizedPrompt.functionParameters} entry. */
  functionInputs?: ExecutionInput[];
  /** By name, keyed on {@link NormalizedPrompt.executeParameters} entries. */
  executeInputs?: Record<string, ExecutionInput>;
  /** The run's named resource instances. See {@link RunResources}. */
  resources?: RunResources;
}

/**
 * Response body of `POST /api/prompts/:providerId/:id/execute`.
 *
 * The endpoint returns immediately after the trace has been registered; the
 * real output is streamed as span events via
 * `GET /api/traces/:tracerProviderId/:traceId/events`.
 */
export interface ExecuteResponse {
  /** ID of the trace that tracks this execution. */
  traceId: string;
  /** ID of the trace provider that owns the trace. */
  tracerProviderId: string;
  /** Span ID of the root span for this execution. */
  rootSpanId: string;
  /** The version the run executed against, when the provider has versions. */
  version?: VersionId;
  /** The variation the run applied, if any. */
  variation?: VariationId;
}

/** Response body of `POST /api/prompts/:providerId/:id/update`. */
export interface UpdatePromptResponse {
  /** The prompt as the updates left it. */
  prompt: NormalizedPrompt;
  /** Where the updates landed — adopt it as the editor's ref. */
  ref: PromptRef;
}

// #endregion

export interface PromptChangedSSEData {
  type: "prompt-changed";
  providerId: string;
  event: PromptChangeEvent;
}

export interface TraceChangedSSEData {
  type: "trace-changed";
  providerId: string;
  event: TraceChangeEvent;
}

/** A dataset was added, changed, or removed — see `DatasetProvider.watch`. */
export interface DatasetChangedSSEData {
  type: "dataset-changed";
  providerId: string;
  event: DatasetChangeEvent;
}

/** An eval, or one of its runs, was added, changed, or removed — see `EvalProvider.watch`. */
export interface EvalChangedSSEData {
  type: "eval-changed";
  providerId: string;
  event: EvalChangeEvent;
}

/** A running eval made progress, or finished. See `specs/evals.md` §D.4. */
export interface EvalRunSSEData extends EvalRunProgress {
  type: "eval-run";
}

/**
 * A project's views changed: one was added, removed, or rebuilt. See
 * `specs/trace-visualizers.md` §B.2.
 */
export interface ViewsChangedSSEData {
  type: "views-changed";
  /** The new {@link ViewList.version}. */
  version: number;
}

export type SSEData =
  | PromptChangedSSEData
  | TraceChangedSSEData
  | DatasetChangedSSEData
  | EvalChangedSSEData
  | EvalRunSSEData
  | ViewsChangedSSEData;

// #region Views

/**
 * One view a project has: a file under `.evalution/views/<surface>/` that
 * built. See `specs/trace-visualizers.md` §B.
 */
export interface ViewInfo {
  /** The file's path relative to the project root. */
  uri: string;
  /** The surface it's for: the directory it's in. */
  surface: string;
  /** Changes whenever its bundle does, so a frame knows to reload. */
  moduleVersion: string;
}

/** A view file that can't be shown: it failed to build, or is in the wrong place. */
export interface ViewModuleError {
  /** The file's path relative to the project root. */
  uri: string;
  /** The surface its directory names, if it names one. */
  surface?: string;
  message: string;
}

/** Response body of `GET /api/views`. */
export interface ViewList {
  /** Bumped on every change to the list. */
  version: number;
  views: ViewInfo[];
  errors: ViewModuleError[];
}

// #endregion

// #region Model

import type {
  CalleeBinding,
  ExtractedProps,
  ImportSpecifier,
  PropDefinition,
  PropType,
  PropValue,
  SourceSpan,
  TemplateToken,
  TemplateValue,
  ValueCatalog,
  ValueCatalogGroup,
  ValueCatalogPreset,
  ValueFactory,
} from "ts-proppy";

export type {
  CalleeBinding,
  ExtractedProps,
  ImportSpecifier,
  PropDefinition,
  PropType,
  PropValue,
  SourceSpan,
  TemplateToken,
  TemplateValue,
  ValueCatalog,
  ValueCatalogGroup,
  ValueCatalogPreset,
  ValueFactory,
};

// #endregion

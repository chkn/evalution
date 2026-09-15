// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PromptProvider } from "../prompt/prompt-provider.ts";
import type { SDKAdapter } from "../sdk/sdk-adapter.ts";

import type { TraceChangeEvent } from "../trace/trace-types.ts";

export type {
  Annotation,
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
  SpanTextPart,
  ToolSpanDetails,
  Trace,
  TraceChangeEvent,
  TraceChangeType,
  TraceLiveEvent,
  TraceProviderInfo,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from "../trace/trace-types.ts";

// #region Prompt

/**
 * Low-level prompt representation produced by a
 * {@link PromptFileType}. It exposes the raw `extractedProps` from the parser
 * and uses SDK-specific property names (e.g. `model`, `system`, `messages`).
 *
 * Not intended for public consumption — {@link PromptProvider} implementations
 * convert this into a {@link NormalizedPrompt} via an {@link SDKAdapter} before
 * returning it to callers.
 */
export interface ParsedPrompt {
  id: string;
  providerId?: string;
  /**
   * Author-supplied stable alias for this prompt, globally unique across
   * providers. Survives file moves/renames and is registered in the prompt
   * registry so runtime traces can resolve back to this prompt.
   */
  globalId?: string;
  name: string;
  functionParameters: PropDefinition[];
  extractedProps: ExtractedProps;
  metadata?: unknown;
  treePath?: string[];
}

/**
 * A single message in a conversation, in a form that is independent of any
 * particular SDK's message shape.
 */
export interface NormalizedMessage {
  /** Role identifier (`'system'`, `'user'`, `'assistant'`, `'tool'`, …). */
  role: string;
  /** Message content. Typically a primitive or template string, but any
   * {@link PropValue} is allowed so non-string content (e.g. structured
   * content arrays) can round-trip through the editor. */
  content: PropValue;
  /** Optional tool calls attached to an assistant message. */
  toolCalls?: NormalizedToolCall[];
}

/** A tool invocation emitted by an assistant message. */
export interface NormalizedToolCall {
  /** The name of the tool / function to invoke. */
  toolName: string;
  /** Arguments to the tool, as a JSON string. */
  args: string;
}

/**
 * A model parameter (`temperature`, `maxTokens`, …) attached to a prompt.
 * Mirrors the `PropDefinition` + current value pair that the playground UI
 * needs for rendering a parameter editor.
 */
export interface NormalizedParameter {
  /** Describes the parameter's name, type, and documentation. */
  def: PropDefinition;
  /** The parameter's current value, or `undefined` if not set on the prompt. */
  value?: PropValue;
  /** Whether the current value can be edited from the UI. */
  editable: boolean;
}

/**
 * Prompt representation used by {@link PromptProvider} public methods and by
 * the playground UI. It hides SDK-specific property names behind a stable
 * shape — `model`, `system`, `messages`, and the rest as `parameters`.
 *
 * {@link SDKAdapter.normalizePrompt} converts a {@link ParsedPrompt} produced
 * by a {@link PromptFileType} into this form.
 */
export interface NormalizedPrompt {
  id: string;
  providerId?: string;
  /**
   * Author-supplied stable alias for this prompt, globally unique across
   * providers. Survives file moves/renames and is registered in the prompt
   * registry so runtime traces can resolve back to this prompt.
   */
  globalId?: string;
  name: string;
  functionParameters: PropDefinition[];
  metadata?: unknown;

  /**
   * Controls where this prompt appears in the sidebar tree.
   *
   * Each element is a path segment. The last segment is treated as the leaf
   * group label (analogous to a file name) and all preceding segments are
   * rendered as collapsible directory nodes.
   *
   * Prompts that share the same `treePath` are grouped under the same leaf
   * node. When omitted, the prompt is placed at the root level.
   *
   * @example ['src', 'prompts', 'greeting.prompt.ts']
   */
  treePath?: string[];

  /** The model reference (e.g. a provider call or gateway string). */
  model?: PropValue;
  /** Whether {@link model} can be edited in the UI. */
  modelEditable: boolean;

  /** Top-level system prompt, if the SDK supports one. */
  system?: PropValue;
  /** Whether {@link system} can be edited in the UI. */
  systemEditable: boolean;

  /** Conversation messages. */
  messages: NormalizedMessage[];
  /** Whether {@link messages} can be edited in the UI. */
  messagesEditable: boolean;

  /**
   * Model parameters currently set on the prompt (everything other than
   * `model`, `system`, and `messages`).
   */
  modelParameters: NormalizedParameter[];

  /**
   * Named values the SDK needs to **execute** the config this prompt renders,
   * supplied at run time rather than authored in the file.
   *
   * Distinct from {@link functionParameters}, which answers *what does this
   * prompt take?* — this answers *what does running it require?*, which the
   * function signature cannot express. The Vercel AI SDK's `toolsContext` is
   * the motivating case: tools that declare a `contextSchema` need a context
   * object the prompt function never sees.
   *
   * Absent when the prompt needs nothing beyond its arguments. Present with an
   * unresolved type when the requirement is known but its shape is not — a
   * usable state, and better than the silent failure at the first tool call
   * that omitting it would produce.
   */
  executeParameters?: PropDefinition[];

  /**
   * Non-authored sources that can fill this prompt's input slots — currently
   * code-defined resources. Absent when the provider offers none.
   */
  inputSources?: PromptInputSources;

  /**
   * Slot path → how to lay out a fan-out slot's fields in the execute panel.
   * Any path not named here uses `"expanded"`.
   *
   * Set by an {@link SDKAdapter} whose own API shape is the reason a slot
   * fans out — e.g. the Vercel AI SDK's `toolsContext`, which is keyed per
   * tool because tools are resolved individually, not because prompt authors
   * think in terms of separate contexts. Mirrors the `functionSlots` /
   * `executeSlots` split on {@link PromptInputSources}, which exists for the
   * same reason: a function parameter and an execute parameter may share a
   * name.
   */
  inputLayout?: {
    functionSlots?: Record<string, InputLayout>;
    executeSlots?: Record<string, InputLayout>;
  };
}

/** How a fan-out slot's fields are laid out in the execute panel. */
export type InputLayout = "combined" | "expanded";

/** How long a resource's value lives, and how often `create()` runs. */
export type ResourceScope = "run" | "server";

/**
 * A code-defined resource offered as an input source, as the UI sees it.
 *
 * The resource's *value* never crosses the wire — the whole point is that only
 * running code can produce it — so this is just enough to render a chip and
 * send the choice back as an {@link ExecutionInput}.
 */
export interface ResourceInfo {
  /**
   * Provider-interpreted reference to this resource, relative to the
   * provider's root so it stays valid on another machine (e.g.
   * `.evalution/playground/db.ts#db`).
   */
  uri: string;
  /** Human-readable label shown on the chip. */
  label: string;
  /** How long the created value lives. See {@link ResourceScope}. */
  scope: ResourceScope;
  /**
   * Why this resource is unavailable, if it is — typically its module threw
   * at import time. Surfaced in the panel rather than hidden, so a broken
   * playground module is visible instead of silently absent.
   */
  error?: string;
  /**
   * A snapshot of the resource's current value, so the panel can preview it
   * instead of just naming it. Present only when the server already has an
   * instance to peek at — a static `value` resource, or a `scope: 'server'`
   * one it has already created — and that instance's value is plain JSON
   * data. A run-scoped resource, or one whose value isn't plain data (a live
   * handle), has nothing here; the chip is all there is to show.
   */
  value?: unknown;
  /**
   * Group path this source is displayed under, outermost first. Absent means
   * top level. Purely display metadata — never part of {@link uri} — so
   * renaming a group invalidates no saved selection. See
   * `specs/resource-hierarchy.md` §B.
   */
  group?: string[];
  /**
   * For a value source (one read off another resource): the `uri` of the
   * resource it is read from. Absent for the resource itself.
   */
  parent?: string;
  /**
   * For a value source: how many values that resource exposes in total,
   * before slot matching narrows them down for a particular slot. Only the
   * provider can supply this — after filtering, the panel cannot tell "this
   * resource exposes one value" from "it exposes five and four don't fit
   * here", and those read differently once a submenu collapses to its one
   * remaining entry.
   */
  siblings?: number;
  /**
   * The resource's declared arguments, as slots for the panel to render —
   * one per schema-valued entry of its `inputs`, in declaration order.
   * Absent when the resource takes none. Present with an unresolved (generic
   * string) editor when the requirement is known but its shape is not —
   * the checker-less degradation, same idiom as
   * {@link NormalizedPrompt.executeParameters}.
   *
   * Only the resource itself carries this — a value source (`parent` set)
   * shares its root resource's arguments rather than repeating them. See
   * `specs/resource-arguments.md` §G.
   */
  parameters?: PropDefinition[];
}

/**
 * Which non-authored sources can fill which of a prompt's input slots.
 *
 * Matching runs provider-side, where the checker lives (see
 * `matchResourcesToSlots`), and ships as slot paths so the panel can offer a
 * source without re-deriving the rules.
 */
export interface PromptInputSources {
  /** Every resource in scope for this prompt, identified by `uri`. */
  resources: ResourceInfo[];
  /**
   * Dotted slot path within {@link NormalizedPrompt.functionParameters}
   * (`taskId`, `ctx.db`) → URIs of the resources that can fill it.
   */
  functionSlots: Record<string, string[]>;
  /**
   * Dotted slot path within {@link NormalizedPrompt.executeParameters}
   * (`toolsContext.list_tasks.db`) → URIs of the resources that can fill it.
   */
  executeSlots: Record<string, string[]>;
  /**
   * Resource URI → (argument slot path → URIs of sources that can fill it).
   *
   * Separate from {@link functionSlots} / {@link executeSlots} and keyed by
   * URI rather than folded into the slot path, because an argument slot is a
   * property of the *resource*, not of the prompt: the same resource offers
   * the same arguments in every prompt that can see it. Absent when no
   * resource in scope declares arguments. See
   * `specs/resource-arguments.md` §G.
   */
  resourceSlots?: Record<string, Record<string, string[]>>;
}

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
  /** A code-defined resource, created by the provider at run time. */
  | {
      kind: "resource";
      /** The resource's {@link ResourceInfo.uri}. */
      uri: string;
      /**
       * Values for the resource's declared arguments, by parameter name.
       * Absent when the resource takes none. Recursive — an argument may
       * itself be a typed-in value, an object, another resource, or (later)
       * a dataset cell — because those are exactly the variants this union
       * already has. Never folded into `uri`: identity and binding change on
       * different schedules. See `specs/resource-arguments.md` §C.
       */
      args?: Record<string, ExecutionInput>;
      /**
       * What this resource's `create()` produced. Recorded on every run
       * (never sent by the panel); sent back only by a replay, so `create`
       * can reconstruct rather than re-mint. See
       * `specs/resource-arguments.md` §E.
       */
      receipt?: unknown;
    }
  /** A cell from a dataset row. Declared, not yet implemented. */
  | { kind: "dataset"; uri: string };

/**
 * Updates that can be applied to a {@link NormalizedPrompt} via
 * {@link PromptProvider.updatePromptProperties}. A value of `null` removes
 * that field from the underlying source.
 */
export interface NormalizedPromptUpdates {
  model?: ModelPropValue | null;
  system?: PropValue | null;
  messages?: NormalizedMessage[] | null;
  /** Per-parameter updates, keyed by parameter name. `null` removes. */
  modelParameters?: Record<string, PropValue | null>;
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

export type SSEData = PromptChangedSSEData | TraceChangedSSEData;

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
};

/**
 * Catalog-only variant of {@link PropValue} where `functionCall.binding` may
 * carry multiple candidate bindings (e.g. a parameter-destructure form *and* a
 * top-level-import form). The {@link PromptFileType} resolves these candidates
 * against the target file's structure at edit time.
 *
 * Plain {@link PropValue} is assignable to `ModelPropValue` (single binding ⊆ array).
 */
export type ModelPropValue =
  | Exclude<PropValue, { kind: "functionCall" | "object" | "array" | "tuple" }>
  | (Omit<Extract<PropValue, { kind: "functionCall" }>, "binding" | "args"> & {
      binding?: CalleeBinding | CalleeBinding[];
      args: ModelPropValue[];
    })
  | (Omit<Extract<PropValue, { kind: "object" }>, "properties"> & {
      properties: Record<string, ModelPropValue>;
    })
  | (Omit<Extract<PropValue, { kind: "array" | "tuple" }>, "elements"> & {
      elements: ModelPropValue[];
    });

/** A pre-defined model option shown in quick-select UIs. */
export interface ModelInfo {
  /** Model ID (e.g. `'gpt-4o'`). */
  id: string;
  /** Human-readable label shown in the UI (e.g. `'GPT-4o (OpenAI)'`). */
  label: string;
  /** Optional category for grouping related models together in the UI (usually provider name). */
  group?: string;
  /**
   * Values to use when selecting this model in different modes (as defined by {@link ModelCatalog.modelValueTypes}).
   * If a value is undefined for a particular mode, this model is not offered as a quick-select option in that mode.
   */
  values: Record<string, ModelPropValue | undefined>;
}

/** Describes a model selection mode exposed by the SDK adapter (e.g. "Provider" or "Gateway"). */
export interface ModelValueType {
  /** Label shown in the UI toggle (e.g. "Provider", "Gateway"). */
  readonly label: string;
  /** Optional tooltip / helper text. */
  readonly description?: string;
}

/**
 * Per-group metadata for constructing custom model values in the UI.
 *
 * `customValueTemplates` is a `PropValue` template per mode. Any primitive
 * string value containing `$input` is replaced with the user's custom model
 * ID at runtime.
 */
export interface ModelGroupInfo {
  customValueTemplates?: Record<string, ModelPropValue>;
}

/**
 * Model catalog returned by {@link SDKAdapter.getModelCatalog}.
 * Contains the set of known providers and a curated list of models.
 */
export interface ModelCatalog {
  /** List of known models. */
  models: readonly ModelInfo[];

  /**
   * Available model selection modes.
   *
   * When this is an object, the UI renders a toggle so the user can switch between them.
   * The keys of this object are used in {@link ModelInfo.values}, and the values provide
   * metadata for how to render each mode in the UI.
   */
  modelValueTypes?: Record<string, ModelValueType>;

  /** Per-group metadata for constructing custom model PropValues. Keyed by group name. */
  groups?: Record<string, ModelGroupInfo>;
}

// #endregion

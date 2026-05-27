import type { SDKAdapter } from '../sdk/sdk-adapter.ts';
import type { PromptProvider } from '../prompt/prompt-provider.ts';
import type { otelOperationToSpanKind } from './helpers.ts';

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
  /** Message content, as a plain string. Template syntax (`${…}`) is allowed. */
  content: string;
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
}

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
export type ChangeEventType = 'change' | 'add' | 'remove';

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
  type: 'text' | 'select';
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

export interface ExecuteRequest {
  stream?: boolean;
  functionParams?: any[];
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

// #region Trace

/**
 * Classification of a {@link Span}. See also:
 * - `lmnr.span.type` from https://laminar.sh/docs/tracing/otel
 * - `mlflow.spanType` from https://mlflow.org/docs/latest/genai/tracing/opentelemetry/attribute-mapping/#translated-span-attributes
 * 
 * Mapped from `gen_ai.operation.name` via the {@link otelOperationToSpanKind} function.
 */
export type SpanKind =
  | 'LLM'
  | 'TOOL'
  | 'AGENT'
  | 'EMBEDDING'
  | 'DEFAULT';

/** A single message within an LLM span's input/output. */
export interface SpanMessage {
  role: string;
  content: string;
}

/** LLM-specific attributes attached to `LLM` spans. */
export interface LLMSpanDetails {
  provider?: string;
  model?: string;
  messages?: SpanMessage[];
  output?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Dollar cost of the call, if known. */
  cost?: number;
  /** Model parameters (temperature, max_tokens, …). */
  parameters?: Record<string, unknown>;
}

/**
 * A span in a {@link Trace}. Spans form a tree via {@link parentId}.
 * Durations are derived from `startTime` and `endTime`; an in-progress span has
 * no `endTime` yet.
 */
export interface Span {
  id: string;
  traceId: string;
  /** `undefined` for the root span of the trace. */
  parentId?: string;
  name: string;
  kind: SpanKind;
  /** Start timestamp in milliseconds since epoch. */
  startTime: number;
  /** End timestamp in milliseconds since epoch, or `undefined` while running. */
  endTime?: number;
  status?: 'ok' | 'error';
  /** Error message if `status` is `'error'`. */
  errorMessage?: string;
  /** Free-form attributes to show in the span's details pane. */
  attributes?: Record<string, unknown>;
  /** LLM-specific details (present for `chat`/`completion`/`embedding` spans). */
  llm?: LLMSpanDetails;
  /** Evalution prompt provider ID (`evalution.prompt.provider.id`). */
  promptProviderId?: string;
  /** Evalution prompt ID (`evalution.prompt.id`). */
  promptId?: string;
}

/**
 * Top-level trace for a single invocation (e.g. one prompt execution).
 */
export interface Trace {
  id: string;
  providerId?: string;
  name: string;
  /** Start timestamp (ms). */
  startTime: number;
  /** End timestamp (ms), or `undefined` while the trace is still running. */
  endTime?: number;
  status: 'running' | 'ok' | 'error';
  /** Free-form attributes (e.g. prompt ID, function params). */
  attributes?: Record<string, unknown>;
}

/** Compact trace entry for listings (sidebar / `GET /api/traces`). */
export interface TraceSummary {
  id: string;
  providerId: string;
  name: string;
  startTime: number;
  endTime?: number;
  status: 'running' | 'ok' | 'error';
  /** Number of spans currently associated with the trace. */
  spanCount: number;
}

/** A trace together with all of its spans. */
export interface TraceWithSpans {
  trace: Trace;
  spans: Span[];
}

/** The kind of change that occurred to a trace. */
export type TraceChangeType = 'add' | 'update' | 'remove';

/** Describes a single change emitted by `TraceProvider.watch`. */
export interface TraceChangeEvent {
  type: TraceChangeType;
  traceId: string;
}

/** Real-time event pushed over the per-trace SSE subscription. */
export type TraceStreamEvent =
  | { type: 'span-start'; span: Span }
  | { type: 'span-end'; span: Span }
  | { type: 'span-update'; span: Span }
  | { type: 'trace-update'; trace: Trace }
  | { type: 'trace-end'; trace: Trace };

/** Information about a registered trace provider, returned by `GET /api/trace-providers`. */
export interface TraceProviderInfo {
  id: string;
  displayName?: string;
  description?: string;
}

// #endregion

export interface PromptChangedSSEData {
  type: 'prompt-changed';
  providerId: string;
  event: PromptChangeEvent;
}

export interface TraceChangedSSEData {
  type: 'trace-changed';
  providerId: string;
  event: TraceChangeEvent;
}

export type SSEData = PromptChangedSSEData | TraceChangedSSEData;

// #region Model

import type { PropValue, PropDefinition, ImportSpecifier, ExtractedProps, SourceSpan, CalleeBinding } from 'ts-proppy';
export type { PropDefinition, PropValue, ImportSpecifier, ExtractedProps, SourceSpan, CalleeBinding };

/**
 * Catalog-only variant of {@link PropValue} where `functionCall.binding` may
 * carry multiple candidate bindings (e.g. a parameter-destructure form *and* a
 * top-level-import form). The {@link PromptFileType} resolves these candidates
 * against the target file's structure at edit time.
 *
 * Plain {@link PropValue} is assignable to `ModelPropValue` (single binding ⊆ array).
 */
export type ModelPropValue =
  | Exclude<PropValue, { kind: 'functionCall' | 'object' | 'array' | 'tuple' }>
  | (Omit<Extract<PropValue, { kind: 'functionCall' }>, 'binding' | 'args'> & {
      binding?: CalleeBinding | CalleeBinding[];
      args: ModelPropValue[];
    })
  | (Omit<Extract<PropValue, { kind: 'object' }>, 'properties'> & { properties: Record<string, ModelPropValue> })
  | (Omit<Extract<PropValue, { kind: 'array' | 'tuple' }>, 'elements'> & { elements: ModelPropValue[] });

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
};

// #endregion




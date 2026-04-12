// #region Prompt

export interface FunctionParameter {
  name: string;
  type?: string;
  defaultValue?: any;
}

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
  functionParameters: FunctionParameter[];
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
  functionParameters: FunctionParameter[];
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
  parameters: NormalizedParameter[];
}

/**
 * Updates that can be applied to a {@link NormalizedPrompt} via
 * {@link PromptProvider.updatePromptProperties}. A value of `null` removes
 * that field from the underlying source.
 */
export interface NormalizedPromptUpdates {
  model?: PropValue | null;
  system?: PropValue | null;
  messages?: NormalizedMessage[] | null;
  /** Per-parameter updates, keyed by parameter name. `null` removes. */
  parameters?: Record<string, PropValue | null>;
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

// #endregion

export interface PromptChangedSSEData {
  type: 'prompt-changed';
  providerId: string;
  event: PromptChangeEvent;
}

export type SSEData = PromptChangedSSEData;

// #region Model

import type { PropValue, PropDefinition, ImportSpecifier, ExtractedProps, SourceSpan } from 'ts-proppy';
export type { PropDefinition, PropValue, ImportSpecifier, ExtractedProps, SourceSpan };

/** A pre-defined model option shown in quick-select UIs. */
export interface ModelInfo {
  /** Model ID (e.g. `'gpt-4o'`). */
  id: string;
  /** Human-readable label shown in the UI (e.g. `'GPT-4o (OpenAI)'`). */
  label: string;
  /** Optional category for grouping related models together in the UI (usually provider name). */
  group?: string;
  /** Values to use when selecting this model in different modes (as defined by {@link ModelCatalog.modelValueTypes}) */
  values: Record<string, PropValue>;
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
  customValueTemplates?: Record<string, PropValue>;
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




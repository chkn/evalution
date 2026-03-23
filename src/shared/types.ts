// #region Prompt

export interface SourceSpan {
  start: number;
  end: number;
}

export interface FunctionParameter {
  name: string;
  type?: string;
  defaultValue?: any;
}

export interface PromptProperty<Value = unknown> {
  name: string;
  value: Value;
  isEditable: boolean;
  sourceText?: string;
  valueSpan?: SourceSpan;
  fullSpan?: SourceSpan; // full "key: value," including leading whitespace and trailing comma
  /** The prompt this property belongs to (e.g. `"prompts/greet.prompt.ts#greet"`). Used to re-parse for fresh spans. */
  promptId?: string;
}

export interface ParsedPrompt {
  id: string;
  providerId?: string;
  name: string;
  functionParameters: FunctionParameter[];
  properties: Record<string, PromptProperty>;
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

import type { PropValue, PropDefinition, ImportSpecifier } from 'ts-proppy';
export type { PropDefinition, PropValue, ImportSpecifier };

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




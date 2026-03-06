export interface SourceSpan {
  start: number;
  end: number;
}

export interface FunctionParameter {
  name: string;
  type?: string;
  defaultValue?: any;
}

export interface PromptProperty {
  name: string;
  value: any;
  isEditable: boolean;
  hasParameterTokens: boolean;
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

export interface ModelValue {
  type: 'string' | 'function';
  provider?: string;
  model: string;
  hasParameterTokens?: boolean;
}

export interface ModelParameterInfo {
  name: string;
  type: string;
  defaultValue: any;
  description: string;
}

export interface ExecuteRequest {
  stream?: boolean;
  functionParams?: any[];
}

// ── Add Prompt flow ─────────────────────────────────────────────────────────

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
export interface ProviderInfo {
  id: string;
  displayName?: string;
  description?: string;
  icon?: string;
  hasAddPrompt: boolean;
}
